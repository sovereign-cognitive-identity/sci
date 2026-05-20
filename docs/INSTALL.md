# Sci — Installation Troubleshooting

This guide covers the six most common problems after a fresh install. Each entry gives the symptom, the cause, and the fix.

---

## 1. CA not trusted — curl fails with certificate error

**Symptom:**

```
curl: (60) SSL certificate problem: unable to get local issuer certificate
```

or in Python:

```
ssl.SSLCertVerificationError: [SSL: CERTIFICATE_VERIFY_FAILED]
```

**Cause:** The Sci local CA has not been added to the macOS system keychain, or it was added but the trust setting was not set to "Always Trust."

**Fix:**

```bash
sci-helper --trust-ca
```

This adds `~/.sci/ca.crt` to the System keychain with full trust. It requires your password (it calls `security add-trusted-cert` under the hood). After it completes, open a new terminal and retry. You should not need to restart the proxy.

If you want to do it manually:

```bash
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain ~/.sci/ca.crt
```

**Verify:**

```bash
curl -v https://api.anthropic.com/v1/models 2>&1 | grep "SSL connection"
# Should print: SSL connection using TLSv1.3 / ...
```

---

## 2. HTTPS_PROXY set but proxy not running — connection refused

**Symptom:**

```
curl: (7) Failed to connect to 127.0.0.1 port 3001 after 0 ms: Connection refused
```

or `brew update` / `brew install` fails with:

```
Error: fetching /opt/homebrew failed on port 3001
```

**Cause:** `HTTPS_PROXY` is set in your shell, but `sci-helper` is not running. This also affects `brew` itself — if sci-helper isn't up yet when `brew update` runs, brew's git fetch fails.

**Fix:**

Ensure `NO_PROXY` excludes brew and git hosting from the proxy. Add this to your `~/.zshrc` (or run `sci-helper --setup` again — it now writes this automatically):

```bash
export NO_PROXY=localhost,127.0.0.1,*.brew.sh,formulae.brew.sh,raw.githubusercontent.com,objects.githubusercontent.com
```

Then start the proxy and re-run brew:

```bash
brew services start sci
brew update && brew upgrade sci
```

If brew commands still fail before the service is running, temporarily bypass:

```bash
unset HTTPS_PROXY && brew update && export HTTPS_PROXY=http://localhost:3001
```

If it was never started:

```bash
brew services start sci
```

If it was started but immediately crashed, check the logs:

```bash
brew services log sci
# or
tail -50 ~/Library/Logs/sci/sci-helper.log
```

**Temporary workaround** while diagnosing: unset `HTTPS_PROXY` in your current shell so requests go directly to providers. Do not leave this unset permanently — you will lose the privacy guarantee.

```bash
unset HTTPS_PROXY
unset ANTHROPIC_BASE_URL
```

---

## 3. First run takes a long time — BGE model downloading

**Symptom:** The proxy starts but the first request hangs for 30–120 seconds. The log shows:

```
INFO  sci-helper starting
INFO  loading embedding model (first run will download ~110 MB)
```

...and nothing for a while.

**Cause:** On first run, `sci-helper` downloads the `BAAI/bge-base-en-v1.5` embedding model (~110 MB) from HuggingFace and caches it at `~/.sci/models/bge-base-en-v1.5/`. This happens once. Subsequent starts are sub-second (the model is already on disk).

**Fix:** Wait. The download progress is visible in the logs:

```bash
brew services log sci
```

Once you see `INFO  embedding model ready`, the proxy is fully up and the first request will go through.

**If HuggingFace is unreachable** (corporate network, firewall, etc.): pre-stage the model files and set `SCI_MODEL_CACHE_DIR` to point at the directory:

```bash
export SCI_MODEL_CACHE_DIR=/path/to/staged/models
```

The model directory should contain `config.json`, `tokenizer.json`, and the weight file. Contact the repo maintainer for a pre-packaged tarball if needed.

---

## 4. Credentials not found — proxy running but getting 401 from provider

**Symptom:** Requests go through the proxy but the provider returns 401 Unauthorized. The Sci log shows:

```
WARN  no credentials found for host api.anthropic.com
```

**Cause:** `~/.sci/credentials.env` does not exist, is missing the relevant key, or was not reloaded after a change.

**Fix:**

Run setup to create or update the credentials file interactively:

```bash
sci-helper --setup
```

Or edit `~/.sci/credentials.env` directly. The format is standard shell variable assignment:

```bash
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
```

After editing, reload the credentials without restarting the proxy:

```bash
# Send a reload signal via the admin API
curl -s http://127.0.0.1:3002/reload-credentials
```

Or restart the proxy:

```bash
brew services restart sci
```

**Check what keys are loaded:**

```bash
curl -s http://127.0.0.1:3002/status | jq .credentials
```

This shows which providers have keys configured (key values are not returned, only provider names and whether a key is present).

---

## 5. launchd not starting — plist permissions or path issues

**Symptom:** `brew services start sci` returns success, but the proxy is not running after a restart. `brew services list` shows `sci  stopped` or `sci  error`.

**Cause:** The launchd plist references the wrong path for `sci-helper`, or the plist file has incorrect permissions.

**Fix:**

Find the plist:

```bash
ls ~/Library/LaunchAgents/com.cognitive-os.sci*.plist
```

Check that the `ProgramArguments` path points to the actual binary:

```bash
plutil -p ~/Library/LaunchAgents/com.cognitive-os.sci.plist | grep Program
```

Find the actual binary location:

```bash
which sci-helper
# typically /opt/homebrew/bin/sci-helper on Apple Silicon
# or /usr/local/bin/sci-helper on Intel
```

If the path is wrong, regenerate the plist by running setup again:

```bash
sci-helper --setup
```

Check plist permissions (launchd requires the file to be owned by root or the current user, not group-writable):

```bash
ls -la ~/Library/LaunchAgents/com.cognitive-os.sci.plist
# Should be: -rw-r--r--  1 yourname  staff  ...
```

If permissions are wrong:

```bash
chmod 644 ~/Library/LaunchAgents/com.cognitive-os.sci.plist
```

Reload:

```bash
launchctl unload ~/Library/LaunchAgents/com.cognitive-os.sci.plist
launchctl load   ~/Library/LaunchAgents/com.cognitive-os.sci.plist
```

Check for errors:

```bash
launchctl error $(launchctl list | grep sci | awk '{print $1}')
```

---

## 6. Claude Code still hitting api.anthropic.com directly — ANTHROPIC_BASE_URL vs HTTPS_PROXY

**Symptom:** `sci-helper --verify` passes, but Claude Code requests are not going through the proxy. Your real name is appearing in provider logs, or the memory injection is not working.

**Cause:** Claude Code checks `ANTHROPIC_BASE_URL` first, then falls back to the Anthropic SDK default. If `ANTHROPIC_BASE_URL` is not set in the environment that Claude Code inherits, it bypasses `HTTPS_PROXY` and goes directly to `api.anthropic.com`.

These are two separate mechanisms:
- `HTTPS_PROXY` is respected by curl, Python `requests`, and most HTTP clients as a generic proxy setting
- `ANTHROPIC_BASE_URL` is checked by the Anthropic SDK specifically and overrides the base URL for all API calls

Claude Code uses the Anthropic SDK internally, so you need `ANTHROPIC_BASE_URL` set.

**Fix:**

Ensure both variables are in your shell profile (`~/.zshrc` or `~/.bashrc`):

```bash
export HTTPS_PROXY=http://127.0.0.1:3001
export ANTHROPIC_BASE_URL=http://127.0.0.1:3001
```

Source the profile in your current shell:

```bash
source ~/.zshrc
```

Confirm Claude Code inherits them. If you launch Claude Code from a GUI (Dock, Spotlight), it may not inherit terminal environment variables. Launch it from a terminal instead:

```bash
claude
```

**Verify the variable is set inside Claude Code:**

Ask Claude Code to run:

```bash
echo $ANTHROPIC_BASE_URL
```

It should print `http://127.0.0.1:3001`. If it prints nothing, the environment is not being inherited. In that case, set the variables in `~/.profile` or `~/.zprofile` (which are sourced for login shells and GUI-launched apps on macOS) in addition to `~/.zshrc`.
