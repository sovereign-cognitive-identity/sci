# The Privacy Guarantee — What Leaves Your Machine

This document describes what Sci does with your data, in enough detail that you can verify each claim by reading the source. If you disagree with anything written here, open an issue.

---

## 1. The anonymization pipeline, step by step

Every outbound request passes through this sequence. Nothing reaches the upstream provider until all steps complete.

```
1. Receive plaintext message from client (Claude Code, curl, SDK, etc.)

2. NER entity extraction
   - Run compromise.js NLP over the message text
   - Match against your stored identity_facts (name, email, organization, etc.)
   - Build a list of spans: text + entity type + position

3. Token substitution
   - For each span, assign a stable session token: [PERSON_1], [EMAIL_1], [URL_1], ...
   - Replace the span in the message with the token
   - Record the mapping in an in-memory token map (never written to disk)

4. Session entity feedback
   - Check whether any entity was seen in an earlier request this session
   - If so, reuse the same token (PERSON_1 is always Casey, not Casey and then [PERSON_2])

5. Memory context injection
   - Query the local SQLite store for semantically relevant memories
   - Prepend relevant context to the system prompt
   - This context already went through the same anonymization when it was stored

6. Upstream request
   - Send the anonymized message + injected context to the provider (Anthropic, OpenAI, etc.)
   - Provider sees tokens, not names

7. Response deanonymization
   - Apply the in-memory token map in reverse to the response text
   - [PERSON_1] → Casey Zandbergen in the text you see

8. Store interaction
   - The raw pre-anonymization message is stored locally (it's yours)
   - The token map is not stored anywhere

9. Discard token map
   - Session token map lives only in process heap
   - When the session ends or the process exits, it's gone
```

**Progressive promotion:** if an entity appears in 3 or more separate calls, it is automatically promoted to `identity_facts` in your local store. This means it will be caught in future sessions even if it is not in the current session's map yet. No cloud service is involved in this promotion.

---

## 2. What is stored locally vs. what reaches the cloud

| Data | Where it goes |
|---|---|
| Your raw message (before anonymization) | Local SQLite at `~/.sci/memory/sci.db` only |
| Anonymized message | Sent to upstream provider |
| Token map (PERSON_1 → Casey) | Process heap only, never written anywhere |
| Provider's response (before deanonymization) | Not stored |
| Deanonymized response | Local SQLite (episodic memory) |
| Your API keys | `~/.sci/credentials.env` only, never sent to any Sci server |
| Embedding vectors | Local `sci.db` / `sci.idx`, computed by a local model |

The embedding model (`BAAI/bge-base-en-v1.5`) runs entirely on your machine via FastEmbed. Computing an embedding does not make a network request.

Sci has no cloud backend, no analytics, no telemetry. There is no Sci server that your data passes through. The proxy is localhost.

---

## 3. The token map — lives in process memory only

The in-memory token map is a `HashMap<String, String>` held in the `HandlerState` struct. It is:

- Allocated on the heap when the session starts
- Updated as entities are discovered
- Read during response deanonymization
- Dropped when the session ends or the process exits

It is never serialized to disk, never written to the database, never sent over a network connection, and never logged (even at `RUST_LOG=debug`).

Source: `sci_core/src/anonymizer.rs` and `sci_core/src/handlers/`. Read it and confirm.

---

## 4. How to verify it yourself

**The fast path:**

```bash
sci-helper --verify
```

This makes a real request through the proxy with a message that contains a name and email address you provide. It prints the original message, the anonymized version that reached the provider, and the deanonymized response. If your real name appears in the outbound text, the test fails visibly.

**The source path:**

The anonymizer is in `sci_core/src/anonymizer.rs`. The handler pipeline that calls it is in `sci_core/src/handlers/`. The verify command is in `apps/sci-mac/SciHelper/src/verify.rs`. None of these files are large. Read them.

**The network path:**

Run Sci with `RUST_LOG=debug` and watch stderr. Every outbound request is logged at DEBUG level with the anonymized body. You can also intercept traffic at the network layer with Wireshark or `tcpdump` — the proxy speaks plain HTTPS to upstream, and the anonymized text is what you will see in the TLS payload (after decryption, if you install your own decryption key).

---

## 5. What Sci cannot protect against

Be precise about limits:

**Pasting secrets directly.** The NER model catches common patterns — names, email addresses, phone numbers, URLs, organization names. It does not catch everything. If you paste an API key, a private key, or a custom internal identifier that does not match a known entity type, it will pass through unchanged. Do not paste secrets into AI prompts.

**Semantic inference.** The anonymized text still contains your writing style, your project names (unless they match an entity), your code, and your problem domain. A provider could infer things about you from the content even without your name. Sci removes direct identifiers; it does not sanitize meaning.

**Patterns across sessions.** The token map is discarded at session end. In a new session, the same entity gets a new token (PERSON_1 again, but with no relationship to the previous session's PERSON_1). A provider cannot correlate sessions by token. But if you always describe the same projects in the same terms, that is a different signal.

**Known identity_facts stored locally.** If an entity has been promoted to `identity_facts`, it will be caught in future sessions. But `identity_facts` only cover what has been seen before. A new name or email you use for the first time may not be caught until after the first request in that session.

**If the proxy is not running.** If `sci-helper` is not running and `HTTPS_PROXY` or `ANTHROPIC_BASE_URL` is set to point at it, requests will fail rather than fall through to the provider unprotected. This is intentional — a silent bypass would be worse than an error.

---

## 6. The CA — what it is, what it can see, why it is local only

To intercept HTTPS traffic, Sci acts as a TLS man-in-the-middle between your client and the upstream provider. This requires a local certificate authority (CA) that your OS trusts.

**What the CA is:** a self-signed root certificate generated locally at first run, stored at `~/.sci/ca.crt` and `~/.sci/ca.key`. The private key never leaves your machine.

**What `sci-helper --trust-ca` does:** adds `~/.sci/ca.crt` to the macOS system keychain with full trust. After this, curl, Python's `requests`, Claude Code, and your browser will accept TLS certificates issued by your local CA without errors. This is the same technique used by mitmproxy, Charles Proxy, and corporate network inspectors.

**What the CA can see:** because Sci terminates TLS on the local side, the proxy sees the plaintext of every HTTPS request that passes through it — to any host, not just AI providers. Sci only processes requests to known AI provider hostnames (Anthropic, OpenAI, etc.) and forwards everything else unchanged. You can verify this in `sci_core/src/handlers/mod.rs`.

**Why it is local only:** the CA private key is generated on your machine and stays there. Sci has no mechanism to upload it, and there is no Sci server that could receive it. If you delete `~/.sci/ca.key`, the CA is gone and all previously issued leaf certificates become untrusted.

**If you want to remove it:** open Keychain Access, find the "Sci Local CA" certificate under System Roots, and delete it. Or:

```bash
security delete-certificate -c "Sci Local CA" /Library/Keychains/System.keychain
```
