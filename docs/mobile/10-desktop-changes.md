# 10. Desktop changes

The desktop gains three jobs:

1. **Run a host on this computer** (D3) so its projects can be shared with a phone.
2. **Start pairing** for any machine it manages, with a QR dialog and confirmation.
3. **Manage devices** on those machines.

It keeps talking to hosts over HTTP RPC (D11). No channel protocol is added to the
desktop.

## 10.1 Summary of changes

| Area | Files | Change |
|---|---|---|
| Local host lifecycle | `src-tauri/src/local_host.rs` (new), `remote_ssh.rs`, `remote_bootstrap.sh`, `remote_bootstrap.ps1` | Run the existing bootstrap scripts locally; pair locally; update; remove |
| Machine store | `src-tauri/src/remote.rs` | `StoredMachine.local: bool`; new methods on the allow-list; new Tauri commands |
| Settings → Mobile | `src/features/mobile/` (new): `ui/MobileSettings.tsx`, `ui/PairPhoneDialog.tsx`, `ui/DeviceList.tsx`, `model/mobile.ts` | New settings page |
| Settings registration | `src/features/settings/ui/SettingsView.tsx` | Add the "Mobile" section below Connections |
| Machines | `src/features/connections/ui/ConnectionsSettings.tsx`, `AddRemoteProjectDialog.tsx`, `src/app/shell/ProjectRail.tsx` | Show the local host as "This computer"; a phone badge on its projects |
| Presence | `src/features/connections/ui/RemoteSession.tsx`, `src/features/mobile/model/presence.ts` | Call `presence.update` when a host session is focused |
| QR rendering | `package.json` | Add the `qrcode` dependency (SVG output) |

## 10.2 "This computer": the local host

### What the person sees

**Settings → Mobile → This computer:**

| State | UI |
|---|---|
| Not set up | "Use this computer from your phone. MonoCode installs a background host on this computer. Projects you open on it can be used from the desktop and from your phone." **Set up** |
| Setting up | A step list with live status: Download host 0.9.0 → Verify checksum → Install background service → Start → Connect this desktop → Done. Each failed step shows the error, collapsed raw output, and **Retry** |
| Running | "MonoCode Host 0.9.0 is running." Status: Direct (local network) on/off; Relay on/off. Buttons: **Pair a phone**, **Open folder on this computer…**. Overflow menu: Update host, Restart host, Remove host… |
| Update available | "Host 0.8.2 is older than this app (0.9.0)." **Update now** (enabled when no sessions run) or "Will update when agents are idle" |
| Stopped / unreachable | "The host isn't responding." **Start** (runs `monocode-host start`) and **Diagnostics** (runs `doctor --json` and shows the result) |

### Setup steps (`local_host.rs`, a background job with the same poll model as the SSH job)

1. **Detect.** If `~/.monocode-host/bin/monocode-host` (Windows: `.cmd`) exists, run
   `connection-info`.
   - If it answers, the host is running. Skip to step 4 and reuse it. The same
     account may already be a remote host for another desktop; it is the same host.
2. **Install.** Run the existing bootstrap script **locally**:
   - `remote_ssh::bootstrap_script(platform)`, piped to `sh -l -s` on macOS and
     Linux, or to `powershell.exe -NoProfile -NonInteractive -EncodedCommand` on
     Windows.
   - The script downloads `monocode-host-<os>-<arch>` for the desktop's exact version,
     verifies the `.sha256`, checks `--version`, installs under
     `~/.monocode-host/runtime`, writes the launcher, runs `service install`, then
     `connection-info`.
   - **Port.** Prefer 3774. If it is taken by something else, pick a free loopback
     port and pass it as `MONOCODE_HOST_PORT`.
   - **Development builds.** A new script variable `MONOCODE_HOST_LOCAL_ARCHIVE` makes
     the script copy a local archive (from `npm run host:package`) and its
     `.sha256` instead of downloading. The desktop sets it when
     `MONOCODE_HOST_ARCHIVE` is in its own environment. Release builds ignore it.
3. **Release source.** The script's `RELEASE` base URL comes from a build-time
   setting (`MONOCODE_RELEASE_BASE`). Forks then download their own host packages
   rather than upstream's.
4. **Pair this desktop.** Run `monocode-host pair --name "<computer name> (this
   computer)" --json` locally and parse `{id, token, environmentId}`, the same way
   `remote_ssh.rs` parses SSH output.
5. **Store.** Upsert a `StoredMachine`:
   ```json
   {"id":"<uuid>","name":"This computer","endpoint":"http://127.0.0.1:3774",
    "environmentId":"…","token":"…","ssh":null,"local":true}
   ```
   - Upserting by `environmentId`, as today, keeps an existing machine id.
   - The endpoint is loopback HTTP, which `remote.rs` `endpoint()` already allows.
6. **Verify.** `environment.describe` must return the expected `environmentId` and
   protocol 1.
7. **Firewall** (optional; shown only if `doctor` reports a block):
   - "Your firewall may block phones on your network from connecting directly. They
     can still connect through the relay. **Allow direct connections**".
   - This runs the platform command elevated: `socketfilterfw` through an
     authorisation prompt on macOS, an elevated `New-NetFirewallRule` on Windows, or a
     printed command on Linux.

### Updates

- On launch and every 6 h, compare `environment.describe` → host version with the
  desktop version. The host version is added to the descriptor as `hostVersion`.
- When they differ and no session is `running`, update silently: run the bootstrap
  with `MONOCODE_HOST_FORCE_UPGRADE=1`, the same path as `remote_ssh_reconnect
  {upgrade:true}`.
- When sessions are running, show "Will update when agents are idle" and retry every
  5 min.
- Updating restarts the host. Phones reconnect automatically.

### Remove

"Remove host…" opens a dialog:

- **Stop sharing with phones.** Runs `relay disable`, `direct off`, and revokes all
  mobile devices. The host keeps running for desktop use.
- **Remove the host from this computer.** Runs `service uninstall`. Sessions and
  data stay in `~/.monocode-host` until deleted by hand. The dialog says so and offers
  **Show folder**.

### How projects use it

- The machine picker in **Open folder on a machine…** lists "This computer" first.
  The Mobile page also has a shortcut, **Open folder on this computer…**.
- Projects opened there appear in the project rail with a **phone badge** instead of
  the globe used for remote machines. Tooltip: "On this computer's host. Available on
  your phone."
- Sessions in those projects run in the host, exactly like a remote machine's
  project, with the same `RemoteSession.tsx` view and the same limits
  (`docs/remote-access.md` "Features that read or run on this computer…").
- **A folder already open as a normal local project** can be opened on the host too.
  It then appears as a second rail entry with the phone badge. The project's context
  menu gains **Open on this computer's host (for phone)**, which does that and
  switches to it. Merging local and host sessions into one rail entry is a later
  item ([14](14-roadmap.md)).

## 10.3 Settings → Mobile page

```
Mobile
──────────────────────────────────────────────────────────────
This computer                                  ● Running 0.9.0
  Direct connections on your network   [on]
  Relay (reach this computer from anywhere)  [off]
  [ Pair a phone ]   [ Open folder on this computer… ]    ⋯

Phones and devices on this computer
  📱 Ege's iPhone      iOS 18.1 · paired Oct 4 · last seen 2 min ago (relay)   ⋯
  🖥 MacBook (desktop) this desktop · admin                                     

Other machines
  mac-mini (SSH)                                       ● Online 0.9.0
    [ Pair a phone ]   2 phones                                        ⋯
  build-box (URL)                                      ● Online 0.8.1
    "Update the host to pair phones."  [ Update Host ]
──────────────────────────────────────────────────────────────
```

- **Machine rows** come from the existing machine list. The pairing controls are
  enabled when the host lists the `pairing` capability. Otherwise the row shows
  "Update Host", reusing the Connections update flow for SSH machines, or the manual
  instructions for URL machines.
- **The relay toggle** calls `host.config.set {relay:{enabled}}`. Turning it on first
  shows a consent sheet:
  > The relay lets your phone reach this machine when it isn't on the same network.
  > Traffic is end-to-end encrypted: the relay sees only when you connect and how
  > much data moves, never your code or messages. {Operator line} [Use relay] [Not now]

  The operator line comes from the host's `relay.url`:
  - `relay.usemono.dev`: "The relay is run by the MonoCode project."
  - Any other URL: "This relay is run by whoever operates {hostname}." On the personal
    track that is the maintainer's own deployment.

  The relay stays off until someone opts in (D15).
- **The direct toggle** calls `host.config.set {direct:{mode:"private"|"off"}}`. The
  `all` mode is CLI-only.
- **Device rows:**
  - Data comes from `devices.list`.
  - The overflow menu has **Rename** and **Revoke…**. Revoke confirms: "Ege's iPhone
    will lose access to mac-mini immediately."
  - The current desktop's own row can't be revoked here. Connections → Remove does
    that.
  - **Recent activity** opens the `device_events` list. It reaches the desktop through
    a `devices.events` method, a small addition to the host's `devices` capability.

## 10.4 Pair-a-phone dialog

| Step | Content |
|---|---|
| Options (shown once per machine, skipped later) | "How should your phone reach mac-mini?" ☑ On the same network or Tailscale (direct) ☐ From anywhere (relay), with the consent text from §10.3 |
| QR | The QR (`qrcode` → SVG, at least 280 px), the host name and fingerprint, "Expires in 9:42", **Copy link**, and a warning: "Anyone who scans this code can ask for access. Keep it private." It also lists "Reachable through: local network (192.168.1.20) · Tailscale · relay", and when there is no route: "Your phone must be on the same network as this computer. Turn on the relay to connect from anywhere." |
| Waiting | The dialog polls `pairing.status` every 1 s |
| Claimed | "**Ege's iPhone** (iPhone 16 Pro, iOS 18.1) wants to connect to mac-mini. Check that your phone shows **482 913**." [Deny] [Allow] |
| Approved | "Ege's iPhone can now use mac-mini." [Done]. The device list refreshes |
| Denied, expired or cancelled | The matching copy from [04 §4.9](04-pairing.md#49-errors-and-copy) + **Generate new code** |

- `pairing.create` includes the desktop's current appearance (`ui`: theme, hue,
  saturation, dark lightness, accent), so the phone can offer to match this desktop's
  look ([11 §11.2](11-design-and-ux.md#112-color)).
- The dialog itself uses the desktop's Modal (type A) and the phone-pairing copy from
  [11 §11.11](11-design-and-ux.md#1111-onboarding-and-pairing) where the two meet.
- Closing the dialog calls `pairing.cancel` for an open offer.
- The dialog regenerates the code automatically when it expires while open, up to 3
  times. After that it asks.

## 10.5 Rust changes (`remote.rs`, `local_host.rs`)

- **`StoredMachine`** gains `#[serde(default)] local: bool`. Older files load
  unchanged. The renderer-facing `Machine` also gains `local`.
- **`supported_remote_method`** adds:
  - `pairing.create`, `pairing.status`, `pairing.decide`, `pairing.cancel`;
  - `devices.list`, `devices.rename`, `devices.revoke`, `devices.events`;
  - `host.config.get`, `host.config.set`;
  - `presence.update`.
- **New Tauri commands**, registered in `lib.rs`:

  | Command | Returns | Notes |
  |---|---|---|
  | `local_host_status()` | `{installed, running, version?, port?, machineId?}` | Fast; runs `connection-info` with a 2 s timeout |
  | `local_host_setup()` | `jobId` | Background job; poll with `local_host_poll(jobId)` → `{message, step, done, error?, machine?}` |
  | `local_host_update()` | `jobId` | Same job model |
  | `local_host_start()` | `()` | `monocode-host start` |
  | `local_host_remove(mode: "stopSharing" \| "uninstall")` | `jobId` | |
  | `local_host_firewall_fix()` | `()` | Elevated platform command; errors are surfaced verbatim |

- **Concurrency.** One local-host job at a time, with a lock separate from the SSH
  job lock.
- **Cleanup.** The local machine is never removed by `RemoteConnections::shutdown`.
  Quitting the desktop does not stop the host.

## 10.6 Presence for notifications

For the host to suppress phone pushes while the person watches on the desktop
([08 §8.3](08-notifications.md#83-presence)):

- `src/features/mobile/model/presence.ts` tracks:
  - window focus (`document.hasFocus()` and `focus`/`blur` events);
  - the last user input (`keydown`, `pointerdown`, `wheel`, throttled);
  - the focused pane's session, when it is a host session.
- It calls `presence.update {visible, focusedSessionId}` on that machine when the
  focused host session changes, when visibility changes, and every 30 s while
  visible.
  - `visible` is false when the window is blurred or there was no input for 120 s.
  - Only machines that list the `presence` capability get calls.
  - Failures are ignored.
- Cost: one small HTTP request every 30 s per machine with a focused session.

## 10.7 Tests

- **Rust:**
  - `local_host.rs` script assembly: the local-archive variable and the port choice.
  - `StoredMachine` deserialisation with and without `local`.
  - The allow-list additions.
  - A job state-machine test with a fake command runner.
- **TS:**
  - `PairPhoneDialog` state transitions from scripted `pairing.status` results.
  - Device list actions and the relay consent flow.
  - Presence throttling and visibility rules.
  - Machine picker ordering, with "This computer" first.
- **Manual QA:**
  - Fresh macOS, Linux and Windows accounts.
  - An existing remote host on the same account.
  - Port 3774 occupied.
  - Firewall on and off.
  - Update while sessions run.
  - Remove in both modes.
