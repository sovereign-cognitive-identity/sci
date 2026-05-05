import { readFileSync } from 'fs'
import { createStorageAdapter } from '@sci/core'
import { embed } from '@sci/core'

interface ClaudeMessage {
  sender?: string
  text?: string
  role?: string
  content?: string | Array<{ type: string; text?: string }>
}

interface ClaudeConversation {
  uuid?: string
  name?: string
  created_at?: string
  messages?: ClaudeMessage[]
  chat_messages?: ClaudeMessage[]
}

function isHuman(msg: ClaudeMessage): boolean {
  return msg.sender === 'human' || msg.role === 'human'
}

function extractText(msg: ClaudeMessage): string {
  if (msg.text && msg.text.trim().length > 0) return msg.text.trim()
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter(b => b.type === 'text' && b.text)
      .map(b => b.text!)
      .join(' ')
      .trim()
  }
  if (typeof msg.content === 'string') return msg.content.trim()
  return ''
}

function getMessages(convo: ClaudeConversation): ClaudeMessage[] {
  return convo.chat_messages ?? convo.messages ?? []
}

export async function runImport(opts: {
  file: string
  profile: string
  limit: number
  verbose: boolean
}) {
  const adapter = await createStorageAdapter()

  const raw = JSON.parse(readFileSync(opts.file, 'utf-8'))
  const conversations: ClaudeConversation[] = Array.isArray(raw)
    ? raw
    : (raw.conversations ?? [])

  if (conversations.length === 0) {
    console.error('No conversations found in export file.')
    await adapter.disconnect()
    process.exit(1)
  }

  const profile = await adapter.getProfile(opts.profile)
  if (!profile) {
    console.error(`Profile not found: ${opts.profile}`)
    await adapter.disconnect()
    process.exit(1)
  }

  const batch = conversations.slice(0, opts.limit)
  console.log(`Importing ${batch.length} of ${conversations.length} conversations → profile: ${opts.profile}`)

  let episodicCount = 0
  let skipped = 0

  for (const convo of batch) {
    const messages = getMessages(convo)

    for (const msg of messages) {
      if (!isHuman(msg)) continue
      const text = extractText(msg)
      if (text.length < 30) { skipped++; continue }

      const embedding = await embed(text)
      await adapter.storeEpisodic({
        profileId: profile.id,
        content: text,
        embedding,
        source: 'import',
        metadata: {
          conversation_id: convo.uuid ?? 'unknown',
          conversation_name: convo.name ?? 'unknown',
          imported_at: new Date().toISOString(),
        },
      })

      episodicCount++
      if (opts.verbose || episodicCount % 25 === 0) {
        process.stdout.write(`\r  ${episodicCount} memories stored, ${skipped} skipped   `)
      }
    }
  }

  console.log(`\n✓ Done. ${episodicCount} memories imported from ${opts.file}`)
  await adapter.disconnect()
  return { episodicCount, skipped }
}
