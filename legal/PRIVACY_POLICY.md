# Sci Privacy Policy

*Last updated: May 2026*

This policy applies to the Sci managed service operated at sovereign-cognitive-identity.github.io/sci ("the Service"). It does not apply to self-hosted deployments of the Sci open source software — those are entirely under your control.

---

## The short version

- Your memories and conversations are stored in **your chosen storage** (Dropbox, iCloud, S3, or your own server) — we don't have access to them
- We process your data through anonymization before it touches any AI provider — your real name never appears in outbound prompts
- We collect minimal operational data to run the service
- We don't sell your data, ever

---

## What data we collect and why

### Data you control (stored in your storage)

The following is stored in your chosen cloud storage (Dropbox, iCloud, S3, etc.) under credentials only you hold. We cannot access this data:

- Episodic memories (conversation fragments and events)
- Semantic nodes (promoted facts and preferences)
- Identity facts (preferences, values, relationships)
- Vector embeddings

**We have zero access to this data.** If you use the iCloud or self-hosted backends, it never passes through our infrastructure at all.

### Data we process transiently (not stored)

When using the anonymization pipeline through the managed service:

- Your raw messages are processed to extract entities (names, emails, locations) and replace them with tokens
- The original text and token map exist **only in process memory** during a request
- Neither the original text nor the token map is logged, stored, or transmitted to any third party

### Operational data we do collect

To operate the managed service, we collect:

| Data | Why | Retention |
|---|---|---|
| Account email address | Authentication, billing, service communication | Duration of account |
| Payment information | Billing (processed by Stripe — we don't store card numbers) | Per Stripe's policy |
| API request metadata (timestamps, model used, token counts) | Billing, rate limiting, abuse prevention | 90 days |
| Error logs | Debugging service issues | 30 days |

We do not log the content of your queries or the content of AI responses.

---

## AI providers

The managed service routes anonymized queries to AI providers (Anthropic, Google, OpenAI) via OpenRouter. These providers receive:

- The anonymized version of your message (tokens instead of real names)
- Memory context (also anonymized before injection)

They do not receive:
- Your real name, email, or any PII
- The token-to-entity mapping
- Any identifier linking the request to your account

Please review the relevant AI providers' privacy policies for how they handle API requests.

---

## Data sovereignty

Sci is designed so that the most sensitive data — your memories and identity facts — never needs to leave infrastructure you control. The managed tier provides the compute (anonymization, embeddings, routing) but not the storage.

You can verify this architecture is working as described by running `node demo/privacy-demo.mjs` at any time.

---

## Your rights (GDPR/CCPA)

You have the right to:

- **Access** your data — `sci backup` exports everything
- **Delete** your data — delete your storage files; we delete operational data within 30 days of account closure
- **Portability** — your backup is plain JSON, importable to any Sci instance
- **Opt out of sale** — we don't sell data, so this doesn't apply

To exercise these rights or for questions: **casey.zandbergen@gmail.com**

---

## Cookies and tracking

The Sci website (sovereign-cognitive-identity.github.io/sci) uses no third-party analytics, no tracking pixels, and no behavioral advertising cookies. We use session cookies for authentication only.

---

## Changes

We'll notify you by email at least 30 days before material changes to this policy. Non-material changes (formatting, clarifications) will be updated without notice.

---

## Contact

Casey Zandbergen  
casey.zandbergen@gmail.com  
Tulsa, Oklahoma, United States

*This policy is a good-faith description of how we handle data. It is not legal advice. If you have compliance requirements (HIPAA, SOC 2, etc.) that require a formal DPA, contact us.*
