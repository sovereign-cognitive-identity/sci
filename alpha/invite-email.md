# Alpha Invite Email — Draft

> Replace `{{FirstName}}` and send. Plain text or light HTML both work.

---

**Subject:** You're in — Sci alpha (private)

---

Hi {{FirstName}},

Thanks for agreeing to kick the tires on **Sci**. Here's the one-line version:

> Sci is a local proxy that sits between Claude Code and Anthropic. It strips your real name, email, and other PII out of every request *before it leaves your machine* — and restores it in the reply. It also gives Claude a persistent memory of you and your projects across sessions. Everything stays local.

You're one of the first handful of people running it. It's alpha — rough edges guaranteed — and your job is to tell me where it hurts.

### Before you start

- A Mac on **Apple Silicon** (M1 or newer), macOS 13+
- Claude Code installed (`claude --version` should work)
- Your own Anthropic API key (`sk-ant-…`)

No Docker, no database setup — the alpha runs on local SQLite.

### Install (about 3 minutes)

Paste this into a terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/sovereign-cognitive-identity/sci/main/scripts/install.sh | bash
```

It'll ask for `sudo` twice (to trust a local certificate and install the background service) and prompt for your Anthropic API key. When it finishes, open a **new** terminal and run:

```bash
sci status     # should print  ok: true
sci verify     # sends a real request and proves your name didn't leak
```

If `sci verify` says **PASS**, you're live. Start Claude Code normally — Sci works in the background.

### What I'd love feedback on

The full walkthrough and the specific things I want tested are here:

- **Site:** http://195.26.249.211
- **Install guide:** https://sovereign-cognitive-identity.github.io/sci/guide/alpha-install
- **Using Sci:** https://sovereign-cognitive-identity.github.io/sci/guide/using-sci

Short version: does install just work? Does anything leak in `sci verify`? Does memory carry from one session to the next? Does the proxy break any of your normal tools?

### When something breaks

Grab two things and send them my way:

1. `sci status`
2. `tail -50 ~/Library/Logs/sci-helper.log`

→ [GitHub Issues](https://github.com/sovereign-cognitive-identity/sci/issues) (preferred) or just reply to this email.

Thanks for doing this. Genuinely.

— Casey
casey.zandbergen@gmail.com
