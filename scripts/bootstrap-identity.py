#!/usr/bin/env python3
"""
Phase A: Bootstrap identity_facts from episodic_memories.

Takes ~1500 distinct user-role chunks from the episodic DB, batches them
to Claude Haiku, extracts identity facts (preferences, skills, values,
relationships, background), deduplicates, and POSTs each fact to the
Rust helper — which handles embedding and storage automatically.

Usage:
    python3 scripts/bootstrap-identity.py
    python3 scripts/bootstrap-identity.py --dry-run   # print facts, don't POST
    python3 scripts/bootstrap-identity.py --limit 200 # cap chunks (for testing)

Auth: reads ~/.sci/oauth.json and passes the OAuth access_token as Bearer.
No third-party packages required (stdlib only).
"""

import argparse
import json
import os
import re
import sqlite3
import time
import urllib.request
from pathlib import Path

# ── Config ────────────────────────────────────────────────────────────────────

DB_PATH      = Path.home() / ".sci" / "memory" / "sci.db"
OAUTH_FILE   = Path.home() / ".sci" / "oauth.json"
HELPER_URL   = os.environ.get("SCI_HELPER_URL", "http://127.0.0.1:3002")
ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
MODEL        = "claude-haiku-4-5-20251001"
BATCH_SIZE   = 50     # chunks per LLM call (~2-4K tokens input)
MIN_LEN      = 80     # discard very short chunks
MAX_LEN      = 4_000  # discard giant dumps (code files, logs)

EXTRACTION_PROMPT = """\
You are analyzing conversation chunks from Casey Zandbergen's AI session history.

Extract ONLY facts that describe Casey personally:
  - preferences (communication style, tools, workflow)
  - skills (technical areas, expertise, experience level)
  - values (what Casey cares about, principles)
  - relationships (people Casey works with, companies)
  - background (career history, roles, active projects)

Rules:
  1. Facts must be about Casey specifically — not general info, not assistant output.
  2. Must be durable: "Casey prefers X" not "Casey is currently working on X".
  3. One concise sentence per fact.
  4. Skip trivially obvious facts (e.g. "Casey is a human").
  5. Confidence 0.6–1.0: 1.0 = stated explicitly, 0.7 = inferred from behaviour.

Return a JSON array only — no prose, no markdown fences:
[{"content": "...", "category": "preference|skill|value|relationship|background", "confidence": 0.0}]
Return [] if no identity facts are found in these chunks.

Conversation chunks:
---
{chunks}
---"""

# ── Auth ──────────────────────────────────────────────────────────────────────

def load_oauth_token() -> str:
    data = json.loads(OAUTH_FILE.read_text())
    token = data.get("access_token")
    if not token:
        raise RuntimeError(f"No access_token in {OAUTH_FILE}")
    return token


# ── Data loading ──────────────────────────────────────────────────────────────

def is_noise(text: str) -> bool:
    """Return True if chunk looks like code, logs, or terminal output."""
    if text.startswith(("```", "root@", "FROM ", "RUN ")):
        return True
    # Deeply indented code
    if text.count("\n") > 15 and text.count("    ") > 5:
        return True
    # Node/package artifacts
    if "node_modules" in text or "package-lock" in text:
        return True
    # Dense log lines (3+ ISO timestamps)
    if len(re.findall(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}", text)) >= 3:
        return True
    # Raw JSON object/array starts
    if text.lstrip().startswith(("{", "[")):
        return True
    return False


def load_chunks(limit: int | None = None) -> list[str]:
    """Distinct user-role chunks, noise-filtered, latest first."""
    sql = """
        SELECT content, MAX(occurred_at) AS latest
        FROM   episodic_memories
        WHERE  json_extract(metadata, '$.role') = 'user'
          AND  length(content) BETWEEN ? AND ?
        GROUP  BY substr(content, 1, 200)
        ORDER  BY latest DESC
    """
    if limit:
        sql += f" LIMIT {int(limit)}"

    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute(sql, (MIN_LEN, MAX_LEN)).fetchall()
    conn.close()

    chunks = [r[0] for r in rows if not is_noise(r[0])]
    print(f"[bootstrap] {len(rows)} distinct user chunks → {len(chunks)} after noise filter")
    return chunks


# ── LLM extraction ────────────────────────────────────────────────────────────

def extract_facts_batch(token: str, chunks: list[str]) -> list[dict]:
    """Call Claude Haiku on a batch; return list of fact dicts."""
    joined = "\n---\n".join(chunks)
    body = json.dumps({
        "model":      MODEL,
        "max_tokens": 2048,
        "messages":   [{"role": "user", "content": EXTRACTION_PROMPT.replace("{chunks}", joined)}],
    }).encode()
    req = urllib.request.Request(
        ANTHROPIC_URL,
        data=body,
        headers={
            "Content-Type":     "application/json",
            "anthropic-version": "2023-06-01",
            "Authorization":    f"Bearer {token}",
            "anthropic-beta":   "claude-code-20250219",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read())
        text = data["content"][0]["text"].strip()
        m = re.search(r"\[[\s\S]*\]", text)
        return json.loads(m.group()) if m else []
    except Exception as e:
        print(f"  [warn] LLM error: {e}")
        return []


# ── Conflict check ─────────────────────────────────────────────────────────────

def fetch_existing_facts() -> list[str]:
    """Return content strings of current identity_facts."""
    try:
        with urllib.request.urlopen(f"{HELPER_URL}/sci/identity?limit=100", timeout=5) as r:
            return [f["content"] for f in json.loads(r.read())]
    except Exception:
        return []


def token_overlap(a: str, b: str) -> float:
    """Jaccard similarity on word tokens."""
    ta = set(a.lower().split())
    tb = set(b.lower().split())
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


# ── Storage ───────────────────────────────────────────────────────────────────

def post_fact(fact: dict):
    body = json.dumps({
        "content":    fact["content"],
        "kind":       "identity",
        "category":   fact.get("category"),
        "confidence": fact.get("confidence", 0.8),
    }).encode()
    req = urllib.request.Request(
        f"{HELPER_URL}/sci/memories",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Bootstrap identity_facts from episodic memory")
    parser.add_argument("--dry-run", action="store_true", help="Print facts without storing")
    parser.add_argument("--limit",   type=int, default=None, help="Cap number of input chunks (for testing)")
    args = parser.parse_args()

    token  = load_oauth_token()
    chunks = load_chunks(limit=args.limit)

    all_facts: list[dict] = []
    seen_fps:  set[str]   = set()
    total_batches = (len(chunks) + BATCH_SIZE - 1) // BATCH_SIZE

    print(f"[bootstrap] {total_batches} batches × ≤{BATCH_SIZE} chunks → Claude Haiku")

    for i in range(0, len(chunks), BATCH_SIZE):
        batch = chunks[i : i + BATCH_SIZE]
        bn    = i // BATCH_SIZE + 1
        print(f"  batch {bn}/{total_batches} ...", end=" ", flush=True)
        facts = extract_facts_batch(token, batch)
        new   = 0
        for f in facts:
            fp = f.get("content", "")[:80].lower().strip()
            if fp and fp not in seen_fps:
                seen_fps.add(fp)
                all_facts.append(f)
                new += 1
        print(f"{new} facts")
        time.sleep(0.3)

    print(f"\n[bootstrap] {len(all_facts)} unique candidate facts extracted")

    if not all_facts:
        print("[bootstrap] nothing to store — done")
        return

    # Conflict-check against existing identity_facts
    existing = fetch_existing_facts()
    print(f"[bootstrap] checking against {len(existing)} existing facts …")

    to_store: list[dict] = []
    for f in all_facts:
        cand = f.get("content", "")
        if any(token_overlap(cand, ex) > 0.7 for ex in existing):
            continue  # already covered
        to_store.append(f)

    print(f"[bootstrap] {len(to_store)} new facts after conflict check\n")

    if args.dry_run:
        for f in to_store:
            print(f"  [{f.get('category','?')} / {f.get('confidence','?')}] {f['content']}")
        return

    stored = 0
    for f in to_store:
        try:
            post_fact(f)
            print(f"  ✓ [{f.get('category','?')}] {f['content'][:90]}")
            stored += 1
        except Exception as e:
            print(f"  ✗ {e} — {f.get('content','')[:60]}")

    print(f"\n[bootstrap] done: {stored}/{len(to_store)} facts stored")


if __name__ == "__main__":
    main()
