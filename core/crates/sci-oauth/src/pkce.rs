//! PKCE + state token generation. Matches Claude Code CLI sizes
//! (32-byte verifier, 32-byte state) byte-for-byte.

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::RngCore;
use sha2::{Digest, Sha256};

pub struct Pkce {
    pub code_verifier:  String,
    pub code_challenge: String,
    pub state:          String,
}

pub fn pkce() -> Pkce {
    let mut rng = rand::rng();

    let mut verifier_bytes = [0u8; 32];
    rng.fill_bytes(&mut verifier_bytes);
    let code_verifier = URL_SAFE_NO_PAD.encode(verifier_bytes);

    let mut hasher = Sha256::new();
    hasher.update(code_verifier.as_bytes());
    let challenge_bytes = hasher.finalize();
    let code_challenge = URL_SAFE_NO_PAD.encode(challenge_bytes);

    let mut state_bytes = [0u8; 32];
    rng.fill_bytes(&mut state_bytes);
    let state = URL_SAFE_NO_PAD.encode(state_bytes);

    Pkce {
        code_verifier,
        code_challenge,
        state,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_sizes_match_claude_code_cli() {
        let p = pkce();
        // 32 bytes of base64url with no padding = ceil(32 * 4 / 3) = 43 chars.
        assert_eq!(p.code_verifier.len(), 43, "verifier: {}", p.code_verifier);
        // SHA-256 → 32 bytes → 43 chars.
        assert_eq!(p.code_challenge.len(), 43);
        assert_eq!(p.state.len(), 43);
    }

    #[test]
    fn pkce_challenge_is_sha256_of_verifier() {
        let p = pkce();
        let mut h = Sha256::new();
        h.update(p.code_verifier.as_bytes());
        let expected = URL_SAFE_NO_PAD.encode(h.finalize());
        assert_eq!(p.code_challenge, expected);
    }

    #[test]
    fn pkce_yields_different_values_per_call() {
        // Sanity: CSPRNG, not a fixed seed.
        let a = pkce();
        let b = pkce();
        assert_ne!(a.code_verifier, b.code_verifier);
        assert_ne!(a.state, b.state);
    }
}
