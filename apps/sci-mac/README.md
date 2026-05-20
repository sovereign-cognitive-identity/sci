# Sci.app — macOS shell

The native macOS face of Sci. Menu-bar app that supervises a bundled
Rust helper (`sci-helper`, links the `sci-core` workspace) and a
NetworkExtension Packet Tunnel Provider (`SciTunnel.appex`) for
system-wide AI traffic capture.

## What ships in this build (SCI-127 phase 1)

A polished vertical slice that proves the architecture compiles
end-to-end:

* **Menu-bar app** (`Sci`) — SwiftUI, no Dock icon, opens a Settings
  window on demand
* **Settings window** with three tabs — Status, Credentials, Trust
* **NetworkExtension target** (`SciTunnel.appex`) — Packet Tunnel
  Provider that the OS will load when the user enables capture
* **Bundled Rust helper** (`sci-helper`) — long-running engine host;
  initializes CA + memory store, opens a Unix control socket, replies
  to PING/PONG so the app can verify it's alive
* **Read-only Credentials view** — parses `~/.sci/credentials.env`
  (same format the TS agent's `loadCredentials` uses) and shows which
  providers are configured
* **First-launch CA trust** — Trust pane shows the CA's SHA-256
  fingerprint and offers a single "Trust this CA" button that calls
  `SecTrustSettingsSetTrustSettings`

What's *not* in this build (each tracked as a follow-up ticket below):

* Full traffic round-trip — the PTP captures no routes yet, the
  helper logs events but doesn't yet dispatch through
  `sci-handlers`
* OAuth credential entry (Claude Pro / OpenAI sign-in)
* Auto-update (Sparkle)
* Notarization automation (manual `notarytool` runbook in
  `packages/agent/DISTRIBUTION.md` is reused)

## Layout

```
apps/sci-mac/
├── README.md                       (this file)
├── Sci.xcodeproj/                  Xcode project; one workspace, three targets
│   └── xcshareddata/xcschemes/Sci.xcscheme
├── Sci/                            App target (SwiftUI menu bar + Settings)
│   ├── SciApp.swift                @main entry; menu-bar + Settings scene
│   ├── SciEngine.swift             Helper supervisor + tunnel state
│   ├── MenuBarView.swift           Menu-bar dropdown
│   ├── SettingsView.swift          Three-tab Settings window
│   ├── TrustHelper.swift           CA fingerprint + SecTrustSettings install
│   ├── Info.plist
│   └── Sci.entitlements
├── SciTunnel/                      NetworkExtension target (Packet Tunnel Provider)
│   ├── PacketTunnelProvider.swift
│   ├── Info.plist
│   └── SciTunnel.entitlements
└── SciHelper/                      Rust binary; depends on sci-core via path
    ├── Cargo.toml
    └── src/main.rs
```

## Architecture decisions

### Helper-process (not in-app FFI)

`sci-helper` runs as a child process of the .app, *not* as an FFI
library linked into the Swift binary. Reasons:

* `sci-core` is async/tokio-heavy — driving it from Swift via C ABI
  requires either a tokio runtime per FFI call (high overhead) or
  Swift owning the runtime (extra plumbing for a v0.5 dogfood)
* The NE process is sandboxed differently than the helper; keeping
  the engine in its own process means the NE only needs the
  `network.client` entitlement, not full filesystem write
* Crash isolation — a panic in the engine doesn't take the NE down
* This is the same pattern 1Password 8 uses for `op-helper`; the
  ticket explicitly endorses this path

The single C ABI escape hatch the rules permit (`core/crates/sci-core/
src/ffi.rs`) is **not** added in this slice. We deferred it because
the Unix-socket protocol does the job today and the FFI surface can
be added later for iOS (where helper processes aren't a thing) without
touching anything that ships now.

### Why ECDSA is fine for the bundled CA

The Rust core's `sci-tls::ensure_ca` generates ECDSA P-256 (vs the TS
agent's RSA-2048). macOS keychain and `SecTrustSettings` accept ECDSA
without configuration. Existing TS-generated RSA CAs at `~/.sci/ca.crt`
load via the same code path; users migrating from the TS agent don't
re-trust.

### App is *not* sandboxed in v0.5

The app entitlement has `com.apple.security.app-sandbox = false`. The
helper child process needs to write `~/.sci/` and bind a Unix socket
in `~/.sci/helper.sock`; the strict sandbox blocks both. The Mac App
Store path requires either an XPC service hosting the helper or a
sandboxed extension model — both are larger lifts than this slice.
v0.5 distribution is direct .dmg, signed + notarized, same model as
1Password 8's direct download.

## Build

```bash
cd apps/sci-mac
xcodebuild -project Sci.xcodeproj \
           -scheme Sci \
           -configuration Debug \
           -destination 'platform=macOS' \
           build
```

The "Build sci-helper (cargo)" Run Script phase invokes
`cargo build` against `apps/sci-mac/SciHelper/` which depends on the
`sci/core/crates/sci-core` workspace via path. Output binary is copied
into `Sci.app/Contents/MacOS/sci-helper`. First build pulls Rust deps
(~30s); subsequent builds are incremental.

For release:

```bash
xcodebuild -project Sci.xcodeproj -scheme Sci \
           -configuration Release -destination 'platform=macOS' build
```

The release helper is ~2.4 MB (debug ~35 MB).

## Running locally (no code-signing)

The Xcode project ships with `CODE_SIGNING_ALLOWED = NO` so the build
is reproducible without an Apple Developer account. Without a signing
identity, **the NetworkExtension will not load** — that part of the
flow requires a paid developer team. The .app itself launches, the
helper spawns, the menu-bar shows, and the Settings panes render.
Casey can verify everything except the NE permission dialog.

To exercise the NE path:

1. Set `DEVELOPMENT_TEAM` in both target build configs to your team ID
2. Re-enable `CODE_SIGNING_ALLOWED` (set to `YES`)
3. Build + drag `Sci.app` into `/Applications`
4. Launch; the OS will prompt for NetworkExtension permission on
   first attempt to enable capture (Settings > Status > "Enable
   capture" — wired in SCI-134)

## Phase 1 verification

What this build mechanically proves:

```
$ xcodebuild ... build
** BUILD SUCCEEDED **

$ ls Sci.app/Contents/{MacOS,PlugIns}
Contents/MacOS/Sci                       # SwiftUI app
Contents/MacOS/sci-helper                # Rust helper (links sci-core)
Contents/PlugIns/SciTunnel.appex/...     # NetworkExtension provider

$ Sci.app/Contents/MacOS/Sci &           # launch
[helper logs to stderr]
Sci CA loaded cert=/Users/.../.sci/ca.crt
memory store ready db=/Users/.../.sci/memory/sci.db
helper listening socket=/Users/.../.sci/helper.sock
```

The Settings > Status pane's "Re-probe helper" button issues PING and
shows PONG in the events list — same path the NE uses to confirm the
engine is reachable before activating the tunnel.

## What's deferred (concrete follow-up tickets)

| Ticket   | Title                                              |
|----------|----------------------------------------------------|
| SCI-134  | macOS app phase 2: full traffic round-trip         |
| SCI-135  | macOS app phase 3: trust UX polish + revoke flow   |
| SCI-136  | macOS app phase 4: Settings credential editor + OAuth wiring (depends on SCI-128) |
| SCI-137  | App Store path: sandboxed app + XPC helper service  |

See HANDOFF.md for the SCI-127 phase 1 section with details on each.
