# Sci Terms of Service

*Last updated: May 2026*

These Terms of Service ("Terms") govern your use of the Sci managed service operated at sovereign-cognitive-identity.github.io/sci ("the Service") by Casey Zandbergen ("we", "us", "Sci"). By using the Service, you agree to these Terms.

---

## 1. The Service

Sci is a cognitive identity layer that anonymizes your identity before AI processing, preserves your context across AI tools, and routes queries to appropriate models. The managed tier handles compute (anonymization, embeddings, routing). Your data is stored in your chosen storage (Dropbox, iCloud, S3, or self-hosted).

**The open source version** is available under AGPL-3.0 at github.com/sovereign-cognitive-identity/sci and is not covered by these Terms.

---

## 2. Accounts

You must provide a valid email address to create an account. You are responsible for maintaining the security of your account credentials and API tokens. Notify us immediately at casey.zandbergen@gmail.com if you believe your account has been compromised.

---

## 3. Acceptable use

You may not use the Service to:

- Violate any applicable law or regulation
- Process personal data of others without their consent
- Attempt to circumvent the anonymization pipeline to extract PII from AI responses
- Resell or white-label the Service without a commercial license
- Interfere with the Service's infrastructure or other users

---

## 4. Privacy and data

Your use of the Service is governed by our [Privacy Policy](PRIVACY_POLICY.md). The key points:

- We never access your memory store (it's in your storage, under your credentials)
- Anonymization token maps are never persisted
- We log minimal operational metadata for billing and debugging

---

## 5. Subscription and payment

**Free tier (self-hosted):** No payment required. Not covered by these Terms.

**Personal ($12/month):** Monthly subscription, billed via Stripe. Cancel anytime; access continues until end of billing period.

**Pro ($24/month):** Same cancellation terms.

**Team ($20/user/month):** Billed per seat. Adding seats mid-cycle is prorated.

No refunds for partial months except where required by law.

---

## 6. Service availability

We target 99.5% monthly uptime for the anonymization pipeline. Scheduled maintenance will be announced 24 hours in advance. We do not guarantee availability of third-party AI providers (Anthropic, Google, OpenAI) — these are outside our control.

In the event of prolonged outage, subscribers may pause their subscription without penalty.

---

## 7. Changes to the Service

We may modify or discontinue features with 30 days' notice. We will not reduce core functionality (anonymization, memory recall, storage backend support) without 60 days' notice and a data export window.

---

## 8. Intellectual property

The Sci software is licensed under AGPL-3.0 (open source) or a Commercial License. These Terms don't grant additional IP rights beyond what those licenses provide.

"Sci" is a trademark of Casey Zandbergen. See [TRADEMARK.md](../TRADEMARK.md).

---

## 9. Disclaimer of warranties

THE SERVICE IS PROVIDED "AS IS" WITHOUT WARRANTIES OF ANY KIND. WE DO NOT WARRANT THAT THE SERVICE WILL BE ERROR-FREE, THAT DATA WILL NOT BE LOST, OR THAT THE ANONYMIZATION PIPELINE WILL CATCH EVERY PIECE OF PII IN EVERY CONTEXT.

Run `node demo/privacy-demo.mjs` to verify the anonymization guarantee for your specific use case before relying on it for sensitive data.

---

## 10. Limitation of liability

TO THE MAXIMUM EXTENT PERMITTED BY LAW, SCI'S LIABILITY FOR ANY CLAIM ARISING FROM THESE TERMS OR YOUR USE OF THE SERVICE SHALL NOT EXCEED THE AMOUNT YOU PAID IN THE 12 MONTHS PRECEDING THE CLAIM.

IN NO EVENT SHALL SCI BE LIABLE FOR INDIRECT, INCIDENTAL, SPECIAL, OR CONSEQUENTIAL DAMAGES, INCLUDING DATA LOSS.

---

## 11. Termination

Either party may terminate at any time. On termination, you have 30 days to export your data via `sci backup`. After that window, we delete operational data. Your memory store (in your storage) is unaffected — it's yours.

---

## 12. Governing law

These Terms are governed by the laws of the State of Oklahoma, United States. Disputes will be resolved in Tulsa County, Oklahoma.

---

## 13. Changes to these Terms

We'll notify you by email 30 days before material changes. Continued use after the effective date constitutes acceptance.

---

## Contact

Casey Zandbergen  
casey.zandbergen@gmail.com  
Tulsa, Oklahoma, United States

*These Terms are written in plain language. They are not a substitute for legal counsel for complex compliance requirements.*
