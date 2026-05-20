// TrustHelper.swift — read the Sci CA from disk, compute its
// SHA-256 fingerprint, and (on user request) install it into the
// user keychain as a trusted root for SSL.
//
// We use SecCertificateCreateWithData + SecTrustSettingsSetTrustSettings,
// the modern Security.framework path. SecTrustSettingsSetTrustSettings
// triggers an OS authentication prompt because it modifies the user's
// trust store — exactly the consent moment the v0.5 UX wants.
//
// Phase 1 scope: install only. Removal + re-trust-after-rotation lives
// in SCI-135.

import Foundation
import Security
import CryptoKit

enum TrustHelper {

    /// SHA-256 of the DER-encoded cert, formatted "AB CD EF ..." to match
    /// what Keychain Access shows the user.
    static func fingerprint(of pemPath: URL) -> String? {
        guard let cert = readCertificate(at: pemPath) else { return nil }
        let data = SecCertificateCopyData(cert) as Data
        let digest = SHA256.hash(data: data)
        return digest.map { String(format: "%02X", $0) }.joined(separator: " ")
    }

    /// Install the CA at `pemPath` as a trusted SSL root in the user's
    /// keychain. Returns a short human-readable result string for the UI.
    static func trustCA(at pemPath: URL) -> String {
        guard let cert = readCertificate(at: pemPath) else {
            return "could not read CA cert"
        }

        // Trust setting: one entry, "use this CA as a root for SSL."
        // SecTrustSettingsSetTrustSettings takes either a CFDictionary
        // (single setting) or a CFArray of dicts (multiple). We send a
        // single-element array — clearer intent than the dict form.
        let entry: [String: Any] = [
            kSecTrustSettingsResult as String:  SecTrustSettingsResult.trustRoot.rawValue,
            kSecTrustSettingsPolicy as String:  SecPolicyCreateSSL(true, nil),
        ]
        let trustSettings: CFArray = [entry] as CFArray

        let status = SecTrustSettingsSetTrustSettings(
            cert,
            .user,
            trustSettings
        )

        switch status {
        case errSecSuccess:
            return "installed"
        case errSecUserCanceled:
            return "cancelled"
        case errSecAuthFailed:
            return "auth failed"
        default:
            return "Security.framework status \(status)"
        }
    }

    /// Read a single PEM certificate from disk and convert it into a
    /// SecCertificate. macOS's SecCertificateCreateWithData wants DER,
    /// so we strip the PEM armor and base64-decode.
    private static func readCertificate(at pemPath: URL) -> SecCertificate? {
        guard let pem = try? String(contentsOf: pemPath, encoding: .utf8) else { return nil }
        let lines = pem.split(separator: "\n")
        var inside = false
        var b64 = ""
        for line in lines {
            if line.contains("BEGIN CERTIFICATE") { inside = true; continue }
            if line.contains("END CERTIFICATE")   { break }
            if inside { b64 += line }
        }
        guard !b64.isEmpty, let der = Data(base64Encoded: b64) else { return nil }
        return SecCertificateCreateWithData(nil, der as CFData)
    }
}
