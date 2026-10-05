# 1. Product

## 1.1 Problem

Coding agents run for minutes to hours. They stop to ask for approval, ask a
question, or finish while the person who started them is away from the desk.
MonoCode today needs a desktop window to see or answer any of that.

Remote hosts (`docs/remote-access.md`) already keep agents running while the laptop
is closed. Nothing lets a person reach those agents from a phone.

## 1.2 Goals

1. **Answer the agent from anywhere.** Approvals, questions and follow-up prompts
   reach the right session within seconds, on Wi-Fi, cellular or VPN.
2. **Know when you are needed.** Push notifications for approvals, questions,
   finished and failed turns. No notification arrives for a session you are already
   looking at on another device.
3. **Start work from the phone.** Create a session on any paired machine, in any
   project and worktree, with a model, effort, permission mode and attachments.
4. **Review what happened.** Read full transcripts, tool calls, diffs, plans and
   task lists, and see the working-tree changes the agent made.
5. **Pairing in under a minute.** Scan one QR code, tap Allow on the other screen,
   and you are done. No ports, tokens or accounts.
6. **Unmistakably MonoCode.** It is the official MonoCode agent app (D12). Someone
   who uses the desktop recognises every surface: the same colours, type scale, chips,
   session cards, fold lines, provider icons, words and motion, recomposed for touch
   and one hand ([11](11-design-and-ux.md)).
7. **Private by construction.** The relay and the push gateway cannot read code,
   prompts, transcripts or notification text. A lost phone can be revoked from the
   desktop or the host CLI.

## 1.3 Non-goals for v1

| Not in v1 | Why, and what instead |
|---|---|
| Running agents on the phone | The phone is a client. Agents run on hosts |
| Seeing the desktop's existing in-app local sessions | They run inside the desktop webview (D3). Projects opened on "This computer" are shared instead |
| A terminal, or terminal-surface sessions | The host has no PTY support yet (`docs/remote-access.md`). Planned after v1 |
| Editing files | Read-only file viewing in v1. The agent edits; you review |
| Branch switching, PR creation, pull/sync | The host supports some of it. Added after commit and push prove out |
| Slash commands other than `/compact` and Plan mode, `@` mentions, skills, `/operator`, orchestration, handoff, second opinion, BTW | Not available on remote hosts today either |
| Message queue while a turn runs | Added in M3 as a host feature (`queue` command), not a phone-only trick |
| Accounts, sign-in, cloud sync of history | History lives on hosts. The phone caches it |
| Sharing a host with another person | Every paired device acts as the host's OS user. Roles beyond admin/member come later |
| Web or desktop clients of the channel protocol | The desktop keeps HTTP RPC (D11) |
| Voice push-to-talk | v1 relies on the keyboard's built-in dictation |
| Android | v1 is a native iOS app in Swift (D19, [16](16-ios-native-design.md)). The protocol stays language-neutral, so an Android app can follow after v1 |
| F-Droid / no-Google builds | Depends on an Android app first |

## 1.4 Users

- **Solo developer, desktop plus phone.** Runs agents on a laptop or desktop and
  wants to approve and nudge them from the couch or a commute. Pairs the phone with
  "This computer" and maybe one remote box.
- **Developer with an always-on box.** Has a Mac mini, Linux server or Windows tower
  running agents for hours. Pairs that host directly, sometimes without a desktop
  (CLI pairing).
- **Many-session operator.** Runs several agents in parallel across projects and
  needs a triage view of what is blocked, running and finished.

## 1.5 Core journeys

Each journey has a target time measured from unlocking the phone.

| ID | Journey | Steps | Target |
|---|---|---|---|
| J1 | Approve a command | Notification → tap → see the command and its context → Allow | < 10 s |
| J2 | Answer a question | Notification → tap → question sheet → choose options → Submit | < 20 s |
| J3 | Check progress | Open app → Agents shows Working → tap → transcript at the live tail | < 3 s to live content on Wi-Fi |
| J4 | Follow up | Open a finished session → read the summary → type → Send | Send acknowledged < 1 s on Wi-Fi |
| J5 | Start a task | + → machine → project → workspace → model → prompt (+ photo) → Start | < 60 s |
| J6 | Review changes | Session → Changes → file → unified diff | First diff < 2 s |
| J7 | Stop a runaway agent | Session → Stop | Stop acknowledged < 1 s |
| J8 | Pair a phone | Desktop: Settings → Mobile → Pair → phone: scan → both: Allow | < 60 s |
| J9 | Revoke a lost phone | Desktop: Settings → Mobile → device → Revoke | Immediate; live channels dropped |

## 1.6 Scope by release

"v1" is the first public store release (end of M7 in the [roadmap](14-roadmap.md)).

| Area | v1 | Later |
|---|---|---|
| Pairing | QR scan, pasted link, universal link; desktop and CLI initiation; confirmation with a 6-digit code | Short typed code via the relay; pairing from a phone already paired with that host |
| Transports | Direct (LAN, Tailscale, VPN, user-advertised address); relay fallback; automatic upgrade to direct | mDNS discovery; IPv6-only networks verified |
| Hosts | Many hosts per phone; status; rename; remove; update hints | Host-to-host grouping of the same repo |
| Agents (home) | Need approval / Working / Problems / Done / Recent, across all machines | Saved filters, snooze. MonoCode's PR/issue Inbox comes later and keeps the name Inbox |
| Projects and sessions | List, search, pin, archive, rename, delete; open folder on host | Folders (they are client-local on the desktop today) |
| Transcript | All block kinds the host produces; streaming; older history on scroll; images; full tool output on demand | Mermaid rendering; math |
| Composer | Text, photos, camera, files; model, effort, permission mode; Plan mode and Build; drafts; `/compact`; Stop; queue while running | Voice push-to-talk; edit last turn |
| Approvals and questions | Inline card plus sticky bar; question sheet; optional Face ID | Approve from the notification without opening the app |
| New session | Machine, project, current checkout / existing worktree / new worktree, model, effort, mode, prompt, attachments, one atomic request | Templates, recent prompts |
| Changes | Changed files, unified diff per file, commit and push | Stage hunks, discard, PR create |
| Files | Browse and view text files with highlighting | Edit, search content |
| Notifications | Approval, question, finished, failed, interrupted, usage limit; per-host and per-category settings; content previews optional; badge | Live Activities, widgets, host-offline alerts |
| Security | Keychain keys, encrypted cache, app lock, privacy screen, revocation | Hardware-bound keys, read-only devices |
| Platforms | iPhone and iPad (split layout) on iOS 26 or later | Android phones and tablets (deferred, D19), Apple Watch |

## 1.7 Feature parity matrix

The phone mirrors what remote host sessions support on the desktop today
(`RemoteSession.tsx`), plus mobile-only features.

| Feature | Desktop local | Desktop remote today | Mobile v1 |
|---|---|---|---|
| Providers | 10 | 10 | 10 (whatever the host has) |
| Send / follow-up | ✓ | ✓ | ✓ |
| Attachments | ✓ | ✓ (`attachments.upload`) | ✓ (camera, photos, files) |
| Model / effort / settings | ✓ | ✓ (`configure`) | ✓ |
| Permission mode | ✓ | ✓ | ✓ (warning for Full access) |
| Plan mode and Build | ✓ | ✓ (`sessions.plan`) | ✓ |
| Saved drafts | ✓ | ✓ (`sessions.draft`) | ✓ |
| `/compact` | ✓ | ✓ | ✓ |
| Approvals / questions | ✓ | ✓ | ✓ |
| Stop | ✓ | ✓ | ✓ |
| Queue while running | ✓ | ✗ | ✓ (new host `queue` command) |
| New worktree for a session | ✓ | ✓ (two requests) | ✓ (one atomic `create`) |
| Changes view, diffs | ✓ | ✓ | ✓ read; commit and push |
| File browser | ✓ | ✓ | ✓ read-only |
| Terminal | ✓ | ✗ | ✗ |
| Notifications | local banners | not wired for remote finish | ✓ push |
| Slash commands, skills, mentions, operator, orchestration | ✓ | ✗ | ✗ |

## 1.8 Success metrics

| Metric | Target | How measured |
|---|---|---|
| Pairing success, first try | ≥ 95 % | Local diagnostics counters (no telemetry by default); beta survey |
| Time from approval request to push shown (phone locked, online) | p50 < 3 s, p95 < 8 s | `push.test` and QA runs with timestamps |
| Time from tapping Send to host receipt (Wi-Fi, relay) | p50 < 400 ms | Client timing in diagnostics |
| Reconnect after foregrounding (host online) | p50 < 800 ms direct, < 1.5 s relay | Diagnostics |
| Transcript open, cached session | Content ≤ 150 ms after tap | Device benchmarks |
| Transcript fling while streaming (1,000 turns) | 0 hitches on the reference iPhones | Device benchmarks ([15 §15.5](15-performance.md#155-budgets)) |
| Lists, sheets, keyboard, navigation | 0 dropped frames on reference devices | Same |
| Crash-free sessions | ≥ 99.5 % | Store consoles |
| Lost commands | 0 | Outbox property tests; QA chaos runs |
| Relay or gateway able to read content | Never | Design review, tests in [13](13-testing-and-release.md) |

## 1.9 Principles

- **Native-smooth.** Every surface scrolls and animates like the platform's own apps,
  including while an agent streams ([15](15-performance.md)).
- **Same product, phone-shaped.** Copy the desktop's design language and vocabulary
  exactly. Change layout, density and interaction only where a phone requires it, and
  write down every such change ([11 §11.1](11-design-and-ux.md#111-design-parity-rules)).
- **Mirror, don't fork, the session model.** The phone renders the same `Session` and
  `Block` data the desktop renders, using the same grouping code.
- **Never lose or double a command.** Every mutation is either idempotent on the
  host or never retried automatically.
- **Show staleness honestly.** Cached content is labelled until the host confirms it
  is current. Offline is a state, not an error toast.
- **The host decides attention.** Notification policy runs where the truth is,
  so phones and desktops agree.
- **Secure defaults, explained.** The relay is opt-out at pairing time with a plain
  explanation. Full access from a phone asks for confirmation.
