#!/usr/bin/env bash
# sci-undo — fully revert any local Sci dev-proxy state.
#
# Run this if Sci is in a confused state and Claude Code / your daily
# tools have stopped working. It's safe to run any time — every step
# is idempotent and prints what it did.
#
# Usage:
#     ./scripts/sci-undo.sh
#         (prompts before destructive steps)
#
#     ./scripts/sci-undo.sh --yes
#         (no prompts; useful for "just put me back")
#
# What this DOES (auto):
#   • Kills any running sci-helper / sci-tail processes.
#   • Verifies TCP port 3001 is free.
#   • Reports any leftover proxy env vars in your CURRENT shell.
#
# What this CANNOT do (printed as a checklist):
#   • Unset env vars in shells you already opened (env vars are
#     per-process; close those shells or `unset` manually).
#   • Reverse Postman / Insomnia / Bruno proxy settings (toggled in
#     each app's Settings → Proxy).
#   • Untrust the Sci CA from your keychain (it's harmless to leave;
#     command printed below if you want to remove it).
#
# What this OFFERS as optional cleanup (prompts):
#   • Delete `~/.sci/oauth.json` (logs you out of Claude Pro/Max OAuth).
#   • Delete `~/.sci/credentials.env` (wipes BYO API keys).
#   • Delete `~/.sci/memory/` (wipes recall DB).
#   • Delete `~/.sci/ca.crt` + `ca.key` (next launch will regenerate).

set -uo pipefail

YES_ALL=false
for arg in "$@"; do
    case "$arg" in
        --yes|-y) YES_ALL=true ;;
        -h|--help)
            sed -n '2,29p' "$0" | sed 's|^# \{0,1\}||'
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

# Ask a yes/no, default-no. Honors --yes (always-yes mode).
confirm() {
    if $YES_ALL; then return 0; fi
    local prompt="$1"
    printf '%s [y/N]: ' "$prompt"
    local ans=""
    read -r ans
    [[ "$ans" =~ ^[Yy]$ ]]
}

echo
cyan "── 1. Stopping Sci processes ───────────────────────────────"; echo
for proc in sci-helper sci-tail sci-oauth-cli; do
    if pgrep -x "$proc" >/dev/null 2>&1; then
        printf '  killing %s … ' "$proc"
        pkill -x "$proc" 2>/dev/null
        sleep 0.3
        if pgrep -x "$proc" >/dev/null 2>&1; then
            # Stubborn — try SIGKILL.
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
cyan "── 2. Verifying ports / sockets ────────────────────────────"; echo
if lsof -nP -iTCP:3001 -sTCP:LISTEN >/dev/null 2>&1; then
    red "  TCP :3001 still in use:"; echo
    lsof -nP -iTCP:3001 -sTCP:LISTEN
    echo "  → kill the offending process by PID, then re-run this script."
else
    printf '  TCP :3001 … '; green "free"; echo
fi
SOCK="$HOME/.sci/helper.sock"
if [[ -S "$SOCK" ]]; then
    if confirm "  remove stale unix socket $SOCK?"; then
        rm -f "$SOCK"
        green "    removed"; echo
    fi
else
    printf '  helper.sock … '; dim "absent"; echo
fi

echo
cyan "── 3. Checklist this script CAN'T auto-undo ────────────────"; echo

# Detect what env vars are set in the calling shell. Best-effort —
# this script runs in its own subshell, so env detection here only
# sees things exported up to it.
problem_envs=()
for v in HTTPS_PROXY https_proxy HTTP_PROXY http_proxy NODE_EXTRA_CA_CERTS \
         SSL_CERT_FILE REQUESTS_CA_BUNDLE; do
    val="${!v:-}"
    if [[ -n "$val" ]] && [[ "$val" == *3001* || "$val" == *.sci/ca.crt* ]]; then
        problem_envs+=("$v=$val")
    fi
done

if (( ${#problem_envs[@]} > 0 )); then
    yellow "  Sci-related env vars detected in this shell:"; echo
    for e in "${problem_envs[@]}"; do echo "    $e"; done
    echo
    echo "  To clear them in EVERY shell you opened during testing, either:"
    echo "    • Close those shell windows, or"
    echo "    • Run in each one:"
    yellow "        unset HTTPS_PROXY https_proxy NODE_EXTRA_CA_CERTS SSL_CERT_FILE REQUESTS_CA_BUNDLE"; echo
else
    printf '  this shell\047s env vars … '; green "clean"; echo
fi

echo
echo "  Postman / Insomnia / Bruno: open Settings → Proxy and uncheck"
echo "    \"Use custom proxy configuration\". They DON'T inherit your shell env."
echo
echo "  Claude Code (running): if it was started with the proxy env vars"
echo "    exported, they're stuck for that process. Quit and relaunch from"
echo "    a clean shell."
echo
echo "  Sci CA in your macOS keychain (only if you ran TrustHelper or"
echo "    the system-trust install — most likely you didn't). To check + remove:"
dim "      security find-certificate -c 'Sci local CA' login.keychain"; echo
dim "      security delete-certificate -c 'Sci local CA' login.keychain"; echo

echo
cyan "── 4. Optional state cleanup ───────────────────────────────"; echo

if [[ -f "$HOME/.sci/oauth.json" ]]; then
    if confirm "  delete ~/.sci/oauth.json (logs out of Claude Pro/Max OAuth)?"; then
        rm -f "$HOME/.sci/oauth.json"
        green "    removed"; echo
    else
        dim "    kept"; echo
    fi
fi

if [[ -f "$HOME/.sci/credentials.env" ]]; then
    if confirm "  delete ~/.sci/credentials.env (wipes BYO API keys)?"; then
        rm -f "$HOME/.sci/credentials.env"
        green "    removed"; echo
    else
        dim "    kept"; echo
    fi
fi

if [[ -d "$HOME/.sci/memory" ]]; then
    if confirm "  delete ~/.sci/memory/ (wipes recall DB; large download avoided next launch)?"; then
        rm -rf "$HOME/.sci/memory"
        green "    removed"; echo
    else
        dim "    kept"; echo
    fi
fi

if [[ -f "$HOME/.sci/ca.crt" ]]; then
    if confirm "  delete ~/.sci/ca.crt + ca.key (regenerated on next launch — clients re-trust)?"; then
        rm -f "$HOME/.sci/ca.crt" "$HOME/.sci/ca.key"
        green "    removed"; echo
        yellow "    NOTE: any client that had this CA pinned (Postman, etc.) needs the new ca.crt next time."; echo
    else
        dim "    kept"; echo
    fi
fi

echo
green "── Done. ───────────────────────────────────────────────────"; echo
echo "If a tool is still misbehaving, the most common cause is:"
echo "  1. The tool's config still points at 127.0.0.1:3001 (Postman/Bruno proxy setting)."
echo "  2. The tool's process started before you cleaned env vars (relaunch it)."
echo
