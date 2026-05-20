// SciApp.swift — application entry point.
//
// Sci is a sovereign cognitive identity layer. The macOS app is a
// menu-bar-only shell: no Dock icon, one window for Settings, system-
// wide AI traffic capture via the bundled NetworkExtension Packet
// Tunnel Provider, the Rust engine running as a helper child process
// inside the bundle.
//
// Architecture (SCI-127 phase 1):
//
//   Sci.app/Contents/
//     MacOS/Sci                — this SwiftUI app (menu bar + Settings)
//     MacOS/sci-helper         — long-running Rust binary (sci-core)
//     PlugIns/SciTunnel.appex  — NetworkExtension Packet Tunnel Provider
//
//   On launch the app spawns sci-helper as a child process with a
//   socket path passed via env var. The PTP, when activated by the
//   user, connects to the same socket. This keeps the engine in one
//   place and lets the PTP forward intercepted bytes without itself
//   linking the engine — simpler entitlement story (the helper has
//   filesystem + network; the PTP only has the tunnel).
//
//   Phase 2 (SCI-134) wires the PTP's Packet → Helper → Upstream
//   round-trip. Phase 1 ships the seam.

import SwiftUI

@main
struct SciApp: App {
    // The single source of truth for engine + tunnel state. SwiftUI
    // observes it; it's a class so MenuBar and Settings windows share
    // one instance.
    @StateObject private var engine = SciEngine()

    var body: some Scene {
        // Menu-bar extra is the *only* persistent UI surface. The
        // Settings window opens on demand from the menu.
        MenuBarExtra {
            MenuBarView()
                .environmentObject(engine)
        } label: {
            // SF Symbol "shield.lefthalf.filled" — visually communicates
            // "barrier in front of your AI calls." Falls back gracefully
            // on older macOS, but we target 14+ anyway.
            Image(systemName: engine.tunnelStatus.symbolName)
        }
        .menuBarExtraStyle(.menu)

        // Settings scene — one Settings.bundle-style window with three
        // panes. macOS 14 makes this a first-class SwiftUI scene.
        Settings {
            SettingsView()
                .environmentObject(engine)
                .frame(minWidth: 560, minHeight: 380)
        }
    }
}
