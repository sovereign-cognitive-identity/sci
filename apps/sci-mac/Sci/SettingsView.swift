// SettingsView.swift — the one window the app exposes.
//
// Three tabs:
//
//   Status       live engine + tunnel state, recent events, quick controls
//   Credentials  read-only summary of ~/.sci/credentials.env
//   Trust        Sci CA fingerprint + Trust button (calls SecTrust API)
//
// All read-only / one-click actions in phase 1. SCI-128 layers OAuth
// flows on top of the Credentials tab; SCI-135 will polish the Trust
// flow with rollback + revoke.

import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var engine: SciEngine

    var body: some View {
        TabView {
            StatusPane()
                .tabItem { Label("Status", systemImage: "shield.lefthalf.filled") }
                .padding(20)

            CredentialsPane()
                .tabItem { Label("Credentials", systemImage: "key") }
                .padding(20)

            TrustPane()
                .tabItem { Label("Trust", systemImage: "checkmark.seal") }
                .padding(20)
        }
    }
}

// MARK: - Status

private struct StatusPane: View {
    @EnvironmentObject var engine: SciEngine

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 12) {
                Image(systemName: engine.tunnelStatus.symbolName)
                    .font(.system(size: 28))
                    .foregroundStyle(.tint)
                VStack(alignment: .leading) {
                    Text(engine.tunnelStatus.displayName)
                        .font(.title3.bold())
                    if let pid = engine.helperPid {
                        Text("sci-helper pid \(pid)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            // SCI-138: recent flows from the helper event stream.
            // Distinct from "Recent events" below — that's a free-form
            // log of bootstrap + control-plane messages; this is the
            // request/response history with structured columns.
            GroupBox("Recent flows") {
                if engine.recentFlows.isEmpty {
                    // TunnelStatus has associated values (`.helperFailed(String)`)
                    // so it doesn't auto-conform to Equatable. Match
                    // explicitly instead of `==`.
                    let captureOn: Bool = {
                        if case .active = engine.tunnelStatus { return true }
                        return false
                    }()
                    Text(captureOn
                         ? "Capture is on. Make a request to api.anthropic.com to see it here."
                         : "Enable capture above to start seeing requests.")
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 4) {
                            ForEach(engine.recentFlows) { flow in
                                HStack(spacing: 12) {
                                    Image(systemName: flow.success
                                          ? "checkmark.circle.fill"
                                          : "xmark.octagon.fill")
                                        .foregroundStyle(flow.success ? .green : .red)
                                    Text(flow.host)
                                        .font(.callout.monospaced())
                                    Spacer()
                                    if flow.success {
                                        Text("🔒 \(flow.masked)")
                                            .font(.callout.monospacedDigit())
                                            .foregroundStyle(.secondary)
                                        Text("\(flow.ms)ms")
                                            .font(.callout.monospacedDigit())
                                            .foregroundStyle(.secondary)
                                        Text("\(flow.status)")
                                            .font(.callout.monospacedDigit())
                                            .foregroundStyle(.secondary)
                                    }
                                }
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                    }
                    .frame(height: 120)
                }
            }

            GroupBox("Recent events") {
                if engine.lastEvents.isEmpty {
                    Text("No events yet.")
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 4) {
                            ForEach(engine.lastEvents, id: \.self) { line in
                                Text(line)
                                    .font(.caption.monospaced())
                                    .textSelection(.enabled)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                    }
                    .frame(height: 140)
                }
            }

            // SCI-138: live counters surfaced from the helper event
            // stream. When capture is off these stay at zero; once a
            // request flows through they tick up in real time.
            HStack(spacing: 24) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(engine.requestCount)")
                        .font(.title2.bold().monospacedDigit())
                    Text("requests")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(engine.maskedTotal)")
                        .font(.title2.bold().monospacedDigit())
                    Text("entities masked")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }

            // SCI-134: capture toggle. Hides nothing — surfacing both
            // "Enable" and "Disable" rather than one stateful toggle so
            // the request flow on first install is unambiguous: click
            // Enable, OS asks, you grant, capture starts.
            GroupBox("System-wide capture") {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Sci intercepts AI-host traffic at the OS level via a NetworkExtension. Every app's calls to api.anthropic.com / api.openai.com / generativelanguage.googleapis.com flow through Sci automatically — no env vars needed.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                    HStack {
                        switch engine.tunnelStatus {
                        case .active:
                            Button("Disable capture") {
                                Task { await engine.disableCapture() }
                            }
                            .controlSize(.large)
                        case .helperReady, .disabled:
                            Button("Enable capture") {
                                Task {
                                    do {
                                        try await engine.enableCapture()
                                    } catch {
                                        engine.appendEvent("Enable failed: \(error.localizedDescription)")
                                    }
                                }
                            }
                            .controlSize(.large)
                            .keyboardShortcut(.defaultAction)
                        case .requestingPermission:
                            ProgressView()
                                .controlSize(.small)
                            Text("Awaiting OS permission…")
                                .font(.callout)
                        case .helperFailed:
                            Text("Engine isn't ready yet. Re-probe the helper first.")
                                .font(.callout)
                                .foregroundStyle(.orange)
                        case .starting:
                            ProgressView()
                                .controlSize(.small)
                            Text("Engine starting…")
                                .font(.callout)
                        }
                        Spacer()
                    }
                }
                .padding(8)
            }

            HStack {
                Button("Re-probe helper") {
                    Task {
                        let ok = await engine.pingHelper()
                        engine.appendEvent(ok ? "Helper PING ok." : "Helper PING failed.")
                    }
                }
                Spacer()
                Button("Refresh tunnel status") {
                    Task { await engine.refreshTunnelStatus() }
                }
            }
            Spacer()
        }
    }
}

// MARK: - Credentials

private struct CredentialsPane: View {
    @EnvironmentObject var engine: SciEngine
    @State private var rows: [CredentialRow] = []

    struct CredentialRow: Identifiable {
        let id     = UUID()
        let label:   String
        let present: Bool
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text(engine.credentialsPath.path)
                    .font(.callout.monospaced())
                    .textSelection(.enabled)
                Spacer()
                Button("Reveal in Finder") {
                    NSWorkspace.shared.activateFileViewerSelecting([engine.credentialsPath])
                }
                .disabled(!FileManager.default.fileExists(atPath: engine.credentialsPath.path))
            }

            GroupBox("Configured providers") {
                VStack(alignment: .leading, spacing: 6) {
                    if rows.isEmpty {
                        Text("No credentials.env file. Sci will pass through whatever credential the calling tool sends.")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(rows) { row in
                            HStack {
                                Image(systemName: row.present ? "checkmark.circle.fill" : "circle")
                                    .foregroundStyle(row.present ? .green : .secondary)
                                Text(row.label)
                                Spacer()
                                Text(row.present ? "configured" : "—")
                                    .foregroundStyle(.secondary)
                                    .font(.caption)
                            }
                        }
                    }
                }
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            Text("Read-only in this build. Phase 2 wires OAuth (Claude Pro / OpenAI / Google sign-in) — SCI-128.")
                .font(.caption)
                .foregroundStyle(.secondary)

            Spacer()
        }
        .onAppear { reload() }
    }

    /// Parse credentials.env without exposing key bytes. We only report
    /// presence per provider — same approach the TS agent's
    /// `summarizeCredentials` takes.
    private func reload() {
        let path = engine.credentialsPath.path
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else {
            rows = []
            return
        }
        var present: [String: Bool] = [
            "ANTHROPIC_API_KEY":              false,
            "OPENAI_API_KEY":                 false,
            "OPENROUTER_API_KEY":             false,
            "GOOGLE_GENERATIVE_AI_API_KEY":   false,
            "GEMINI_API_KEY":                 false,
        ]
        for rawLine in text.split(separator: "\n") {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.isEmpty || line.hasPrefix("#") { continue }
            guard let eq = line.firstIndex(of: "=") else { continue }
            let key = String(line[..<eq]).trimmingCharacters(in: .whitespaces)
            let val = String(line[line.index(after: eq)...]).trimmingCharacters(in: .whitespaces)
            if present.keys.contains(key) && !val.isEmpty {
                present[key] = true
            }
        }
        // Group GEMINI_API_KEY into Google (TS agent does this too).
        let google = (present["GOOGLE_GENERATIVE_AI_API_KEY"] ?? false) || (present["GEMINI_API_KEY"] ?? false)
        rows = [
            .init(label: "Anthropic",        present: present["ANTHROPIC_API_KEY"]  ?? false),
            .init(label: "OpenAI",           present: present["OPENAI_API_KEY"]     ?? false),
            .init(label: "OpenRouter",       present: present["OPENROUTER_API_KEY"] ?? false),
            .init(label: "Google (Gemini)",  present: google),
        ]
    }
}

// MARK: - Trust

private struct TrustPane: View {
    @EnvironmentObject var engine: SciEngine
    @State private var fingerprint: String? = nil
    @State private var trustResult: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 12) {
                Image(systemName: "checkmark.seal")
                    .font(.system(size: 28))
                    .foregroundStyle(.tint)
                VStack(alignment: .leading) {
                    Text("Sci Local CA")
                        .font(.title3.bold())
                    Text(engine.caCertPath.path)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
            }

            GroupBox("Fingerprint (SHA-256)") {
                Text(fingerprint ?? "Waiting for engine…")
                    .font(.callout.monospaced())
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
            }

            HStack {
                Button("Trust this CA") {
                    let result = TrustHelper.trustCA(at: engine.caCertPath)
                    trustResult = result
                    engine.appendEvent("Trust action: \(result)")
                }
                .disabled(fingerprint == nil)

                if let r = trustResult {
                    Text(r)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Text("Trusting the Sci CA lets HTTPS_PROXY-respecting tools accept Sci's per-host leaf certs without `--cacert`. macOS will prompt for your password.")
                .font(.caption)
                .foregroundStyle(.secondary)

            Spacer()
        }
        .onAppear { reload() }
    }

    private func reload() {
        fingerprint = TrustHelper.fingerprint(of: engine.caCertPath)
    }
}
