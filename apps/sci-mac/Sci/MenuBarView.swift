// MenuBarView.swift — the tiny menu users actually see.
//
// Three sections: status + live counters, recent flows, settings + quit.
// Designed for the "glance once a day" cadence — every line is one
// piece of information the user might want to verify at a glance.

import SwiftUI

struct MenuBarView: View {
    @EnvironmentObject var engine: SciEngine
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        Text(engine.tunnelStatus.displayName)
            .font(.headline)
            .disabled(true)

        // SCI-138: live counters. Once capture is on, this is what the
        // user actually wants to see — "Sci is doing things right now".
        if engine.requestCount > 0 {
            Text("\(engine.requestCount) request\(engine.requestCount == 1 ? "" : "s") · 🔒 \(engine.maskedTotal) masked")
                .disabled(true)
        }

        if let pid = engine.helperPid {
            Text("Engine pid: \(pid)")
                .disabled(true)
        }

        // Recent flows — newest first, capped at 5 lines so the menu
        // stays compact. Full list lives in Settings → Status.
        if !engine.recentFlows.isEmpty {
            Divider()
            ForEach(engine.recentFlows.prefix(5)) { flow in
                Text(flow.summary)
                    .font(.system(size: 12, design: .monospaced))
                    .disabled(true)
            }
        }

        Divider()

        Button("Settings…") {
            // Bring app forward so the Settings window draws focused.
            // Without this the window opens behind everything because
            // the app is .accessory.
            NSApp.activate(ignoringOtherApps: true)
            openSettings()
        }
        .keyboardShortcut(",", modifiers: .command)

        Divider()

        Button("Quit Sci") {
            NSApplication.shared.terminate(nil)
        }
        .keyboardShortcut("q", modifiers: .command)
    }
}

private extension SciEngine.FlowSummary {
    /// One-line summary suitable for the menu-bar dropdown. Trimmed so
    /// long hostnames don't blow out the menu width.
    var summary: String {
        let shortHost = host.count > 28 ? String(host.suffix(28)) : host
        if !success {
            return "✗ \(shortHost)"
        }
        return "\(shortHost) · 🔒 \(masked) · \(ms)ms"
    }
}
