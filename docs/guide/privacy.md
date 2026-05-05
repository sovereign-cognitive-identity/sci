# The Privacy Guarantee

Sci's core promise: **your real name, email, and identifying information never appear in a prompt sent to an AI provider.**

This is verifiable. You don't have to trust us.

## Run the demo

```bash
node demo/privacy-demo.mjs
```

This takes under 10 seconds and shows you exactly what happens to a message containing your real identity before it would reach an AI provider.

Expected output:
```
Step 1: What you typed
Hi, my name is Casey Zandbergen...

Step 2: What the AI provider would receive
Hi, my name is [PERSON_1] and I'm based in [PLACE_1]...

Step 3: Token map
  [EMAIL_1]  ← "casey.zandbergen@gmail.com"
  [PERSON_1] ← "Casey Zandbergen"
  [PLACE_1]  ← "Tulsa, Oklahoma"
  ...

Step 4: Verification
  ✓ Real name absent from outbound text
  ✓ Email absent from outbound text
  ...

✓ All checks passed.
```

## How it works

The anonymization pipeline runs in four layers, in order:

**Layer 1 — Regex (works for everyone, day one)**

Emails, URLs, phone numbers, social handles. Pattern-matched, no training required. A brand-new user gets 100% coverage immediately.

**Layer 2 — compromise.js NER**

Named entity recognition for people, places, and organizations using a pre-trained English model. "John Smith from Seattle at Acme Corp" gets caught with no history.

**Layer 3 — Custom entities from your identity_facts**

Project names, company names, and other personal entities learned from your history. The longer you use Sci, the better this layer gets. On day one, seed it with `sci import --claude`.

**Layer 4 — CamelCase detection**

Structural detection of compound proper nouns (`OpenClaw`, `CrossTimbersFarm`, `ElevenLabs`) regardless of history.

## The token map

Every detected entity gets a token: `[PERSON_1]`, `[EMAIL_2]`, `[URL_3]`. The mapping is stored in process memory only, for the duration of the MCP server process.

It is **never**:
- Written to disk
- Written to the database
- Sent to any external service
- Persisted across server restarts

Use `session_inspect` to audit what has been masked before any outbound call.

## Session feedback loop

If a new project name (like `Threadline`) gets caught in call 1 of a session, it's automatically in the session's entity set and proactively checked in all subsequent calls — even in contexts where NER might not catch it.

## Progressive promotion

If an entity appears in 3 or more separate calls, it gets automatically promoted to `identity_facts` and will be caught in every future session via Layer 3.

## What Sci does not guarantee

- **Perfect NER coverage** — named entity recognition is probabilistic. Uncommon names or highly context-dependent entities may slip through, especially for new users with no imported history.
- **Protection against inference** — if you tell the AI "I'm working on an iOS wardrobe app" without naming it, the AI can infer context even without the project name.
- **Post-response handling** — Sci deanonymizes the AI's response before showing it to you. What the AI does with its own context window is outside Sci's scope.

The anonymization engine is conservative: it's better to mask something generic (like a city name) than to miss something sensitive. Use `session_inspect` if you need to audit before sending.
