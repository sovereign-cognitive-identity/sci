#!/usr/bin/env python3
"""
Merge semantically overlapping identity facts using Claude Haiku.
Reads from SQLite, merges clusters, deletes originals, posts merged facts.
"""
import json, re, sqlite3, urllib.request, urllib.error, time

DB_PATH = "/Users/caseyzandbergen/.sci/memory/sci.db"
ADMIN_URL = "http://127.0.0.1:3002"
ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
MODEL = "claude-haiku-4-5-20251001"
JACCARD_THRESHOLD = 0.25

# --- Auth ---
with open("/Users/caseyzandbergen/.sci/oauth.json") as f:
    TOKEN = json.load(f)["access_token"]

def api_call(url, method="GET", body=None, headers=None):
    req_headers = {"Content-Type": "application/json"}
    if headers:
        req_headers.update(headers)
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, headers=req_headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print(f"  HTTP {e.code}: {e.read().decode()[:200]}")
        return None

def claude(prompt):
    headers = {
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "claude-code-20250219",
        "Authorization": f"Bearer {TOKEN}",
    }
    body = {
        "model": MODEL,
        "max_tokens": 256,
        "messages": [{"role": "user", "content": prompt}]
    }
    req = urllib.request.Request(
        ANTHROPIC_URL,
        data=json.dumps(body).encode(),
        headers={**{"Content-Type": "application/json"}, **headers},
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read())
            return result["content"][0]["text"].strip()
    except urllib.error.HTTPError as e:
        print(f"  Claude error {e.code}: {e.read().decode()[:300]}")
        return None

# --- Load all facts from SQLite ---
conn = sqlite3.connect(DB_PATH)
conn.row_factory = sqlite3.Row
rows = conn.execute(
    "SELECT id, content, category, confidence FROM identity_facts ORDER BY created_at"
).fetchall()
facts = [dict(r) for r in rows]
conn.close()
print(f"Loaded {len(facts)} facts from SQLite")

# --- Cluster by token Jaccard ---
STOPS = {'the','a','an','is','are','was','were','has','have','had','and','or','but','in',
         'on','at','to','for','of','with','by','from','as','be','that','this','their','they',
         'it','its','i','my','your','our','not','no','casey','uses','use','using','also'}

def tokenize(text):
    return set(w for w in re.findall(r'\b\w+\b', text.lower())
               if w not in STOPS and len(w) > 2)

clusters = []
used = set()
for i, a in enumerate(facts):
    if i in used:
        continue
    cluster = [i]
    ta = tokenize(a['content'])
    for j, b in enumerate(facts[i+1:], i+1):
        if j in used:
            continue
        tb = tokenize(b['content'])
        union = ta | tb
        jaccard = len(ta & tb) / len(union) if union else 0
        if jaccard >= JACCARD_THRESHOLD:
            cluster.append(j)
            used.add(j)
    if len(cluster) > 1:
        used.add(i)
        clusters.append(cluster)

print(f"Found {len(clusters)} clusters to merge ({sum(len(c)-1 for c in clusters)} redundant facts)")
clusters.sort(key=lambda c: -len(c))

# --- Process each cluster ---
merged_count = 0
deleted_count = 0
errors = []

MERGE_PROMPT = """You are merging duplicate identity facts about a person named Casey into a single comprehensive fact.
The facts below all describe the same topic. Write ONE concise sentence that captures all unique information.
- Keep all specific details (names, IPs, versions, tools) that appear in any fact
- Remove redundant repetition
- Start with "Casey"
- Return ONLY the merged sentence, no explanation

Category: {category}

Facts to merge:
{facts}

Merged fact:"""

for n, cluster in enumerate(clusters):
    cluster_facts = [facts[i] for i in cluster]

    # Determine dominant category
    cats = [f['category'] for f in cluster_facts]
    dominant_cat = max(set(cats), key=cats.count)

    contents = "\n".join(f"- {f['content']}" for f in cluster_facts)
    print(f"\n[{n+1}/{len(clusters)}] Merging {len(cluster)} facts (category: {dominant_cat}):")
    for f in cluster_facts:
        print(f"  • {f['content'][:90]}")

    prompt = MERGE_PROMPT.format(category=dominant_cat, facts=contents)
    merged = claude(prompt)

    if not merged:
        print(f"  ⚠ Claude call failed, skipping cluster")
        errors.append(cluster)
        continue

    # Sanitize: remove wrapping quotes if any
    merged = merged.strip('"\'')
    print(f"  ✓ Merged: {merged[:100]}")

    # Delete originals directly from SQLite
    # (admin API DELETE only handles episodic; identity facts have no API delete path)
    conn = sqlite3.connect(DB_PATH)
    for f in cluster_facts:
        conn.execute("DELETE FROM identity_facts WHERE id=?", (f['id'],))
        deleted_count += 1
    conn.commit()
    conn.close()

    # Post merged fact
    body = {
        "content": merged,
        "kind": "identity",
        "category": dominant_cat,
        "confidence": 0.95,
    }
    result = api_call(f"{ADMIN_URL}/sci/memories", method="POST", body=body)
    if result:
        merged_count += 1
    else:
        print(f"  ⚠ Failed to post merged fact")
        errors.append(cluster)

    time.sleep(0.3)  # rate limit

print(f"\n=== DONE ===")
print(f"Clusters merged: {merged_count}/{len(clusters)}")
print(f"Facts deleted: {deleted_count}")
print(f"Errors: {len(errors)}")
if errors:
    print(f"Failed clusters: {errors}")

# Final count
conn = sqlite3.connect(DB_PATH)
final_count = conn.execute("SELECT COUNT(*) FROM identity_facts").fetchone()[0]
conn.close()
print(f"identity_facts count: {len(facts)} → {final_count}")
