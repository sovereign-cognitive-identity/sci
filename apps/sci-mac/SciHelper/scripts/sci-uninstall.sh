#!/usr/bin/env bash
# sci-uninstall — return the machine to a pre-Sci state for clean
# test-reset cycles. Removes everything `brew install sci` and
# `sci-helper --setup` would have installed/configured, in the right
# order so launchd doesn't restart the process under us.
#
# This is the destructive sibling of `sci-undo.sh`. Use sci-undo to
# recover a confused dev environment; use sci-uninstall when you want
# the machine to look like Sci was never installed.
#
# Usage:
#   ./sci-uninstall.sh             # prompts before each destructive step
#   ./sci-uninstall.sh --yes       # no prompts
#   ./sci-uninstall.sh --keep-tap  # leave the homebrew tap installed
#   ./sci-uninstall.sh --keep-data # preserve ~/.sci (OAuth, memory, keys, CA)
#   ./sci-uninstall.sh --keep-zshrc # don't edit ~/.zshrc
#   ./sci-uninstall.sh --help
#
# What this does (in order):
#   1. brew services stop sci         — must precede pkill or launchd
#                                        will restart the process under us
#                                        (KeepAlive=true in the plist).
#   2. pkill any non-brew sci-helper  — catches manual `--proxy` instances.
#   3. brew uninstall sci             — removes the formula's installed
#                                        binary and var/log dir.
#   4. brew untap (unless --keep-tap) — removes the tap so the next
#                                        install exercises the tap fetch.
#   5. Remove ~/Library/LaunchAgents/com.sci.helper.plist (the plist
#      written by interactive `--setup`; not the brew-managed one).
#   6. Remove the sci-managed export block from ~/.zshrc — both the
#      paired-marker (0.5.1+) and legacy (0.5.0) formats. Writes a
#      timestamped backup first.
#   7. Remove `~/.sci/` (unless --keep-data) — OAuth token, credentials,
#      memory DB, CA files, embedding model cache.
#   8. Remove the Sci local CA from the macOS keychain (system + login
#      both checked). Needs sudo for the system keychain.
#
# What this cannot fix (printed at the end as a checklist):
#   - Env vars already exported in shells you opened before running this
#     (close those shells or `unset` manually).
#   - Postman / Insomnia / Bruno proxy settings (per-app config).

set -uo pipefail

YES_ALL=false
KEEP_TAP=false
KEEP_DATA=false
KEEP_ZSHRC=false
for arg in "$@"; do
    case "$arg" in
        --yes|-y)        YES_ALL=true ;;
        --keep-tap)      KEEP_TAP=true ;;
        --keep-data)     KEEP_DATA=true ;;
        --keep-zshrc)    KEEP_ZSHRC=true ;;
        -h|--help)
            sed -n '2,35p' "$0" | sed 's|^# \{0,1\}||'
            exit 0
            ;;
        *) echo "unknown arg: $arg"; exit 2 ;;
    esac
done

cyan()   { printf '\033[36m%s\033[0m' "$*"; }
green()  { printf '\033[32m%s\033[0m' "$*"; }
yellow() { printf '\033[33m%s\033[0m' "$*"; }
red()    { printf '\033[31m%s\033[0m' "$*"; }
dim()    { printf '\033[2m%s\033[0m' "$*"; }

confirm() {
    if $YES_ALL; then return 0; fi
    local prompt="$1"
    printf '%s [y/N]: ' "$prompt"
    local ans=""
    read -r ans
    [[ "$ans" =~ ^[Yy]$ ]]
}

have() { command -v "$1" >/dev/null 2>&1; }

TAP=sovereign-cognitive-identity/tap

echo
cyan "── 1. brew services stop sci ──────────────────────────────"; echo
if have brew && brew services list 2>/dev/null | grep -qE '^sci\s'; then
    if brew services stop sci >/dev/null 2>&1; then
        green "  stopped"; echo
    else
        yellow "  brew services stop returned non-zero (may already be stopped)"; echo
    fi
else
    printf '  '; dim "not registered with brew services"; echo
fi

echo
cyan "── 2. Kill any remaining sci-* processes ──────────────────"; echo
for proc in sci-helper sci-tail sci-oauth-cli; do
    if pgrep -x "$proc" >/dev/null 2>&1; then
        printf '  killing %s … ' "$proc"
        pkill -x "$proc" 2>/dev/null
        sleep 0.3
        if pgrep -x "$proc" >/dev/null 2>&1; then
            pkill -9 -x "$proc" 2>/dev/null
            sleep 0.2
        fi
        if pgrep -x "$proc" >/dev/null 2>&1; then
            red "still alive (manual kill needed)"; echo
        else
            green "done"; echo
        fi
    else
        printf '  %s … ' "$proc"
        dim "not running"; echo
    fi
done

echo
cyan "── 3. brew uninstall sci ──────────────────────────────────"; echo
if have brew && brew list sci >/dev/null 2>&1; then
    if confirm "  uninstall the sci formula?"; then
        brew uninstall sci 2>&1 | sed 's/^/    /'
        green "  uninstalled"; echo
    else
        dim "  skipped"; echo
    fi
else
    printf '  '; dim "sci formula not installed"; echo
fi

echo
cyan "── 4. brew untap $TAP ──"; echo
if $KEEP_TAP; then
    dim "  --keep-tap set; leaving tap in place"; echo
elif have brew && brew tap 2>/dev/null | grep -qx "$TAP"; then
    if confirm "  remove the $TAP tap?"; then
        brew untap "$TAP" 2>&1 | sed 's/^/    /'
        green "  untapped"; echo
    else
        dim "  skipped"; echo
    fi
else
    printf '  '; dim "tap not present"; echo
fi

echo
cyan "── 5. Launchd plist (interactive --setup install) ─────────"; echo
PLIST="$HOME/Library/LaunchAgents/com.sci.helper.plist"
if [[ -f "$PLIST" ]]; then
    if confirm "  unload + remove $PLIST?"; then
        launchctl unload "$PLIST" 2>/dev/null || true
        rm -f "$PLIST"
        green "  removed"; echo
    else
        dim "  kept"; echo
    fi
else
    printf '  '; dim "not present"; echo
fi

echo
cyan "── 6. Strip sci-managed block from ~/.zshrc ───────────────"; echo
ZSHRC="$HOME/.zshrc"
if $KEEP_ZSHRC; then
    dim "  --keep-zshrc set; leaving ~/.zshrc untouched"; echo
elif [[ -f "$ZSHRC" ]]; then
    if grep -qE '^# >>> sci-helper --setup >>>|^# Added by sci-helper --setup' "$ZSHRC"; then
        BACKUP="${ZSHRC}.sci-uninstall-backup-$(date +%Y%m%d-%H%M%S)"
        if confirm "  rewrite ~/.zshrc (backup: $BACKUP)?"; then
            cp "$ZSHRC" "$BACKUP"
            # Strip both formats. State machine:
            #   - inside a paired block (BEGIN seen, END not yet): drop
            #   - just past a LEGACY marker: drop our three known exports
            #   - otherwise: print
            awk '
                /^# >>> sci-helper --setup >>>/ { in_paired = 1; next }
                in_paired && /^# <<< sci-helper --setup <<</ { in_paired = 0; next }
                in_paired { next }
                /^# Added by sci-helper --setup/ { legacy = 1; next }
                legacy && /^export (HTTPS_PROXY|NODE_EXTRA_CA_CERTS|NO_PROXY)=/ { next }
                legacy { legacy = 0 }
                { print }
            ' "$BACKUP" > "$ZSHRC"
            green "  rewrote ~/.zshrc"; echo
            dim   "    backup at $BACKUP"; echo
        else
            dim "  skipped"; echo
        fi
    else
        printf '  '; dim "no sci-managed block found"; echo
    fi
else
    printf '  '; dim "~/.zshrc not present"; echo
fi

echo
cyan "── 7. Remove ~/.sci/ ──────────────────────────────────────"; echo
if $KEEP_DATA; then
    dim "  --keep-data set; preserving ~/.sci/"; echo
elif [[ -d "$HOME/.sci" ]]; then
    if confirm "  rm -rf ~/.sci/ (wipes OAuth, credentials, memory, CA, model cache)?"; then
        rm -rf "$HOME/.sci"
        green "  removed"; echo
    else
        dim "  kept"; echo
    fi
else
    printf '  '; dim "not present"; echo
fi

echo
cyan "── 8. Remove Sci CA from macOS keychain ───────────────────"; echo
CA_FOUND=false
for keychain in /Library/Keychains/System.keychain "$HOME/Library/Keychains/login.keychain-db"; do
    if security find-certificate -c 'Sci local CA' "$keychain" >/dev/null 2>&1; then
        CA_FOUND=true
        if confirm "  delete 'Sci local CA' from $keychain? (sudo required for system)"; then
            if [[ "$keychain" == /Library/* ]]; then
                sudo security delete-certificate -c 'Sci local CA' "$keychain" 2>&1 | sed 's/^/    /'
            else
                security delete-certificate -c 'Sci local CA' "$keychain" 2>&1 | sed 's/^/    /'
            fi
        else
            dim "  skipped $keychain"; echo
        fi
    fi
done
if ! $CA_FOUND; then
    printf '  '; dim "no 'Sci local CA' entries found"; echo
fi

echo
green "── Done. ──────────────────────────────────────────────────"; echo
echo "Manual cleanup this script can't do:"
echo "  - Close any shells opened before this run (they still have"
echo "    HTTPS_PROXY / NODE_EXTRA_CA_CERTS / NO_PROXY exported)."
echo "  - Postman / Insomnia / Bruno: Settings → Proxy → disable."
echo
echo "To verify a clean state:"
dim '    env | grep -iE "PROXY|SCI_" ; lsof -nP -iTCP:3001 -sTCP:LISTEN ; ls ~/.sci 2>/dev/null'; echo
