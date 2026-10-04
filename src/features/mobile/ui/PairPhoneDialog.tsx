import QRCode from "qrcode";
import { useEffect, useMemo, useRef, useState } from "react";
import { copyText } from "../../../platform/tauri/clipboard";
import { Modal } from "../../../shared/ui/Modal";
import { Loader } from "../../../shared/ui/icons";
import type { RemoteMachine } from "../../connections/model/protocol";
import {
  cancelPairing,
  createPairing,
  decidePairing,
  formatCode,
  formatCountdown,
  hostConfig,
  hostMessage,
  pairingStatus,
  pairOptionsSeen,
  reachableThrough,
  RELAY_CONSENT,
  relayOperator,
  rememberPairOptions,
  setHostConfig,
  type HostConfigView,
  type PairingOffer,
  type PairingStatus,
} from "../model/mobile";

/** The dialog renews a code that expires while it is open this many times,
 * then asks. */
export const AUTO_RENEWALS = 3;
const POLL_MS = 1_000;
/** Status checks that may fail in a row (the machine reconnecting). */
const MAX_POLL_FAILURES = 5;

type Ended = "denied" | "expired" | "requestExpired" | "cancelled";

type Phase =
  | { kind: "loading" }
  | { kind: "options"; config: HostConfigView }
  | { kind: "creating" }
  | { kind: "offer"; offer: PairingOffer; status: PairingStatus }
  | { kind: "approved"; name: string }
  | { kind: "ended"; reason: Ended }
  | { kind: "error"; message: string };

const secondary =
  "rounded-md px-3 py-1.5 text-[12px] text-content/70 hover:bg-content/8 hover:text-content disabled:opacity-40";
const primary =
  "inline-flex items-center gap-1.5 rounded-md bg-content px-3 py-1.5 text-[12px] font-medium text-background-base hover:bg-content/80 disabled:opacity-40";

const ENDED: Record<Ended, string> = {
  denied: "Denied. The phone was not paired.",
  expired: "Code expired",
  requestExpired: "Request expired",
  cancelled: "Code cancelled after failed attempts",
};

/** Pairs a phone with one machine: QR code and link, then the confirmation
 * code the phone shows (spec 10 §10.4). */
export function PairPhoneDialog({
  machine,
  machineName,
  onClose,
  onPaired,
}: {
  machine: RemoteMachine;
  /** "this computer", or the machine's name. */
  machineName: string;
  onClose: () => void;
  onPaired?: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const renewals = useRef(0);
  const offerRef = useRef<PairingStatus | undefined>(undefined);
  // Each mount and each new code; a late answer for an older one is cancelled.
  const generation = useRef(0);
  const onPairedRef = useRef(onPaired);
  onPairedRef.current = onPaired;

  const create = async () => {
    const mine = ++generation.current;
    setPhase({ kind: "creating" });
    setError("");
    try {
      const offer = await createPairing(machine.id);
      if (mine !== generation.current) {
        void cancelPairing(machine.id, offer.offerId).catch(() => {});
        return;
      }
      const status: PairingStatus = {
        offerId: offer.offerId,
        status: "open",
        expiresAt: offer.expiresAt,
      };
      offerRef.current = status;
      setPhase({ kind: "offer", offer, status });
    } catch (reason) {
      if (mine === generation.current)
        setPhase({ kind: "error", message: hostMessage(reason) });
    }
  };

  useEffect(() => {
    const mine = ++generation.current;
    if (pairOptionsSeen(machine.environmentId)) void create();
    else
      void hostConfig(machine.id)
        .then((config) => {
          if (mine === generation.current)
            setPhase({ kind: "options", config });
        })
        .catch(() => {
          // Older hosts have no settings to choose; pair with what they have.
          if (mine === generation.current) void create();
        });
    return () => {
      generation.current++;
      const open = offerRef.current;
      if (open && (open.status === "open" || open.status === "claimed"))
        void cancelPairing(machine.id, open.offerId).catch(() => {});
    };
  }, [machine.id]);

  const offerId = phase.kind === "offer" ? phase.offer.offerId : undefined;
  const waiting =
    phase.kind === "offer" &&
    (phase.status.status === "open" || phase.status.status === "claimed");
  useEffect(() => {
    if (phase.kind !== "offer" || !waiting) return;
    let disposed = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout>;
    const offer = phase.offer;
    const settle = (status: PairingStatus | undefined, previous: PairingStatus) => {
      const next = status?.status ?? "expired";
      offerRef.current = status ?? { ...previous, status: "expired" };
      if (next === "approved") {
        setPhase({ kind: "approved", name: status?.device?.name ?? previous.device?.name ?? "The phone" });
        onPairedRef.current?.();
      } else if (next === "denied") setPhase({ kind: "ended", reason: "denied" });
      else if (next === "cancelled") setPhase({ kind: "ended", reason: "cancelled" });
      else if (next === "expired") {
        if (previous.status === "claimed")
          setPhase({ kind: "ended", reason: "requestExpired" });
        else if (renewals.current < AUTO_RENEWALS) {
          renewals.current++;
          void create();
        } else setPhase({ kind: "ended", reason: "expired" });
      } else if (status) setPhase({ kind: "offer", offer, status });
    };
    const poll = async () => {
      const previous = offerRef.current!;
      try {
        const status = await pairingStatus(machine.id, offer.offerId);
        if (disposed) return;
        failures = 0;
        if (status.status !== previous.status || status.code !== previous.code) {
          settle(status, previous);
          if (status.status !== "open" && status.status !== "claimed") return;
        }
      } catch (reason) {
        if (disposed) return;
        // A restarted host forgets its offers: the code no longer works.
        if (/expired/i.test(hostMessage(reason))) {
          settle(undefined, previous);
          return;
        }
        if (++failures >= MAX_POLL_FAILURES) {
          setPhase({ kind: "error", message: hostMessage(reason) });
          return;
        }
      }
      timer = setTimeout(() => void poll(), POLL_MS);
    };
    timer = setTimeout(() => void poll(), POLL_MS);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [offerId, waiting, machine.id]);

  const decide = async (allow: boolean) => {
    if (phase.kind !== "offer" || busy) return;
    setBusy(true);
    setError("");
    try {
      const status = await decidePairing(machine.id, phase.offer.offerId, allow);
      offerRef.current = status;
      if (status.status === "approved") {
        setPhase({ kind: "approved", name: phase.status.device?.name ?? "The phone" });
        onPairedRef.current?.();
      } else if (status.status === "denied") setPhase({ kind: "ended", reason: "denied" });
      else if (status.status === "expired") setPhase({ kind: "ended", reason: "requestExpired" });
      else setPhase({ kind: "offer", offer: phase.offer, status });
    } catch (reason) {
      setError(hostMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const renew = () => {
    renewals.current = 0;
    void create();
  };

  return (
    <Modal title="Pair a phone" description={`With ${machineName}`} onClose={onClose}>
      <div className="flex flex-col gap-4 p-4 text-[12px]">
        {phase.kind === "loading" || phase.kind === "creating" ? (
          <div className="flex items-center gap-2 py-6 text-content/55" role="status">
            <Loader className="size-4 animate-spin" />
            {phase.kind === "creating" ? "Creating a pairing code…" : "Checking the machine…"}
          </div>
        ) : null}
        {phase.kind === "options" ? (
          <PairOptions
            machine={machine}
            machineName={machineName}
            config={phase.config}
            onContinue={() => {
              rememberPairOptions(machine.environmentId);
              void create();
            }}
            onCancel={onClose}
          />
        ) : null}
        {phase.kind === "offer" ? (
          phase.status.status === "claimed" ? (
            <Claimed
              status={phase.status}
              machineName={machineName}
              busy={busy}
              onDecide={(allow) => void decide(allow)}
            />
          ) : (
            <Offer offer={phase.offer} machineName={machineName} onCancel={onClose} />
          )
        ) : null}
        {phase.kind === "approved" ? (
          <>
            <p className="text-[13px] text-content" role="status">
              {phase.name} can now use {machineName}.
            </p>
            <div className="flex justify-end gap-2">
              <button type="button" autoFocus className={primary} onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : null}
        {phase.kind === "ended" ? (
          <>
            <p className="text-[13px] text-content" role="status">
              {ENDED[phase.reason]}
            </p>
            <div className="flex justify-end gap-2">
              <button type="button" className={secondary} onClick={onClose}>
                Close
              </button>
              <button type="button" className={primary} onClick={renew}>
                Generate new code
              </button>
            </div>
          </>
        ) : null}
        {phase.kind === "error" ? (
          <>
            <p
              role="alert"
              className="whitespace-pre-wrap break-words text-[12px] leading-snug text-red-400/90"
            >
              {phase.message}
            </p>
            <div className="flex justify-end gap-2">
              <button type="button" className={secondary} onClick={onClose}>
                Close
              </button>
              <button type="button" className={primary} onClick={renew}>
                Try again
              </button>
            </div>
          </>
        ) : null}
        {error ? (
          <p role="alert" className="text-[11px] leading-4 text-red-400/90">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

/** "How should your phone reach…": once per machine. */
function PairOptions({
  machine,
  machineName,
  config,
  onContinue,
  onCancel,
}: {
  machine: RemoteMachine;
  machineName: string;
  config: HostConfigView;
  onContinue: () => void;
  onCancel: () => void;
}) {
  const [direct, setDirect] = useState(config.direct.mode !== "off");
  const [relay, setRelay] = useState(config.relay.enabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const patch: Parameters<typeof setHostConfig>[1] = {};
      if (direct !== (config.direct.mode !== "off"))
        patch.direct = { mode: direct ? "private" : "off" };
      if (relay !== config.relay.enabled) patch.relay = { enabled: relay };
      if (Object.keys(patch).length) await setHostConfig(machine.id, patch);
      onContinue();
    } catch (reason) {
      setError(hostMessage(reason));
      setBusy(false);
    }
  };
  return (
    <>
      <p className="text-[13px] text-content">How should your phone reach {machineName}?</p>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={direct}
          disabled={busy}
          onChange={(event) => setDirect(event.target.checked)}
          className="mt-0.5 accent-accent"
        />
        <span>On the same network or Tailscale (direct)</span>
      </label>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={relay}
          disabled={busy}
          onChange={(event) => setRelay(event.target.checked)}
          className="mt-0.5 accent-accent"
        />
        <span>
          From anywhere (relay)
          {relay && !config.relay.enabled ? (
            <span className="mt-1 block text-[11px] leading-relaxed text-content/45">
              {RELAY_CONSENT} {relayOperator(config.relay.url)}
            </span>
          ) : null}
        </span>
      </label>
      {error ? (
        <p role="alert" className="text-[11px] leading-4 text-red-400/90">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <button type="button" className={secondary} disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className={primary}
          disabled={busy || (!direct && !relay)}
          onClick={() => void save()}
        >
          {busy ? <Loader className="size-3.5 animate-spin" strokeWidth={1.75} /> : null}
          Continue
        </button>
      </div>
    </>
  );
}

function Offer({
  offer,
  machineName,
  onCancel,
}: {
  offer: PairingOffer;
  machineName: string;
  onCancel: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1_500);
    return () => clearTimeout(timer);
  }, [copied]);
  const reachable = reachableThrough(offer.reachable);
  return (
    <>
      <div className="flex flex-col items-center gap-3">
        <QrCode value={offer.url} />
        <div className="text-center">
          <div className="text-[13px] font-medium text-content">{machineName}</div>
          <div className="mt-1 font-mono text-[11px] text-content/45">{offer.fingerprint}</div>
        </div>
      </div>
      <div className="flex items-center gap-2 text-content/55" role="status">
        <Loader className="size-3.5 animate-spin" />
        <span className="flex-1">Waiting for your phone…</span>
        <span className="tabular-nums">Expires in {formatCountdown(offer.expiresAt - now)}</span>
      </div>
      <p className="leading-relaxed text-content/55">
        Scan the code with MonoCode on your phone, or open the link there.
        {reachable ? ` Reachable through: ${reachable}.` : ""}
        {offer.reachable.relay
          ? ""
          : ` Your phone must be on the same network as ${machineName}. Turn on the relay to connect from anywhere.`}
      </p>
      <p className="leading-relaxed text-content/45">
        Anyone who scans this code can ask for access. Keep it private.
      </p>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          className={secondary}
          onClick={() => {
            void copyText(offer.url).then(() => setCopied(true), () => {});
          }}
        >
          {copied ? "Copied" : "Copy link"}
        </button>
        <button type="button" className={secondary} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </>
  );
}

function Claimed({
  status,
  machineName,
  busy,
  onDecide,
}: {
  status: PairingStatus;
  machineName: string;
  busy: boolean;
  onDecide: (allow: boolean) => void;
}) {
  const device = status.device;
  const about = [device?.model, device?.platform].filter(Boolean).join(", ");
  return (
    <>
      <p className="text-[13px] leading-relaxed text-content">
        <strong className="font-semibold">{device?.name ?? "A phone"}</strong>
        {about ? ` (${about})` : ""} wants to connect to {machineName}. Check
        that your phone shows{" "}
        <strong className="font-mono font-semibold tracking-[0.08em]">
          {formatCode(status.code ?? "")}
        </strong>
        .
      </p>
      <div className="flex justify-end gap-2">
        <button type="button" className={secondary} disabled={busy} onClick={() => onDecide(false)}>
          Deny
        </button>
        <button type="button" className={primary} disabled={busy} onClick={() => onDecide(true)}>
          {busy ? <Loader className="size-3.5 animate-spin" strokeWidth={1.75} /> : null}
          Allow
        </button>
      </div>
    </>
  );
}

/** The pairing link as a QR code: error correction M, a 4-module quiet zone,
 * dark on white whatever the theme so cameras read it. */
export function QrCode({ value }: { value: string }) {
  const { size, path } = useMemo(() => {
    const { modules } = QRCode.create(value, { errorCorrectionLevel: "M" });
    let path = "";
    for (let row = 0; row < modules.size; row++)
      for (let column = 0; column < modules.size; column++)
        if (modules.data[row * modules.size + column])
          path += `M${column + 4} ${row + 4}h1v1h-1z`;
    return { size: modules.size + 8, path };
  }, [value]);
  return (
    <svg
      role="img"
      aria-label="Pairing code"
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className="size-[280px] shrink-0 rounded-lg"
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
