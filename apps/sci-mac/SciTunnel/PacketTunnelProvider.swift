// TransparentProxyProvider.swift — system-extension half of the macOS app.
//
// File name preserved from SCI-127 phase 1 to avoid project.pbxproj
// surgery. The class inside is `TransparentProxyProvider` per Info.plist's
// NSExtensionPrincipalClass, and inherits from `NETransparentProxyProvider`
// rather than the phase-1 `NEPacketTunnelProvider`.
//
// Why the change (SCI-134):
//
//   Packet-tunnel mode hands us raw IP packets — we'd have to reassemble
//   TCP, track flow state, route by IP. AI-host IPs are CDN-fronted (and
//   change), so IP routing is a constant-maintenance loss. Transparent
//   proxy mode lets us register hostname-based NENetworkRules — the OS
//   intercepts at flow-create time, gives us a TCP-stream-shaped
//   `NEAppProxyTCPFlow`, and we just shuffle bytes between that flow and
//   the helper's Unix socket. The helper does TLS termination + handler
//   dispatch on its side. No IP/TCP plumbing on this side.
//
// Lifecycle:
//
//   1. SciEngine builds an NETunnelProviderManager configured with our
//      bundle ID + a set of NENetworkRules for the AI hostnames; saves
//      to system preferences (triggers OS NE permission dialog on first
//      use); then `startVPNTunnel()`.
//   2. The OS loads us as a sibling process, calls `startProxy(...)`.
//      We acknowledge.
//   3. For each TCP flow that matches a registered rule, the OS calls
//      `handleNewFlow(_:)`. We open a fresh Unix socket connection to
//      the helper, write the JSON header (hostname:port:sni), then
//      bidirectionally bridge bytes between the flow and the socket.
//   4. Helper terminates TLS, dispatches via sci-handlers, encrypts the
//      response back through the same TLS session, writes encrypted
//      bytes to the socket. We forward those bytes back to the flow.
//   5. Either side EOF (flow close, helper hangup) tears the bridge
//      down cleanly.

import Foundation
import Network
import NetworkExtension
import OSLog

final class TransparentProxyProvider: NETransparentProxyProvider {

    private let log = Logger(subsystem: "com.sci.mac.tunnel", category: "tpp")

    /// Resolved at startTunnel() from providerConfiguration. Each new
    /// flow opens its own connection to this socket — the helper spawns
    /// a fresh task per session.
    private var helperSocketPath = ""

    /// SCI-144: the host app's bundle identifier. Flows whose source
    /// signing identity matches this are NOT intercepted — we let the
    /// OS route them normally. This prevents a recursion that would
    /// otherwise hang the entire AI traffic flow:
    ///
    ///   real client → NE intercepts → helper handles → helper opens
    ///   upstream TCP → NE intercepts (matches the same hostname rule)
    ///   → helper handles → helper opens upstream → ... loop forever.
    ///
    /// The exclusion catches both the helper process (signed under
    /// the host's bundle identity since it's a child of the .app) and
    /// any debug HTTP from the host app itself. Set by the host app
    /// via providerConfiguration; the .appex's own bundle ID is
    /// `<host>.tunnel` and isn't useful here.
    private var hostBundleId = ""

    // MARK: - Lifecycle

    override func startProxy(options: [String: Any]?,
                             completionHandler: @escaping (Error?) -> Void) {
        log.info("Sci transparent proxy starting")

        // The containing app passes the helper socket path + the host
        // app's bundle ID through providerConfiguration; fall back
        // sanely for developer-side `sudo` runs.
        let cfg = (self.protocolConfiguration as? NETunnelProviderProtocol)?
            .providerConfiguration
        let configured = cfg?["helperSocket"] as? String
        let home = ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory()
        helperSocketPath = configured ?? "\(home)/.sci/helper.sock"
        // SCI-144: anti-recursion exclusion. The .appex's own bundle ID
        // ends in `.tunnel`; strip it to recover the host's, which is
        // what the helper signs as.
        if let provided = cfg?["hostBundleId"] as? String, !provided.isEmpty {
            hostBundleId = provided
        } else {
            // Best-effort fallback: derive from our own bundle ID by
            // dropping the `.tunnel` suffix. Only used if the app
            // didn't pass one.
            let mine = Bundle.main.bundleIdentifier ?? ""
            hostBundleId = mine.hasSuffix(".tunnel")
                ? String(mine.dropLast(".tunnel".count))
                : mine
        }
        log.info("Helper socket: \(self.helperSocketPath, privacy: .public)")
        log.info("Host bundle ID (excluded from capture): \(self.hostBundleId, privacy: .public)")

        // No tunnel settings to configure — NETransparentProxyProvider
        // doesn't take an IP/MTU. The OS uses the NENetworkRule set
        // from providerConfiguration to decide which flows to send us.
        completionHandler(nil)
    }

    override func stopProxy(with reason: NEProviderStopReason,
                            completionHandler: @escaping () -> Void) {
        log.info("Sci transparent proxy stopping (reason \(reason.rawValue, privacy: .public))")
        completionHandler()
    }

    // MARK: - Per-flow handling

    /// Apple calls this for every new TCP/UDP flow that matches one of
    /// our registered NENetworkRules. Return `true` to claim the flow
    /// (we drive its bytes thereafter); `false` to let the OS handle it
    /// normally. UDP flows from rules we ever set up shouldn't reach us
    /// in v0.5 — return `false` if we ever see one.
    override func handleNewFlow(_ flow: NEAppProxyFlow) -> Bool {
        // SCI-144 — exclude self-traffic. NE rules are hostname-based and
        // apply system-wide, so without this check the helper's *own*
        // outbound to api.anthropic.com (forwarding the user's request)
        // gets caught by the same rule, fed back into the helper, which
        // forwards again, recursing until the process hangs. The host
        // app + helper share a signing identity (helper inherits via
        // its parent .app's signature) so a single bundle-ID check
        // covers both.
        let sourceID = flow.metaData.sourceAppSigningIdentifier
        if !sourceID.isEmpty && !hostBundleId.isEmpty && sourceID == hostBundleId {
            log.debug("Skipping own-process flow from \(sourceID, privacy: .public)")
            return false
        }

        guard let tcp = flow as? NEAppProxyTCPFlow else {
            log.notice("Non-TCP flow rejected (UDP not handled in v0.5)")
            return false
        }

        // Hostname-based NENetworkRules cause the OS to populate
        // `remoteHostname`. If it's missing, the flow came from somewhere
        // we don't know how to route safely — reject so the OS handles
        // it normally rather than silently dropping the connection.
        guard let hostname = tcp.remoteHostname, !hostname.isEmpty else {
            log.notice("Flow without remoteHostname rejected")
            return false
        }
        // We only register port-443 rules in SciEngine, so the port is
        // implicit. Keeping it as a parameter so the bridge logs are
        // explicit + the helper protocol carries the authoritative value.
        let port = "443"

        log.info("New flow: \(hostname, privacy: .public):\(port, privacy: .public)")

        // `open(withLocalEndpoint:)` is deprecated on macOS 15+ in
        // favor of a no-arg variant that doesn't exist on our minimum
        // (14.0). Keep the deprecated form behind an awareness comment;
        // the warning will go quiet when we bump LSMinimumSystemVersion.
        // Wrap in a Task so we can return synchronously from
        // handleNewFlow.
        Task { [weak self] in
            guard let self else { return }
            do {
                try await tcp.open(withLocalEndpoint: nil)
                self.bridge(flow: tcp, hostname: hostname, port: port)
            } catch {
                self.log.error("Flow open failed: \(error.localizedDescription, privacy: .public)")
                tcp.closeReadWithError(error)
                tcp.closeWriteWithError(error)
            }
        }
        return true
    }

    // MARK: - Flow ↔ helper bridge

    /// Open a Unix-domain socket to the helper, send the JSON header,
    /// then run two pumps: one shoveling bytes flow → socket, the other
    /// socket → flow. Either side EOF tears the whole thing down.
    private func bridge(flow: NEAppProxyTCPFlow, hostname: String, port: String) {
        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else {
            log.error("socket() failed: \(String(cString: strerror(errno)), privacy: .public)")
            flow.closeReadWithError(NSError(domain: "sci.tunnel", code: 1))
            flow.closeWriteWithError(NSError(domain: "sci.tunnel", code: 1))
            return
        }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = helperSocketPath.utf8CString
        guard pathBytes.count <= MemoryLayout.size(ofValue: addr.sun_path) else {
            log.error("Helper socket path too long")
            Darwin.close(fd)
            return
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
        guard connectResult == 0 else {
            log.error("Helper connect failed: \(String(cString: strerror(errno)), privacy: .public)")
            Darwin.close(fd)
            flow.closeReadWithError(NSError(domain: "sci.tunnel", code: 2))
            flow.closeWriteWithError(NSError(domain: "sci.tunnel", code: 2))
            return
        }

        // ── 1. Header ──────────────────────────────────────────────────
        // One-line JSON the helper reads first to know the destination.
        // Newline-terminated so the helper can read it with `lines()`.
        let header: [String: Any] = [
            "kind":     "flow",
            "hostname": hostname,
            "port":     Int(port) ?? 443,
            // The SNI the OS gave us is the same string as `hostname`
            // for the AI host case. Sending it explicitly anyway so the
            // helper-side log shows what client really requested.
            "sni":      hostname,
        ]
        guard let headerBytes = try? JSONSerialization.data(withJSONObject: header)
                .appending(byte: 0x0A /* \n */) else {
            log.error("Header JSON encode failed")
            Darwin.close(fd); return
        }
        _ = headerBytes.withUnsafeBytes { ptr in
            Darwin.send(fd, ptr.baseAddress, headerBytes.count, 0)
        }

        // ── 2. Two-direction byte pumps ───────────────────────────────
        // The flow's read/write are async with completion handlers; the
        // socket reads/writes are blocking (the kernel does flow control
        // for us). We dispatch each pump onto its own queue so they run
        // independently.

        // flow → helper
        startFlowToSocket(flow: flow, fd: fd)
        // helper → flow
        startSocketToFlow(flow: flow, fd: fd)
    }

    private func startFlowToSocket(flow: NEAppProxyTCPFlow, fd: Int32) {
        flow.readData { [weak self] data, error in
            guard let self else { return }
            if let error {
                self.log.debug("flow.readData err: \(error.localizedDescription, privacy: .public)")
                Darwin.shutdown(fd, Int32(SHUT_WR))
                return
            }
            guard let data, !data.isEmpty else {
                // Client closed write half. Half-close the helper-side
                // write so the helper sees EOF on its read half — its
                // TLS session will then drain its own writes and close
                // cleanly.
                Darwin.shutdown(fd, Int32(SHUT_WR))
                return
            }
            let n = data.withUnsafeBytes { ptr in
                Darwin.send(fd, ptr.baseAddress, data.count, 0)
            }
            if n < 0 {
                self.log.warning("send to helper failed: \(String(cString: strerror(errno)), privacy: .public)")
                flow.closeReadWithError(NSError(domain: "sci.tunnel", code: 3))
                return
            }
            // Recurse for next chunk. NE's readData is one-shot per call.
            self.startFlowToSocket(flow: flow, fd: fd)
        }
    }

    private func startSocketToFlow(flow: NEAppProxyTCPFlow, fd: Int32) {
        // Read from the socket on a background queue so we don't block
        // the NE main thread. tokio-style async wrapping via DispatchIO
        // would be cleaner; raw recv() in a loop is simpler for v0.5.
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            var buf = [UInt8](repeating: 0, count: 16 * 1024)
            while true {
                let n = buf.withUnsafeMutableBufferPointer { ptr in
                    Darwin.recv(fd, ptr.baseAddress, ptr.count, 0)
                }
                if n <= 0 {
                    // Helper closed (EOF or error). Half-close flow.
                    flow.closeWriteWithError(nil)
                    Darwin.close(fd)
                    return
                }
                let chunk = Data(bytes: buf, count: n)
                let semaphore = DispatchSemaphore(value: 0)
                var writeError: Error?
                flow.write(chunk) { err in
                    writeError = err
                    semaphore.signal()
                }
                semaphore.wait()
                if let writeError {
                    self.log.warning("flow.write err: \(writeError.localizedDescription, privacy: .public)")
                    Darwin.close(fd)
                    return
                }
            }
        }
    }
}

// Small helper so the JSON header can append a newline cleanly.
private extension Data {
    func appending(byte: UInt8) -> Data {
        var copy = self
        copy.append(byte)
        return copy
    }
}
