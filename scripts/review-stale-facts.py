#!/usr/bin/env python3
"""
Review future-tense identity facts for staleness.

For each fact matching forward-looking patterns:
  - Searches recent episodic memory for evidence of completion/abandonment
  - Asks Claude Haiku to classify: keep | completed | abandoned | stale
  - completed  → rewrites as present/past tense, upgrades confidence to 0.9
  - abandoned  → deletes fact
  - stale      → logs for manual review, no auto-action
  - keep       → no change

Usage:
    python3 scripts/review-stale-facts.py
    python3 scripts/review-stale-facts.py --dry-run   # classify only, no writes
"""
import argparse, json, re, sqlite3, urllib.request, urllib.error, time
from datetime import datetime

DB_PATH = "/Users/caseyzandbergen/.sci/memory/sci.db"
ADMIN_URL = "http://127.0.0.1:3002"
ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
MODEL = "claude-haiku-4-5-20251001"

FUTURE_PATTERNS = [
    '%planning%', '%plans to%', '%intends to%',
    '%is migrating%', '%is transitioning%', '%is setting up%',
    '%is considering%', '%is expanding%', '%is investigating%',
]
# These patterns indicate active ongoing work, not stale plans — skip
ALWAYS_KEEP_PATTERNS = [
    'is building Sci', 'is developing Sci', 'is building and',
    'is developing Threadline', 'is building observability',
]

parser = argparse.ArgumentParser()
parser.add_argument('--dry-run', action='store_true')
args = parser.parse_args()

with open("/Users/caseyzandbergen/.sci/oauth.json") as f:
    TOKEN = json.load(f)["access_token"]

def http_get(url):
    req = urllib.request.Request(url)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read())
    except Exception as e:
        return None

def claude(prompt):
    body = {"model": MODEL, "max_tokens": 512,
            "messages": [{"role": "user", "content": prompt}]}
    req = urllib.request.Request(
        ANTHROPIC_URL,
        data=json.dumps(body).encode(),
        headers={
            "Content-Type": "application/json",
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "claude-code-20250219",
            "Authorization": f"Bearer {TOKEN}",
        },
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())["content"][0]["text"].strip()
    except urllib.error.HTTPError as e:
        print(f"  Claude error {e.code}: {e.read().decode()[:200]}")
        return None

def recall_context(query, limit=5):
    """Search recent episodic memory for context about a topic."""
    url = f"{ADMIN_URL}/sci/recall?query={urllib.parse.quote(query)}&limit={limit}"
    result = http_get(url)
    if not result:
        return []
    items = result if isinstance(result, list) else result.get('results', [])
    return [r.get('content', '') for r in items[:limit]]

import urllib.parse

# ── Load future-tense facts from SQLite ──────────────────────────────────────
where = " OR ".join(f"content LIKE '{p}'" for p in FUTURE_PATTERNS)
conn = sqlite3.connect(DB_PATH)
rows = conn.execute(
    f"SELECT id, content, category, confidence FROM identity_facts WHERE ({where}) ORDER BY confidence DESC"
).fetchall()
conn.close()

# Filter out always-keep patterns
facts = []
for row in rows:
    content = row[1]
    if any(p in content for p in ALWAYS_KEEP_PATTERNS):
        continue
    facts.append({'id': row[0], 'content': row[1], 'category': row[2], 'confidence': row[3]})

print(f"Found {len(facts)} future-tense facts to review")
print(f"Mode: {'DRY RUN' if args.dry_run else 'LIVE'}\n")

CLASSIFY_PROMPT = """Today is {today}. You are reviewing an identity fact about Casey that was written some time ago.
The fact uses future or in-progress tense. Based on recent memory context, determine its status.

FACT: {fact}

RECENT CONTEXT (episodic memories mentioning this topic):
{context}

Classify the fact as exactly one of:
- keep       : still actively in progress, no evidence of completion or abandonment
- completed  : evidence suggests this was finished; rewrite as present/past tense
- abandoned  : evidence suggests this was dropped or is no longer relevant
- stale      : old and likely outdated but no clear evidence either way

Respond in JSON:
{{"status": "keep|completed|abandoned|stale", "reason": "one sentence", "rewrite": "new fact sentence (only if completed)"}}

JSON only, no prose:"""

results = {'keep': [], 'completed': [], 'abandoned': [], 'stale': [], 'error': []}

for i, fact in enumerate(facts):
    print(f"[{i+1}/{len(facts)}] {fact['content'][:100]}")

    # Get recent episodic context
    # Use first 8 words as search query
    words = fact['content'].split()[:8]
    query = ' '.join(w for w in words if w.lower() not in {'casey','is','are','was','were','has','have','the','a','an','and','or','to','in','on','at','of','with'})
    context_chunks = recall_context(query)
    context_str = "\n".join(f"- {c[:200]}" for c in context_chunks) if context_chunks else "(no recent context found)"

    prompt = CLASSIFY_PROMPT.format(
        today=datetime.utcnow().strftime('%Y-%m-%d'),
        fact=fact['content'],
        context=context_str,
    )
    response = claude(prompt)
    if not response:
        results['error'].append(fact)
        print(f"  ⚠ Claude error")
        continue

    # Parse JSON
    try:
        # Claude sometimes adds ``` fences
        clean = re.sub(r'^```.*?\n|```$', '', response.strip(), flags=re.MULTILINE).strip()
        data = json.loads(clean)
        status = data['status']
        reason = data.get('reason', '')
        rewrite = data.get('rewrite', '')
    except Exception as e:
        print(f"  ⚠ Parse error: {e}\n  Response: {response[:200]}")
        results['error'].append(fact)
        continue

    print(f"  → {status.upper()}: {reason}")
    results[status].append(fact)

    if args.dry_run:
        if status == 'completed' and rewrite:
            print(f"    Would rewrite: {rewrite[:100]}")
        continue

    if status == 'completed' and rewrite:
        # Delete old fact from SQLite
        conn = sqlite3.connect(DB_PATH)
        conn.execute("DELETE FROM identity_facts WHERE id=?", (fact['id'],))
        conn.commit()
        conn.close()
        # Post rewritten fact
        body = {'content': rewrite, 'kind': 'identity',
                'category': fact['category'], 'confidence': 0.9}
        req = urllib.request.Request(
            f"{ADMIN_URL}/sci/memories",
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                print(f"    ✓ Rewritten: {rewrite[:100]}")
        except Exception as e:
            print(f"    ⚠ Failed to post rewrite: {e}")

    elif status == 'abandoned':
        conn = sqlite3.connect(DB_PATH)
        conn.execute("DELETE FROM identity_facts WHERE id=?", (fact['id'],))
        conn.commit()
        conn.close()
        print(f"    ✓ Deleted")

    time.sleep(0.3)

# ── Summary ──────────────────────────────────────────────────────────────────
print(f"\n=== SUMMARY ===")
print(f"keep:      {len(results['keep'])}")
print(f"completed: {len(results['completed'])}")
print(f"abandoned: {len(results['abandoned'])}")
print(f"stale:     {len(results['stale'])}")
print(f"errors:    {len(results['error'])}")

if results['stale']:
    print(f"\n⚠ STALE — manual review needed:")
    for f in results['stale']:
        print(f"  [{f['id'][:8]}] {f['content'][:110]}")
