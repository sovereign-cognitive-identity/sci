// Sci chat — vanilla JS client.
//
// Minimal intentionally: the goal is a small audit surface, not a feature-rich
// UI. We talk to the local Sci UI server (this same origin) over fetch + SSE.
// All the privacy work is in the proxy underneath; this file just renders.

// ── State ────────────────────────────────────────────────────────────────────

const state = {
  conversationId: null,           // null until first send → server returns one
  conversations: [],              // sidebar list
  inflightController: null,       // AbortController for current /chat request
}

// ── DOM refs ─────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id)
const turnsEl  = $('turns')
const inputEl  = $('input')
const modelEl  = $('model')
const sendEl   = $('send')
const formEl   = $('composer')
const listEl   = $('conv-list')
const newChatEl = $('new-chat')
const authBannerEl = $('auth-banner')

// ── Markdown rendering (sandboxed via DOMPurify) ─────────────────────────────

marked.setOptions({ gfm: true, breaks: true })

function renderMarkdown(text) {
  const raw = marked.parse(text)
  return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } })
}

// ── Auth status ──────────────────────────────────────────────────────────────

async function checkAuth() {
  try {
    const res = await fetch('/auth/status')
    const json = await res.json()
    if (!json.authed) {
      authBannerEl.hidden = false
      authBannerEl.textContent = 'No OAuth token — run `npm run -w packages/ui auth login` and reload.'
      sendEl.disabled = true
    } else {
      authBannerEl.hidden = true
      sendEl.disabled = false
    }
  } catch (err) {
    console.error('auth status failed:', err)
  }
}

// ── Sidebar (conversation list) ──────────────────────────────────────────────

async function loadConversations() {
  try {
    const res = await fetch('/conversations')
    const json = await res.json()
    state.conversations = json.conversations ?? []
    renderSidebar()
  } catch (err) {
    console.error('list conversations failed:', err)
  }
}

function renderSidebar() {
  listEl.innerHTML = ''
  for (const conv of state.conversations) {
    const li = document.createElement('li')
    li.dataset.id = conv.id
    if (conv.id === state.conversationId) li.classList.add('active')

    const preview = document.createElement('div')
    preview.className = 'preview'
    preview.textContent = conv.preview || '(empty)'
    li.appendChild(preview)

    const meta = document.createElement('div')
    meta.className = 'meta'
    const ts = new Date(conv.lastAt)
    meta.textContent = `${conv.turnCount} turns · ${ts.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}`
    li.appendChild(meta)

    li.addEventListener('click', () => openConversation(conv.id))
    listEl.appendChild(li)
  }
}

// ── Loading an existing conversation ─────────────────────────────────────────

async function openConversation(id) {
  state.conversationId = id
  renderSidebar()
  turnsEl.innerHTML = ''
  try {
    const res = await fetch(`/conversations/${encodeURIComponent(id)}`)
    const json = await res.json()
    for (const turn of json.turns ?? []) renderTurn(turn.role, turn.content, turn.inspector)
    scrollToBottom()
  } catch (err) {
    console.error('load conversation failed:', err)
  }
}

function newChat() {
  state.conversationId = null
  turnsEl.innerHTML = ''
  renderSidebar()
  inputEl.focus()
}

newChatEl.addEventListener('click', newChat)

// ── Rendering turns ──────────────────────────────────────────────────────────

function renderTurn(role, content, inspector) {
  const turn = document.createElement('div')
  turn.className = `turn turn-${role}`
  const bubble = document.createElement('div')
  bubble.className = 'bubble'
  if (role === 'user') {
    bubble.textContent = content
  } else {
    bubble.innerHTML = renderMarkdown(content)
  }
  turn.appendChild(bubble)
  // Inspector panel is rendered inline below the bubble. We always create the
  // container even if there's no data yet — for streaming user turns the
  // sci.anonymized event arrives ~simultaneously with the user bubble, so we
  // attach the data when it lands. Created hidden; opens on click.
  const inspectorEl = document.createElement('details')
  inspectorEl.className = 'inspector'
  inspectorEl.dataset.role = role
  turn.appendChild(inspectorEl)
  if (inspector) populateInspector(inspectorEl, role, inspector)
  turnsEl.appendChild(turn)
  return { bubble, inspectorEl }
}

/**
 * Render the inspector contents based on role and available data.
 *   user turn      → privacy panel (sci.anonymized payload)
 *   assistant turn → de-anonymization summary (sci.deanonymized payload)
 * Idempotent — can be called repeatedly as more data lands during streaming.
 */
function populateInspector(el, role, inspector) {
  if (!inspector) { el.hidden = true; return }
  el.hidden = false
  el.innerHTML = '' // wipe and rebuild

  if (role === 'user' && inspector.anonymized) {
    const a = inspector.anonymized
    const summary = document.createElement('summary')
    const count = (a.entities || []).length
    summary.innerHTML = count > 0
      ? `<span class="inspector-icon">🔒</span> ${count} ${count === 1 ? 'entity' : 'entities'} masked before send`
      : `<span class="inspector-icon">○</span> nothing detected to mask`
    el.appendChild(summary)

    const body = document.createElement('div')
    body.className = 'inspector-body'

    if (count > 0) {
      const table = document.createElement('table')
      table.className = 'inspector-table'
      table.innerHTML = `<thead><tr><th>Original</th><th>Type</th><th>Sent as</th></tr></thead>`
      const tbody = document.createElement('tbody')
      for (const e of a.entities) {
        const tr = document.createElement('tr')
        tr.innerHTML = `
          <td><code>${escapeHtml(e.original)}</code></td>
          <td><span class="entity-type">${escapeHtml(e.type)}</span></td>
          <td><code class="entity-token">${escapeHtml(e.token ?? '?')}</code></td>
        `
        tbody.appendChild(tr)
      }
      table.appendChild(tbody)
      body.appendChild(table)
    }

    if (a.original && a.masked && a.original !== a.masked) {
      const wrap = document.createElement('div')
      wrap.className = 'inspector-diff'
      wrap.innerHTML = `
        <div class="inspector-pair">
          <div class="inspector-label">You typed</div>
          <pre>${escapeHtml(a.original)}</pre>
        </div>
        <div class="inspector-pair">
          <div class="inspector-label">Anthropic saw</div>
          <pre>${escapeHtml(a.masked)}</pre>
        </div>
      `
      body.appendChild(wrap)
    }

    el.appendChild(body)
    return
  }

  if (role === 'assistant' && inspector.deanonymized) {
    const d = inspector.deanonymized
    const summary = document.createElement('summary')
    const n = d.tokensReplaced ?? 0
    summary.innerHTML = n > 0
      ? `<span class="inspector-icon">🔓</span> ${n} ${n === 1 ? 'token' : 'tokens'} unmasked in reply`
      : `<span class="inspector-icon">○</span> reply contained no Sci tokens`
    el.appendChild(summary)

    if (Array.isArray(d.replaced) && d.replaced.length > 0) {
      const body = document.createElement('div')
      body.className = 'inspector-body'
      const table = document.createElement('table')
      table.className = 'inspector-table'
      table.innerHTML = `<thead><tr><th>Token in reply</th><th>Restored to</th><th>×</th></tr></thead>`
      const tbody = document.createElement('tbody')
      for (const r of d.replaced) {
        const tr = document.createElement('tr')
        tr.innerHTML = `
          <td><code class="entity-token">${escapeHtml(r.token)}</code></td>
          <td><code>${escapeHtml(r.original)}</code></td>
          <td>${r.count}</td>
        `
        tbody.appendChild(tr)
      }
      table.appendChild(tbody)
      body.appendChild(table)
      el.appendChild(body)
    }
    return
  }

  // No matching data — keep the panel hidden.
  el.hidden = true
}

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function scrollToBottom() {
  turnsEl.scrollTop = turnsEl.scrollHeight
}

// ── Sending a message ────────────────────────────────────────────────────────

formEl.addEventListener('submit', async (evt) => {
  evt.preventDefault()
  const message = inputEl.value.trim()
  if (!message || sendEl.disabled) return

  sendEl.disabled = true
  inputEl.value = ''

  // Render user turn immediately. We hold a ref to the inspector panel so
  // the sci.anonymized event (which arrives ~together with the first response
  // chunks) can populate it live.
  const userTurnRef = renderTurn('user', message)
  scrollToBottom()

  // Pre-create the assistant bubble; we'll mutate its innerHTML as deltas arrive.
  const assistantTurnRef = renderTurn('assistant', '')
  const assistantBubble = assistantTurnRef.bubble
  const assistantInspector = assistantTurnRef.inspectorEl
  assistantBubble.classList.add('thinking')
  let assistantText = ''
  scrollToBottom()

  state.inflightController = new AbortController()

  try {
    const res = await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: state.inflightController.signal,
      body: JSON.stringify({
        conversationId: state.conversationId,
        message,
        model: modelEl.value,
      }),
    })

    if (!res.ok) {
      const text = await res.text()
      assistantBubble.classList.remove('thinking')
      assistantBubble.innerHTML = renderMarkdown(`**error (${res.status})**\n\n\`\`\`\n${text}\n\`\`\``)
      assistantInspector.hidden = true
      sendEl.disabled = false
      return
    }

    // Server returns the (newly minted, if applicable) conversation id in
    // a response header so we can update sidebar state.
    const newConvId = res.headers.get('X-Sci-Conversation')
    if (newConvId) state.conversationId = newConvId

    // Parse the SSE stream as it arrives. We track the `event:` line so
    // sci.anonymized / sci.deanonymized payloads route to the inspectors,
    // and Anthropic content_block_delta payloads route to the bubble.
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let bound
      while ((bound = buffer.indexOf('\n\n')) !== -1) {
        const eventBlock = buffer.slice(0, bound)
        buffer = buffer.slice(bound + 2)
        let evName = null
        for (const line of eventBlock.split('\n')) {
          if (line.startsWith('event:')) {
            evName = line.slice(6).trim()
          } else if (line.startsWith('data:')) {
            const payload = line.slice(5).trim()
            if (!payload || payload === '[DONE]') continue
            try {
              const data = JSON.parse(payload)
              if (evName === 'sci.anonymized') {
                populateInspector(userTurnRef.inspectorEl, 'user', { anonymized: data })
              } else if (evName === 'sci.deanonymized') {
                populateInspector(assistantInspector, 'assistant', { deanonymized: data })
              } else if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta') {
                assistantText += data.delta.text
                assistantBubble.innerHTML = renderMarkdown(assistantText)
                scrollToBottom()
              }
            } catch {
              /* heartbeats / non-JSON lines — ignore */
            }
          }
        }
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      assistantBubble.innerHTML = renderMarkdown(`**stream error**: ${err.message}`)
    }
  } finally {
    assistantBubble.classList.remove('thinking')
    sendEl.disabled = false
    inputEl.focus()
    // Refresh the sidebar so a new conversation shows up.
    loadConversations()
  }
})

// Cmd/Ctrl+Enter sends without needing the button.
inputEl.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    formEl.requestSubmit()
  }
})

// ── Boot ─────────────────────────────────────────────────────────────────────

checkAuth()
loadConversations()
