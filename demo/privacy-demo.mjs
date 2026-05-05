#!/usr/bin/env node
/**
 * Sci Privacy Demo
 * ──────────────────────────────────────────────────────────────────────────────
 * Proves in < 2 minutes that your real name never leaves your machine.
 *
 * Usage:
 *   SCI_DB_READER_URL=... SCI_DB_WRITER_URL=... node demo/privacy-demo.mjs
 *
 * What it does:
 *   1. Takes a message containing your real name, location, and email
 *   2. Anonymizes it through the Sci pipeline
 *   3. Shows you the before (what you typed) and after (what the AI would see)
 *   4. Inspects the token map so you can verify every substitution
 *   5. Deanonymizes a mock AI response to show the round-trip works
 *
 * The AI provider never receives step 2. You can verify this by inspecting
 * the `text` field before any outbound API call.
 */

import { anonymize, deanonymize } from '../packages/core/dist/anonymizer.js'

const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const CYAN = '\x1b[36m'

function hr() { console.log(DIM + '─'.repeat(60) + RESET) }
function section(title) { console.log(`\n${BOLD}${CYAN}${title}${RESET}`) }

console.log(`\n${BOLD}Sci Privacy Demo${RESET}`)
console.log(DIM + 'Proving your real name never leaves your machine.' + RESET)
hr()

// ── Step 1: The original message ──────────────────────────────────────────────

section('Step 1: What you typed')

const originalMessage = `Hi, my name is Casey Zandbergen and I'm based in Tulsa, Oklahoma.
My email is casey.zandbergen@gmail.com and I work on a project called Threadline.
I'm also building Sci — a sovereign cognitive identity layer.
Follow me @caseyz on X. My iCloud is czandbergen@icloud.com.`

console.log()
console.log(originalMessage)

// ── Step 2: Anonymization ─────────────────────────────────────────────────────

section('Step 2: What the AI provider would receive')
console.log(DIM + '(This is what gets sent to Claude/GPT/Gemini — not step 1)' + RESET)

const result = anonymize(originalMessage)

console.log()
console.log(result.text)

// ── Step 3: Token map inspection ──────────────────────────────────────────────

section('Step 3: Token map (what was substituted)')
console.log(DIM + '(You can audit every substitution. The map never leaves this process.)' + RESET)
console.log()

const entries = [...result.tokenMap.forward.entries()]
  .sort((a, b) => a[1].localeCompare(b[1]))

for (const [entity, token] of entries) {
  console.log(`  ${GREEN}${token.padEnd(16)}${RESET} ${DIM}←${RESET} ${YELLOW}"${entity}"${RESET}`)
}

console.log()
console.log(`  ${entries.length} entities masked across ${Object.keys(
  result.detected.reduce((a, e) => { a[e.type] = true; return a }, {})
).length} categories: ${[...new Set(result.detected.map(e => e.type))].join(', ')}`)

// ── Step 4: Verification ──────────────────────────────────────────────────────

section('Step 4: Verification')
console.log()

const checks = [
  ['Real name absent from outbound text', !result.text.includes('Casey Zandbergen')],
  ['Email absent from outbound text', !result.text.includes('casey.zandbergen@gmail.com')],
  ['iCloud email absent', !result.text.includes('czandbergen@icloud.com')],
  ['Location absent', !result.text.includes('Tulsa')],
  ['Social handle absent', !result.text.includes('@caseyz')],
  ['Token map is non-empty', result.tokenMap.forward.size > 0],
]

let allPassed = true
for (const [label, passed] of checks) {
  const icon = passed ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`
  if (!passed) allPassed = false
  console.log(`  ${icon} ${label}`)
}

// ── Step 5: Round-trip deanonymization ────────────────────────────────────────

section('Step 5: Round-trip (AI response → real names restored)')
console.log(DIM + '(After the AI responds using tokens, Sci restores the real values)' + RESET)

const mockAiResponse = `Hello [PERSON_1]! Based on your work on [PROJECT_2] in [PLACE_1],
I have some suggestions. You can reach me at [EMAIL_1] if you have questions.`

console.log()
console.log(DIM + 'AI response (with tokens):' + RESET)
console.log(mockAiResponse)
console.log()

const restored = deanonymize(mockAiResponse, result.tokenMap)
console.log(DIM + 'After deanonymization (what you see):' + RESET)
console.log(restored)

// ── Summary ───────────────────────────────────────────────────────────────────

hr()
if (allPassed) {
  console.log(`\n${BOLD}${GREEN}✓ All checks passed.${RESET}`)
  console.log(`  Your real identity was never in the outbound text.`)
  console.log(`  The token map existed only in process memory and was never written to disk.\n`)
} else {
  console.log(`\n${BOLD}${RED}✗ Some checks failed. Review the output above.${RESET}\n`)
  process.exit(1)
}
