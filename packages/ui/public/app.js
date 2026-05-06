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
    for (const turn of json.turns ?? []) renderTurn(turn.role, turn.content)
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

function renderTurn(role, content) {
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
  turnsEl.appendChild(turn)
  return bubble
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

  // Render user turn immediately.
  renderTurn('user', message)
  scrollToBottom()

  // Pre-create the assistant bubble; we'll mutate its innerHTML as deltas arrive.
  const assistantBubble = renderTurn('assistant', '')
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
      sendEl.disabled = false
      return
    }

    // Server returns the (newly minted, if applicable) conversation id in
    // a response header so we can update sidebar state.
    const newConvId = res.headers.get('X-Sci-Conversation')
    if (newConvId) state.conversationId = newConvId

    // Parse the SSE stream as it arrives.
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let bound
      while ((bound = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, bound)
        buffer = buffer.slice(bound + 2)
        for (const line of event.split('\n')) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (!payload || payload === '[DONE]') continue
          try {
            const data = JSON.parse(payload)
            if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta') {
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
