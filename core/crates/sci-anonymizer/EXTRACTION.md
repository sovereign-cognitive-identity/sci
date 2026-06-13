# SCI-Anonymizer Extraction Guide

This document describes the history-preserving extraction of `sci-anonymizer` from the Sci monorepo to a standalone repository at `sovereign-cognitive-identity/sci-anonymizer`.

## Overview

`sci-anonymizer` is a reversible entity anonymization library for LLM round-trips. This extraction preserves the full git history of the crate while separating it into an independently versioned, publishable crate.io package.

## Prerequisites

- `git-filter-repo` (installed via Homebrew on macOS: `brew install git-filter-repo`)
- Access to push to `sovereign-cognitive-identity/sci-anonymizer` repository

## Extraction Steps

### 1. Create the `export/sci-anonymizer` branch with history-only commits

From the monorepo root:

```bash
cd /path/to/sci/monorepo

# Create a new branch containing only the crate's history
git subtree split --prefix=core/crates/sci-anonymizer -b export/sci-anonymizer
```

This command:
- Extracts only commits that touched `core/crates/sci-anonymizer/`
- Creates a linear history in the new branch (rewritten commits, no merges)
- Preserves authorship and commit timestamps
- Takes ~5-10 seconds on modern hardware

**Verification:**

```bash
# Check the branch exists and has the expected structure
git checkout export/sci-anonymizer
ls -la
# Should show: Cargo.toml, LICENSE-APACHE, LICENSE-MIT, CHANGELOG.md, src/, tests/, examples/

# Check the commit count
git log --oneline | wc -l
```

### 2. Create a git bundle artifact

A `*.bundle` file is a portable, complete git repository snapshot suitable for archiving or transferring to the standalone repo.

```bash
# From the export branch
git bundle create sci-anonymizer.bundle export/sci-anonymizer
```

This creates a single file (`sci-anonymizer.bundle`) containing:
- All commits in `export/sci-anonymizer`
- All reachable objects
- The branch ref

**Optional: Archive alongside other Phase 1.1 artifacts** (commit this for auditing):

```bash
mkdir -p artifacts/extraction
mv sci-anonymizer.bundle artifacts/extraction/
git add artifacts/extraction/sci-anonymizer.bundle
git commit -m "artifact: export/sci-anonymizer git bundle (SCI-274)"
```

### 3. Initialize the standalone repository

Create a new repository at `sovereign-cognitive-identity/sci-anonymizer` on GitHub (or your git host).

```bash
# Clone it locally
git clone https://github.com/sovereign-cognitive-identity/sci-anonymizer.git
cd sci-anonymizer

# Unbundle the history
git bundle unbundle ../sci-anonymizer.bundle

# Set the export branch as the working tree
git checkout export/sci-anonymizer
git branch -m main  # Rename to main; adjust if your default differs
```

### 4. Configure and push

```bash
# Set the remote (in the standalone repo)
git remote add origin https://github.com/sovereign-cognitive-identity/sci-anonymizer.git
git remote set-url origin https://github.com/sovereign-cognitive-identity/sci-anonymizer.git

# (Optional) Verify the crate is self-contained
cargo build -p sci-anonymizer

# Push to remote
git push -u origin main

# Tag the initial release
git tag v0.1.0-alpha
git push origin v0.1.0-alpha
```

## Verification Checklist

After extraction, verify:

- [ ] Branch `export/sci-anonymizer` contains only `sci-anonymizer` history
- [ ] `git log export/sci-anonymizer` shows commits in chronological order
- [ ] All commits have proper authorship (no "extracted by robot" metadata)
- [ ] `sci-anonymizer.bundle` is a valid, self-contained bundle (run `git bundle verify`)
- [ ] Standalone repo builds: `cargo build` completes without errors
- [ ] Standalone repo tests: `cargo test` passes (includes SCI-195/196/197 parity tests)
- [ ] Crate.toml is self-contained (no path dependencies on `../../../` patterns)

## Undoing / Cleanup

If you need to re-extract or clean up:

```bash
# Delete the export branch (does NOT delete commits in other branches)
git branch -D export/sci-anonymizer

# Remove the bundle
rm sci-anonymizer.bundle

# To re-extract, simply run the subtree split again (idempotent)
git subtree split --prefix=core/crates/sci-anonymizer -b export/sci-anonymizer
```

## Notes on History Preservation

- **Commit authorship & dates**: Preserved exactly (not rewritten).
- **Merge commits**: The `subtree split` produces a linear history (merges are not included), which is appropriate for a crate with a single maintainer. If you need merge structure, use `git-filter-repo` instead (see Advanced section below).
- **Binary files**: Any binaries (e.g., generated assets) in the crate will be included; update `.gitignore` in the standalone repo as needed.

## Advanced: Using git-filter-repo for More Control

If you need to:
- Keep merge commit structure
- Filter additional paths
- Rewrite commit messages

Use `git-filter-repo`:

```bash
git filter-repo --subdirectory-filter=core/crates/sci-anonymizer \
  --refs=main \
  --force

# Then push:
git push --force origin main
```

**Caveat**: `git filter-repo` requires `--force` and rewrites history. Use only for initial extraction; do NOT use after the standalone repo is published.

## Cross-Language Binding Impact (Phase 1.2)

Once `sci-anonymizer` is published to crates.io, the monorepo will consume it as:

```toml
[dependencies]
sci-anonymizer = "0.1.0"  # No longer a path dependency
```

This allows Phase 1.2 (WASM + Python bindings) to build against the published crate without vendoring.

---

**See also:** `API.md` (SCI-275) for the stable public API contract.
