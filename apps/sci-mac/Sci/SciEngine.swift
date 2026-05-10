// SciEngine.swift — supervises the bundled sci-helper child process and
// the NetworkExtension Transparent Proxy Manager.
//
// Lifecycle:
//
//   1. App launches → SciEngine.init reads the bundled sci-helper path
//      from Bundle.main, prepares ~/.sci/, computes a control socket
//      path, and starts the helper as a Process child.
//   2. The helper opens the Unix socket; SciEngine probes it with a
//      "PING" line; tunnelStatus advances to .helperReady.
//   3. Settings → Status pane offers an "Enable capture" toggle which
//      calls `enableCapture()`. That builds an
//      `NETunnelProviderManager` configured for the transparent-proxy
//      provider type, registers `NENetworkRule`s for the AI host set,
//      saves to system prefs (triggers the OS NE permission dialog on
//      first use), then `startVPNTunnel()`. After approval,
//      tunnelStatus advances to .active.
//
// SCI-134 replaced the phase-1 packet-tunnel scaffold with this
// transparent-proxy implementation: flow-level OS-pre-routed
// interception by hostname/port rule, no IP/TCP reassembly. See
// `SciTunnel/PacketTunnelProvider.swift` (file name preserved from
// phase 1; class inside is `TransparentProxyProvider`).

import Foundation
import Combine
import NetworkExtension

@MainActor
final class SciEngine: ObservableObject {

    // MARK: - Published state

    enum TunnelStatus {
        case starting          // app just launched, helper not yet spawned
        case helperFailed(String)
        case helperReady       // helper alive + responsive; tunnel inactive
        case requestingPermission
        case active            // NE running; AI traffic flowing
        case disabled

        var symbolName: String {
            switch self {
            case .starting, .requestingPermission: return "shield.lefthalf.filled"
            case .helperFailed:                    return "shield.slash"
            case .helperReady, .disabled:          return "shield.lefthalf.filled"
            case .active:                          return "shield.fill"
            }
        }

        var displayName: String {
            switch self {
            case .starting:                  return "Starting"
            case .helperFailed(let reason):  return "Engine failed: \(reason)"
            case .helperReady:               return "Engine ready (capture off)"
            case .requestingPermission:      return "Requesting permission"
            case .active:                    return "Capturing AI traffic"
            case .disabled:                  return "Capture disabled"
            }
        }
    }

    @Published private(set) var tunnelStatus: TunnelStatus = .starting
    @Published private(set) var helperPid:    Int32?       = nil
    @Published private(set) var lastEvents:   [String]     = []

    // SCI-138 — live counters fed by the helper event stream.
    /// Total flows the helper has handled this session. Increments on
    /// every `flow_completed` and `flow_error` event.
    @Published private(set) var requestCount: Int = 0
    /// Sum of `masked` counts across completed flows. The "🔒 masked N"
    /// signal aggregated.
    @Published private(set) var maskedTotal:  Int = 0
    /// Last-N completed flows for the menu-bar dropdown. Newest first.
    @Published private(set) var recentFlows:  [FlowSummary] = []

    /// Per-flow summary surfaced in the menu bar + Settings → Status.
    /// Identifiable via a UUID so SwiftUI's ForEach is happy.
    struct FlowSummary: Identifiable {
        let id      = UUID()
        let host:    String
        let masked:  Int
        let ms:      Int
        let status:  Int
        let success: Bool
        let when:    Date
    }

    // MARK: - Paths

    /// `~/.sci`. Mirrors the TS agent so a user moving between the two
    /// keeps their CA + memory store.
    let configDir: URL = {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".sci", isDirectory: true)
    }()

    var helperSocketPath: URL { configDir.appendingPathComponent("helper.sock") }
    var caCertPath:       URL { configDir.appendingPathComponent("ca.crt") }
    var credentialsPath:  URL { configDir.appendingPathComponent("credentials.env") }
    var memoryDbPath:     URL { configDir.appendingPathComponent("memory/sci.db") }

    /// Path to the bundled `sci-helper` binary. The Rust binary is
    /// copied into Contents/MacOS/ at build time by a Run Script
    /// phase — see project.pbxproj.
    var bundledHelperPath: URL? {
        Bundle.main.executableURL?
            .deletingLastPathComponent()
            .appendingPathComponent("sci-helper")
    }

    // MARK: - Internal

    private var helperProcess: Process?
    private let helperQueue = DispatchQueue(label: "sci.engine.helper")

    init() {
        Task { await bootstrap() }
    }

    deinit {
        helperProcess?.terminate()
    }

    // MARK: - Bootstrap

    private func bootstrap() async {
        do {
            try ensureConfigDir()
            try await startHelper()
            try await waitForHelper()
            tunnelStatus = .helperReady
            appendEvent("Engine ready.")
            // SCI-138: subscribe to the helper event stream now that
            // PING succeeded. Long-lived task; reconnects on disconnect.
            Task { await self.runEventConsumer() }
        } catch {
            tunnelStatus = .helperFailed(error.localizedDescription)
            appendEvent("Engine failed: \(error.localizedDescription)")
        }
    }

    private func ensureConfigDir() throws {
        let fm = FileManager.default
        if !fm.fileExists(atPath: configDir.path) {
            try fm.createDirectory(at: configDir, withIntermediateDirectories: true,
                                   attributes: [.posixPermissions: 0o700])
        }
    }

    private func startHelper() async throws {
        guard let helperURL = bundledHelperPath, FileManager.default.isExecutableFile(atPath: helperURL.path) else {
            throw SciError.helperMissing
        }

        // Best-effort cleanup of a stale socket from a prior run/crash.
        try? FileManager.default.removeItem(at: helperSocketPath)

        let proc = Process()
        proc.executableURL = helperURL
        proc.environment = [
            "HOME":               NSHomeDirectory(),
            "SCI_CONFIG_DIR":     configDir.path,
            "SCI_HELPER_SOCKET":  helperSocketPath.path,
            "RUST_LOG":           ProcessInfo.processInfo.environment["RUST_LOG"] ?? "info",
        ]
        // Pipe helper stderr into our own so Console.app captures it
        // under the app's subsystem. Same approach 1Password 8 takes
        // for `op-helper`.
        proc.standardError = FileHandle.standardError
        proc.standardOutput = FileHandle.standardOutput

        try proc.run()
        helperProcess = proc
        helperPid = proc.processIdentifier
        appendEvent("Helper spawned (pid \(proc.processIdentifier)).")
    }

    /// Probe the helper's socket with PING until we get PONG or time out.
    ///
    /// The default timeout is generous (3 minutes) because SCI-139 made
    /// the helper load `BgeEmbedder` *before* binding the socket — and
    /// on first install that means a ~110 MB HuggingFace Hub download.
    /// On steady-state launches the model is cached and the bind is
    /// sub-second.
    ///
    /// We poll progressively (100 ms → 1 s → 2 s) so a fast launch
    /// resolves fast, while a slow first install doesn't burn CPU
    /// hammering the socket.
    private func waitForHelper(timeout: TimeInterval = 180) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        var pollNanos: UInt64 = 100_000_000  // 0.1 s
        var firstSlowLog = false
        let slowThreshold = Date().addingTimeInterval(5)
        while Date() < deadline {
            if await pingHelper() { return }
            // Surface a clear "still starting" signal once we cross 5s
            // so the user knows the spinner hasn't hung — almost
            // always means the embedder is downloading on first run.
            if !firstSlowLog && Date() > slowThreshold {
                appendEvent("Engine startup is taking longer than usual — likely first-run model download (~110 MB). Watch Console.app under sci.helper for progress.")
                firstSlowLog = true
            }
            try? await Task.sleep(nanoseconds: pollNanos)
            // Exponential-ish back-off, capped at 2 s.
            pollNanos = min(pollNanos * 2, 2_000_000_000)
        }
        throw SciError.helperUnresponsive
    }

    /// Connect to the helper's Unix socket, send "PING\n", wait for "PONG".
    func pingHelper() async -> Bool {
        await withCheckedContinuation { continuation in
            helperQueue.async {
                let path = self.helperSocketPath.path
                let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
                guard fd >= 0 else { continuation.resume(returning: false); return }
                defer { Darwin.close(fd) }

                var addr = sockaddr_un()
                addr.sun_family = sa_family_t(AF_UNIX)
                let pathBytes = path.utf8CString
                guard pathBytes.count <= MemoryLayout.size(ofValue: addr.sun_path) else {
                    continuation.resume(returning: false); return
                }
                _ = withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
                    ptr.withMemoryRebound(to: CChar.self, capacity: pathBytes.count) { cptr in
                        pathBytes.withUnsafeBufferPointer { src in
                            _ = memcpy(cptr, src.baseAddress, src.count)
                        }
                    }
                }
                let connectResult = withUnsafePointer(to: &addr) { ptr -> Int32 in
                    ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                        Darwin.connect(fd, sockPtr, socklen_t(MemoryLayout<sockaddr_un>.size))
                    }
                }
                guard connectResult == 0 else { continuation.resume(returning: false); return }

                let msg = "PING\n"
                _ = msg.withCString { cstr in
                    Darwin.send(fd, cstr, strlen(cstr), 0)
                }
                var buf = [UInt8](repeating: 0, count: 16)
                let n = Darwin.recv(fd, &buf, buf.count, 0)
                let ok = n >= 4 && String(bytes: buf.prefix(4), encoding: .utf8) == "PONG"
                continuation.resume(returning: ok)
            }
        }
    }

    // MARK: - Tunnel control

    /// AI hostnames the transparent proxy intercepts. Same set the TS
    /// agent's `aiHosts` defaults to (see `packages/agent/src/config.ts`)
    /// so users moving across implementations see consistent coverage.
    /// Anything not in this list is OS-routed normally — we never sit
    /// on non-AI traffic.
    static let aiHosts: [String] = [
        "api.anthropic.com",
        "api.openai.com",
        "openrouter.ai",
        "generativelanguage.googleapis.com",
    ]

    /// Bundle ID of the embedded transparent-proxy extension. Must
    /// match the `.appex`'s CFBundleIdentifier in the build settings —
    /// `NETunnelProviderProtocol.providerBundleIdentifier` is how the
    /// OS finds the right extension to load.
    ///
    /// Derived from the host app's bundle ID + `.tunnel` so changing
    /// the team prefix in Xcode (Signing & Capabilities → Team) just
    /// propagates. The xcodeproj already configures the .appex's
    /// PRODUCT_BUNDLE_IDENTIFIER as `<host>.tunnel`; this stays in
    /// sync as long as both targets share the auto-managed prefix.
    static var providerBundleId: String {
        let host = Bundle.main.bundleIdentifier ?? "com.sci.mac"
        return "\(host).tunnel"
    }

    /// Refresh `tunnelStatus` from the system NE preferences. Called by
    /// the menu bar / Settings on appear.
    func refreshTunnelStatus() async {
        do {
            let managers = try await NETunnelProviderManager.loadAllFromPreferences()
            if let m = managers.first {
                tunnelStatus = m.connection.status == .connected ? .active : .disabled
            } else {
                tunnelStatus = .helperReady
            }
        } catch {
            appendEvent("Tunnel status query failed: \(error.localizedDescription)")
        }
    }

    /// User clicked "Enable capture" in Settings. Build/refresh the
    /// transparent-proxy configuration, persist it (triggers OS NE
    /// permission dialog on first call), then start the tunnel.
    ///
    /// Idempotent — calling it on an already-configured + connected
    /// manager is a no-op aside from refreshing the rule set.
    func enableCapture() async throws {
        tunnelStatus = .requestingPermission
        appendEvent("Requesting capture permission…")

        // Reset the spinner state if any step below throws — without
        // this the UI stays stuck on "Awaiting OS permission…"
        // forever after a denial. The most common failure here is
        // ad-hoc/unsigned builds: NE entitlements require a real
        // signing identity, so `saveToPreferences()` returns
        // "permission denied" until the user runs from Xcode with a
        // configured Team in Signing & Capabilities.
        do {
            let managers = try await NETunnelProviderManager.loadAllFromPreferences()
            let manager = managers.first ?? NETunnelProviderManager()
            configure(manager: manager)
            try await manager.saveToPreferences()
            // After save, you have to re-load before starting — Apple's NE
            // framework requires this round-trip. Skipping it surfaces a
            // very confusing "Permission denied" at startVPNTunnel().
            try await manager.loadFromPreferences()
            try manager.connection.startVPNTunnel()
            tunnelStatus = .active
            appendEvent("Capture enabled.")
        } catch {
            // Surface the specific NSError code so the user knows what
            // to fix (signing vs entitlement vs user-denied prompt).
            // Most NE errors are NEVPNError.* in domain "NEVPNErrorDomain".
            let ns = error as NSError
            appendEvent(
                "Enable failed: \(error.localizedDescription) "
                + "[domain=\(ns.domain) code=\(ns.code)]"
            )
            tunnelStatus = .helperReady
            throw error
        }
    }

    /// User clicked "Disable capture". Stops the tunnel; leaves the
    /// configuration in System Preferences so re-enabling doesn't
    /// re-prompt for OS permission.
    func disableCapture() async {
        let managers = (try? await NETunnelProviderManager.loadAllFromPreferences()) ?? []
        if let m = managers.first {
            m.connection.stopVPNTunnel()
        }
        tunnelStatus = .disabled
        appendEvent("Capture disabled.")
    }

    /// Build the NETunnelProviderProtocol + NENetworkRules from
    /// `aiHosts`. Called by both first-time setup and any subsequent
    /// rule refresh (e.g. when SCI-128 adds OAuth host detection).
    private func configure(manager: NETunnelProviderManager) {
        let proto = NETunnelProviderProtocol()
        proto.providerBundleIdentifier = Self.providerBundleId

        // The transparent-proxy provider doesn't need a "server" address
        // (it's not a VPN). The framework still requires `serverAddress`
        // be non-nil for `saveToPreferences` to succeed; "Sci" is a
        // recognizable label that surfaces in System Settings → VPN.
        proto.serverAddress = "Sci"

        // The provider reads this back via providerConfiguration to know
        // where to reach the helper, AND which signing identity to
        // exclude from interception (see SCI-144 — without this, the
        // helper's own outbound to AI hosts loops back through the NE
        // and we recurse).
        let hostBundleId = Bundle.main.bundleIdentifier ?? ""
        proto.providerConfiguration = [
            "helperSocket": helperSocketPath.path,
            "aiHosts":      Self.aiHosts,
            "hostBundleId": hostBundleId,
        ]

        // Hostname-based rules. NENetworkRule(destinationHost:protocol:)
        // is the modern initializer for "intercept TCP to this hostname"
        // — Apple resolves the hostname on flow create, populates
        // `NEAppProxyTCPFlow.remoteHostname` for our handleNewFlow.
        let rules = Self.aiHosts.map { host -> NENetworkRule in
            NENetworkRule(destinationHost: NWHostEndpoint(hostname: host, port: "443"),
                          protocol: .TCP)
        }
        // SCI-134: outbound TCP to AI hosts. Other directions/protocols
        // fall through to OS-default routing.
        let settings = NETransparentProxyNetworkSettings(tunnelRemoteAddress: "Sci")
        settings.includedNetworkRules = rules
        settings.excludedNetworkRules = []

        proto.includeAllNetworks  = false
        proto.excludeLocalNetworks = true
        manager.protocolConfiguration = proto
        // Tunnel description is what surfaces in System Settings → VPN
        // and the menu-bar "Sci is using your network" status row.
        manager.localizedDescription = "Sci"
        manager.isEnabled            = true
    }

    // MARK: - SCI-138 event consumer

    /// Long-lived background task that subscribes to the helper's event
    /// stream and threads each event back onto the MainActor to update
    /// the published counters. Reconnects on disconnect with a
    /// 5-second backoff — the helper restarting (e.g. user upgrade)
    /// shouldn't permanently silence the menu bar.
    private func runEventConsumer() async {
        let socketPath = helperSocketPath.path
        while !Task.isCancelled {
            await consumeOneSession(socketPath: socketPath)
            // Disconnect: wait + retry. Capped at 5s so a slow helper
            // restart still resumes within a UI-comfortable window.
            try? await Task.sleep(nanoseconds: 5_000_000_000)
        }
    }

    private nonisolated func consumeOneSession(socketPath: String) async {
        // Connect to the same Unix socket the NE / Settings panel use.
        // We send `{"kind":"events"}\n` to declare ourselves a
        // subscriber; helper streams JSON lines back until close.
        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return }
        defer { Darwin.close(fd) }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = socketPath.utf8CString
        guard pathBytes.count <= MemoryLayout.size(ofValue: addr.sun_path) else { return }
        _ = withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
            ptr.withMemoryRebound(to: CChar.self, capacity: pathBytes.count) { cptr in
                pathBytes.withUnsafeBufferPointer { src in
                    _ = memcpy(cptr, src.baseAddress, src.count)
                }
            }
        }
        let connectResult = withUnsafePointer(to: &addr) { ptr -> Int32 in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                Darwin.connect(fd, sockPtr, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard connectResult == 0 else { return }

        let header = "{\"kind\":\"events\"}\n"
        _ = header.withCString { cstr in
            Darwin.send(fd, cstr, strlen(cstr), 0)
        }

        // Read line-by-line. Each line is a complete JSON event.
        var buf = Data()
        var chunk = [UInt8](repeating: 0, count: 4096)
        while !Task.isCancelled {
            let n = chunk.withUnsafeMutableBufferPointer { ptr in
                Darwin.recv(fd, ptr.baseAddress, ptr.count, 0)
            }
            if n <= 0 { return }
            buf.append(chunk, count: n)
            // Drain whole lines from the buffer.
            while let nl = buf.firstIndex(of: 0x0A) {
                let lineData = buf.prefix(nl)
                buf.removeSubrange(0..<(nl + 1))
                if lineData.isEmpty { continue }
                if let event = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any] {
                    await self.handleEvent(event)
                }
            }
        }
    }

    /// Dispatch a parsed event into MainActor state. Each event type
    /// maps to one or two published-var updates.
    @MainActor
    private func handleEvent(_ event: [String: Any]) async {
        guard let type = event["type"] as? String else { return }
        switch type {
        case "subscribed":
            // First line on a fresh subscription — just an ACK.
            return
        case "embedder_loading":
            appendEvent("Embedder loading…")
        case "embedder_ready":
            appendEvent("Embedder ready.")
        case "flow_started":
            // Don't append "started" events to the visible log — they
            // come in pairs with `completed` and would double the
            // chatter. The completed event is the one users care about.
            return
        case "flow_completed":
            requestCount += 1
            let masked = (event["masked"] as? Int) ?? 0
            let host   = (event["host"]   as? String) ?? ""
            let ms     = (event["ms"]     as? Int) ?? 0
            let status = (event["status"] as? Int) ?? 0
            maskedTotal += masked
            let summary = FlowSummary(
                host:    host,
                masked:  masked,
                ms:      ms,
                status:  status,
                success: (200..<300).contains(status),
                when:    Date(),
            )
            recentFlows.insert(summary, at: 0)
            if recentFlows.count > 32 { recentFlows.removeLast(recentFlows.count - 32) }
            appendEvent("\(host) → \(status) · 🔒 \(masked) · \(ms)ms")
        case "flow_error":
            requestCount += 1
            let host  = (event["host"]  as? String) ?? ""
            let error = (event["error"] as? String) ?? "unknown"
            let summary = FlowSummary(
                host:    host,
                masked:  0,
                ms:      0,
                status:  0,
                success: false,
                when:    Date(),
            )
            recentFlows.insert(summary, at: 0)
            if recentFlows.count > 32 { recentFlows.removeLast(recentFlows.count - 32) }
            appendEvent("\(host) → error: \(error)")
        default:
            // Forward-compatible: unknown event types from a newer
            // helper don't break the consumer, just get logged.
            appendEvent("event \(type)")
        }
    }

    // MARK: - Helpers

    func appendEvent(_ msg: String) {
        let timestamp = ISO8601DateFormatter().string(from: Date())
        lastEvents.insert("\(timestamp) — \(msg)", at: 0)
        if lastEvents.count > 32 { lastEvents.removeLast(lastEvents.count - 32) }
    }
}

enum SciError: LocalizedError {
    case helperMissing
    case helperUnresponsive

    var errorDescription: String? {
        switch self {
        case .helperMissing:
            return "sci-helper binary not found in app bundle"
        case .helperUnresponsive:
            return "sci-helper did not respond on control socket"
        }
    }
}
