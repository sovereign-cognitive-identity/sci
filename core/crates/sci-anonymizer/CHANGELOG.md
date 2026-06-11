# Changelog

All notable changes to `sci-anonymizer` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this crate aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
once it reaches its first published release.

## Semver & support policy

- **Pre-1.0 (current):** minor versions may contain breaking API changes; patch
  versions are additive/bugfix only. Pin an exact version if you embed the crate.
- **Public API surface** under semver is everything re-exported from `lib.rs`:
  `anonymize`, `anonymize_with_custom`, `build_token_map`, `apply_token_map`,
  `deanonymize`, and the `Entity` / `EntityType` / `TokenMap` / `AnonymizeResult`
  / `SerializedSession` / `SessionError` types.
- **Session wire format** is versioned independently via `SESSION_FORMAT_VERSION`;
  a bump there is called out explicitly in this changelog.
- **MSRV:** Rust 1.95. Raising the MSRV is a minor-version change.

## [Unreleased]

### Added
- Versioned session-serialization format: `SerializedSession`,
  `SESSION_FORMAT_VERSION` (= 1), and `TokenMap::to_session_json` /
  `TokenMap::from_session_json`. Deserialization rejects newer, unsupported
  format versions rather than risk a silent mis-parse. (SCI-279)

### Changed
- Relicensed this crate to `Apache-2.0 OR MIT` (overriding the workspace
  BUSL-1.1) so it can be embedded as a standalone OSS component. (SCI-278)
