import { useEffect, useRef, useState } from "react";
import { Popover } from "../../../shared/ui/Popover";
import { Loader, MoreHorizontal } from "../../../shared/ui/icons";
import type { RemoteMachine } from "../../connections/model/protocol";
import {
  deviceDetail,
  deviceEvents,
  eventLabel,
  hostMessage,
  listDevices,
  renameDevice,
  revokeDevice,
  type Device,
  type DeviceEvent,
} from "../model/mobile";
import { Computer, Phone } from "./icons";

const input =
  "w-full rounded-lg border border-content/15 bg-content/3 px-3 py-2 text-[13px] outline-none focus:border-content/35";
const button =
  "rounded-lg bg-selection px-3 py-2 text-[13px] font-medium hover:bg-selection-hover disabled:opacity-40";
const item =
  "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-content/80 hover:bg-content/8 hover:text-content";

/** Phones and desktops paired with one machine: rename, revoke, and what
 * happened recently. Works for any machine whose host has `devices`. */
export function DeviceList({
  machine,
  machineName,
  refresh = 0,
  onDevices,
}: {
  machine: RemoteMachine;
  /** How copy names the machine: "this computer" or its own name. */
  machineName: string;
  /** Changes when something else (a pairing) added a device. */
  refresh?: number;
  onDevices?: (devices: Device[]) => void;
}) {
  const [devices, setDevices] = useState<Device[]>();
  const [error, setError] = useState("");
  const [menu, setMenu] = useState<string>();
  const [renaming, setRenaming] = useState<string>();
  const [name, setName] = useState("");
  const [revoking, setRevoking] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const anchors = useRef(new Map<string, HTMLButtonElement>());
  const onDevicesRef = useRef(onDevices);
  onDevicesRef.current = onDevices;

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const next = await listDevices(machine.id);
        if (disposed) return;
        setDevices(next);
        setError("");
        onDevicesRef.current?.(next);
      } catch (reason) {
        if (!disposed) setError(hostMessage(reason));
      }
      if (!disposed) timer = setTimeout(() => void load(), 30_000);
    };
    void load();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [machine.id, refresh, reload]);

  const rename = async (device: Device) => {
    if (busy || !name.trim()) return;
    setBusy(true);
    setError("");
    try {
      await renameDevice(machine.id, device.id, name.trim());
      setRenaming(undefined);
      setReload((value) => value + 1);
    } catch (reason) {
      setError(hostMessage(reason));
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (device: Device) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await revokeDevice(machine.id, device.id);
      setRevoking(undefined);
      setReload((value) => value + 1);
    } catch (reason) {
      setError(hostMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  if (!devices)
    return error ? (
      <p
        role="alert"
        className="whitespace-pre-wrap break-words rounded-lg bg-red-500/5 p-3 text-[12px] leading-relaxed text-red-400"
      >
        Couldn’t load devices: {error}
      </p>
    ) : (
      <div className="flex items-center gap-2 text-[12px] text-content/45">
        <Loader className="size-3.5 animate-spin" /> Loading devices…
      </div>
    );

  const phones = devices.filter((device) => device.kind === "mobile");
  return (
    <div className="flex flex-col gap-3">
      <div
        aria-label={`Devices on ${machineName}`}
        className="divide-y divide-stroke overflow-hidden rounded-xl border border-stroke"
      >
        {devices.map((device) => {
          const Icon = device.kind === "mobile" ? Phone : Computer;
          return (
            <div key={device.id}>
              <div className="flex items-center gap-3 px-4 py-3">
                <Icon className="size-4 shrink-0 text-content/45" />
                <div className="min-w-0 flex-1">
                  {renaming === device.id ? (
                    <form
                      className="flex items-center gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void rename(device);
                      }}
                    >
                      <input
                        autoFocus
                        aria-label={`New name for ${device.name}`}
                        className={input}
                        maxLength={64}
                        value={name}
                        disabled={busy}
                        spellCheck={false}
                        autoComplete="off"
                        onChange={(event) => setName(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key !== "Escape") return;
                          event.preventDefault();
                          event.stopPropagation();
                          setRenaming(undefined);
                        }}
                      />
                      <button
                        className={button}
                        disabled={busy || !name.trim()}
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        className="px-3 py-2 text-[13px] text-content/50"
                        onClick={() => setRenaming(undefined)}
                      >
                        Cancel
                      </button>
                    </form>
                  ) : (
                    <>
                      <div className="truncate text-[13px] font-medium">
                        {device.name}
                      </div>
                      <div className="mt-1 truncate text-[12px] text-content/45">
                        {deviceDetail(device)}
                      </div>
                    </>
                  )}
                </div>
                {renaming === device.id ? null : (
                  <button
                    ref={(element) => {
                      if (element) anchors.current.set(device.id, element);
                      else anchors.current.delete(device.id);
                    }}
                    disabled={busy}
                    aria-haspopup="menu"
                    aria-expanded={menu === device.id}
                    aria-label={`More for ${device.name}`}
                    className="rounded p-2 text-content/40 hover:bg-selection hover:text-content disabled:opacity-40"
                    onClick={() =>
                      setMenu((open) =>
                        open === device.id ? undefined : device.id,
                      )
                    }
                  >
                    <MoreHorizontal className="size-4" />
                  </button>
                )}
              </div>
              {menu === device.id ? (
                <Popover
                  anchor={{ current: anchors.current.get(device.id) ?? null }}
                  align="end"
                  width={180}
                  onDismiss={() => setMenu(undefined)}
                  role="menu"
                  aria-label={device.name}
                  className="p-1"
                >
                  <button
                    type="button"
                    role="menuitem"
                    className={item}
                    onClick={() => {
                      setMenu(undefined);
                      setRevoking(undefined);
                      setName(device.name);
                      setRenaming(device.id);
                    }}
                  >
                    Rename
                  </button>
                  {device.current ? null : (
                    <button
                      type="button"
                      role="menuitem"
                      className={item}
                      onClick={() => {
                        setMenu(undefined);
                        setRenaming(undefined);
                        setRevoking(device.id);
                      }}
                    >
                      Revoke…
                    </button>
                  )}
                </Popover>
              ) : null}
              {revoking === device.id ? (
                <div
                  role="group"
                  aria-label={`Confirm revoking ${device.name}`}
                  className="flex flex-col gap-3 border-t border-stroke bg-content/3 px-4 py-4 text-[12px] leading-relaxed text-content/60"
                >
                  <p>
                    {device.name} will lose access to {machineName}{" "}
                    immediately.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      className={button}
                      disabled={busy}
                      onClick={() => void revoke(device)}
                    >
                      Revoke
                    </button>
                    <button
                      className="px-3 py-2 text-[13px] text-content/50"
                      disabled={busy}
                      onClick={() => setRevoking(undefined)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {phones.length === 0 ? (
        <p className="text-[12px] leading-relaxed text-content/45">
          No phones yet. Pair one to use {machineName} from your phone.
        </p>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="whitespace-pre-wrap break-words rounded-lg bg-red-500/5 p-3 text-[12px] leading-relaxed text-red-400"
        >
          {error}
        </p>
      ) : null}
      <RecentActivity machine={machine} devices={devices} />
    </div>
  );
}

function RecentActivity({
  machine,
  devices,
}: {
  machine: RemoteMachine;
  devices: Device[];
}) {
  const [events, setEvents] = useState<DeviceEvent[]>();
  const [error, setError] = useState("");
  return (
    <details
      className="text-[12px] text-content/45"
      onToggle={(event) => {
        if (!(event.currentTarget as HTMLDetailsElement).open) return;
        setError("");
        void deviceEvents(machine.id)
          .then(setEvents)
          .catch((reason) => setError(hostMessage(reason)));
      }}
    >
      <summary className="cursor-pointer">Recent activity</summary>
      <div className="mt-3 flex flex-col gap-1.5">
        {error ? <p className="text-red-400">{error}</p> : null}
        {events && !events.length ? <p>Nothing yet.</p> : null}
        {events?.map((event, index) => (
          <p key={`${event.at}:${index}`} className="flex gap-3">
            <span className="shrink-0 tabular-nums text-content/35">
              {new Date(event.at).toLocaleString(undefined, {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}
            </span>
            <span className="min-w-0 text-content/60">
              {eventLabel(event, devices)}
            </span>
          </p>
        ))}
      </div>
    </details>
  );
}
