#!/usr/bin/env node
/**
 * capture-from-ts.mjs
 *
 * Runs the TypeScript reference anonymizer against a fixed corpus and
 * writes the results to core/tests/fixtures/anonymizer.json.
 *
 * Run from the repo root:
 *   npm run capture-fixtures   (see package.json in packages/core)
 *
 * Or directly:
 *   node core/tests/capture-from-ts.mjs
 *
 * The output format matches what tests/parity.rs expects:
 *   [{ name, input, expected_text, expected_entity_count, expected_detected }]
 *
 * "expected_detected" contains ALL entities the TS pipeline detects —
 * the Rust parity test filters both sides through the allowlist before
 * comparing, so we capture the raw list here.
 */

import { anonymize } from '../../packages/core/dist/anonymizer.js'
import { writeFileSync, mkdirSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── Corpus ────────────────────────────────────────────────────────────────────
//
// Each entry has a name (used in failure messages) and an input string.
// Inputs are chosen to exercise every detection pass the TS anonymizer
// runs: regex (email, phone, URL, domain, handle), NLP NER (PERSON,
// PLACE, ORG), and CamelCase heuristic (PROJECT).
//
// Inputs deliberately do NOT require the DB-backed custom-entity pass
// (anonymizeAsync) so the fixture can be regenerated without a live DB.

const CORPUS = [
  // ── PERSON ───────────────────────────────────────────────────────────────
  {
    name: 'person_first_name_alone',
    input: 'Casey said the deploy went fine.',
  },
  {
    name: 'person_full_name',
    input: 'Hi! My name is Casey Zandbergen and I work on Sci.',
  },
  {
    name: 'person_honorific',
    input: 'Jennifer Adams submitted the report on time.',
  },
  {
    name: 'person_multiple',
    input: 'Alice and Bob reviewed the changes. Carol approved it.',
  },
  {
    name: 'person_in_sentence',
    input: 'The meeting between Sarah and James ran long.',
  },

  // ── PLACE ────────────────────────────────────────────────────────────────
  {
    name: 'place_city',
    input: 'Visiting Tulsa next week for the conference.',
  },
  {
    name: 'place_city_state',
    input: 'The team is based in Portland.',
  },
  {
    name: 'place_bigram',
    input: 'Flying to New York for the sprint review.',
  },
  {
    name: 'place_unambiguous_state_code',
    input: 'She is flying from Houston.',
  },
  {
    name: 'place_state_ca',
    input: 'Visiting Colorado in the fall.',
  },
  {
    name: 'place_ambiguous_state_geo_prep',
    input: 'I am driving to Oklahoma for the weekend.',
  },
  {
    name: 'place_subject_copula',
    input: 'Oregon is my home state.',
  },
  {
    name: 'place_full_state_name',
    input: 'Visit Oregon and Washington on the road trip.',
  },

  // ── ORG ──────────────────────────────────────────────────────────────────
  {
    name: 'org_suffix_corp',
    input: 'The contract was signed with Meridian Corp last Friday.',
  },
  {
    name: 'org_suffix_llc',
    input: 'Accounts are managed by PinnacleTrust LLC.',
  },
  {
    name: 'org_suffix_corp2',
    input: 'The contract is with Meridian Corp.',
  },

  // ── EMAIL ────────────────────────────────────────────────────────────────
  {
    name: 'email_plain',
    input: 'Reach me at casey@example.com anytime.',
  },
  {
    name: 'email_in_sentence',
    input: 'Forward the report to ops@acme.io and finance@acme.io.',
  },

  // ── URL ──────────────────────────────────────────────────────────────────
  {
    name: 'url_full_https',
    input: 'See https://sci.dev/docs for setup instructions.',
  },
  {
    name: 'url_bare_domain',
    input: 'Visit acme.com or check the docs at docs.acme.io.',
  },
  {
    name: 'url_mixed',
    input: 'Docs at https://docs.example.com and status at status.example.com.',
  },

  // ── PHONE ────────────────────────────────────────────────────────────────
  {
    name: 'phone_us_dashes',
    input: 'Call me at 918-555-1234 if you need anything.',
  },
  {
    name: 'phone_us_parens',
    input: 'The main line is 415-867-5309 for support.',
  },

  // ── HANDLE ───────────────────────────────────────────────────────────────
  {
    name: 'handle_twitter',
    input: 'Follow the updates at @caseydev on Twitter.',
  },
  {
    name: 'handle_in_text',
    input: 'Ping @jsmith or @kwilliams on Slack.',
  },

  // ── CAMELCASE / PROJECT ───────────────────────────────────────────────────
  {
    name: 'camel_project_name',
    input: 'The OpenClaw gateway handles all agent routing.',
  },
  {
    name: 'camel_farm_project',
    input: 'CrossTimbersFarm is backed up nightly.',
  },
  {
    name: 'camel_multiple',
    input: 'BlueBubbles and RadarScope are on the device.',
  },

  // ── MIXED / REALISTIC ────────────────────────────────────────────────────
  {
    name: 'mixed_intro_prompt',
    input: 'Hi! My name is Casey Zandbergen and I work on Sci, ' +
           'a sovereign cognitive identity layer at sci.com.',
  },
  {
    name: 'mixed_email_and_person',
    input: 'Casey Zandbergen will follow up at casey@sci.dev.',
  },
  {
    name: 'mixed_person_place_url',
    input: 'Sarah is based in Portland and her site is sarah.dev.',
  },
  {
    name: 'mixed_camel_and_org',
    input: 'OpenClaw powers the routing layer for Meridian Corp.',
  },
  {
    name: 'mixed_realistic_message',
    input: 'Just pushed the fix to https://github.com/example/repo — ' +
           'let Casey Zandbergen know and CC ops@example.com.',
  },

  // ── ALLOWLIST NEGATIVE CASES ──────────────────────────────────────────────
  // These inputs contain only allowlisted terms; TS will detect some of
  // them via NLP but the parity test strips them on both sides. Included
  // here to ensure the fixture captures the raw TS output rather than
  // silently producing an empty entity list.
  {
    name: 'allowlist_tech_names',
    input: 'We use TypeScript, React, and Docker in production.',
  },
  {
    name: 'allowlist_ai_tools',
    input: 'Claude and ChatGPT are both useful for code review.',
  },

  // ── EDGE CASES ────────────────────────────────────────────────────────────
  {
    name: 'edge_empty_input',
    input: '',
  },
  {
    name: 'edge_only_punctuation',
    input: '... --- ???',
  },
  {
    name: 'edge_all_lowercase',
    input: 'no entities here, just plain lowercase text for now.',
  },
  {
    name: 'edge_code_fence_skipped',
    input: 'Run `npm install` then build the project.',
  },
  {
    name: 'edge_inline_backtick',
    input: 'Set `OWNER=Casey` in your env before running.',
  },
  {
    name: 'edge_logical_or_not_place',
    input: 'packages are installed OR able to be imported',
  },
  {
    name: 'edge_acknowledgment_ok_not_place',
    input: "OK, let's go to the store.",
  },
  {
    name: 'edge_repeated_name',
    input: 'Casey said hi. Then Casey said goodbye. Finally Casey Zandbergen arrived.',
  },
]

// ── Run ───────────────────────────────────────────────────────────────────────

const fixtures = CORPUS.map(({ name, input }) => {
  const result = anonymize(input)
  return {
    name,
    input,
    expected_text:         result.text,
    expected_entity_count: result.entityCount,
    expected_detected:     result.detected.map(e => ({ text: e.text, type: e.type })),
  }
})

// ── Write ─────────────────────────────────────────────────────────────────────

const outDir  = join(__dirname, 'fixtures')
const outFile = join(outDir, 'anonymizer.json')

mkdirSync(outDir, { recursive: true })
writeFileSync(outFile, JSON.stringify(fixtures, null, 2) + '\n')

console.log(`Wrote ${fixtures.length} fixtures → ${outFile}`)
for (const fx of fixtures) {
  const n = fx.expected_detected.length
  if (n > 0) {
    const names = fx.expected_detected.map(e => `${e.type}(${e.text})`).join(', ')
    console.log(`  [${fx.name}] ${n} entities: ${names}`)
  } else {
    console.log(`  [${fx.name}] (no entities)`)
  }
}
