import type { IncomingMessage, ServerResponse } from 'node:http'
import { CLARIFY_REMOTE_METHODS, CLARIFY_REMOTE_NAMESPACE } from './compat.ts'

export const CLARIFY_HTML_PATH = '/clarify'

export interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

export function registerClarifyHostDiy(webServer: WebServerLike): void {
  webServer.register({
    kind: 'exact',
    path: CLARIFY_HTML_PATH,
    handler: (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(clarifyDiyHtml())
    },
  })
}

export function clarifyDiyHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Clarify</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { max-width: 46rem; margin: 1.5rem auto; padding: 0 1rem; }
    label, p, button, textarea, input { font: inherit; }
    fieldset { border: 1px solid currentColor; margin: 1rem 0; padding: .75rem 1rem; }
    textarea, input[type=text] { width: 100%; box-sizing: border-box; }
    .row { display: flex; flex-wrap: wrap; gap: .5rem; margin: .75rem 0; }
    .draft { white-space: pre-wrap; border: 1px dashed currentColor; padding: .75rem; }
    .muted { opacity: .75; }
    .error { color: #b00020; }
  </style>
</head>
<body>
  <h1>Clarify</h1>
  <p class="muted">Same Typert Remote methods as every other surface: ${CLARIFY_REMOTE_METHODS.join(', ')} under namespace <code>${CLARIFY_REMOTE_NAMESPACE}</code>. Calls go to stock <code>POST /api/${CLARIFY_REMOTE_NAMESPACE}/&lt;method&gt;</code>. Bind an <strong>existing</strong> Host <code>sessionId</code>. This page never creates or hides a Session and never auto-sends a draft. Stock Web current-session auto-discovery is a capability block: paste a sessionId the user already has.</p>
  <label>seedText (optional)<br/><textarea id="seed" rows="3" placeholder="half-written ask"></textarea></label>
  <label>sessionId (required; existing Host session only)<br/><input id="sessionId" type="text" autocomplete="off" required/></label>
  <div class="row">
    <button type="button" id="start">Start</button>
    <button type="button" id="answer" disabled>Answer</button>
    <button type="button" id="cancel" disabled>Cancel</button>
    <button type="button" id="fetch" disabled>Fetch draft</button>
    <button type="button" id="copy" disabled>Copy draft</button>
  </div>
  <p id="status" class="muted">idle</p>
  <p id="error" class="error"></p>
  <div id="question"></div>
  <pre id="draft" class="draft" hidden></pre>
  <script>
    const NS = ${JSON.stringify(CLARIFY_REMOTE_NAMESPACE)}
    const METHODS = ${JSON.stringify(CLARIFY_REMOTE_METHODS)}
    window.CLARIFY_REMOTE = {
      namespace: NS,
      methods: METHODS,
      channel: '/api',
      endpoints: ${JSON.stringify(CLARIFY_REMOTE_METHODS.map((method) => `${CLARIFY_REMOTE_NAMESPACE}/${method}`))},
    }
    const els = {
      seed: document.getElementById('seed'),
      sessionId: document.getElementById('sessionId'),
      start: document.getElementById('start'),
      answer: document.getElementById('answer'),
      cancel: document.getElementById('cancel'),
      fetch: document.getElementById('fetch'),
      copy: document.getElementById('copy'),
      status: document.getElementById('status'),
      error: document.getElementById('error'),
      question: document.getElementById('question'),
      draft: document.getElementById('draft'),
    }
    const state = { processId: '', question: null, draft: '', echo: null }
    function rpcId() { return crypto.randomUUID() }
    async function call(method, payload) {
      const body = { type: 'client-request', rpcId: rpcId(), method, payload }
      const response = await fetch('/api/' + method, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const text = await response.text()
      let json
      try { json = JSON.parse(text) } catch { throw new Error('non-JSON ' + response.status) }
      if (!json || json.type !== 'server-response') throw new Error('unexpected envelope')
      if (!json.result || json.result.ok !== true) {
        const err = json.result && json.result.error ? json.result.error : {}
        throw new Error((err.code || 'rpc') + ': ' + (err.message || text))
      }
      return json.result.value
    }
    async function clarify(method, args) {
      return call(NS + '/' + method, { args })
    }
    function showError(error) {
      els.error.textContent = error instanceof Error ? error.message : String(error)
    }
    function renderEcho(echo) {
      state.echo = echo
      state.processId = echo && echo.processId || state.processId
      const bits = [echo && echo.status, echo && echo.processId, echo && echo.staleReason].filter(Boolean)
      els.status.textContent = bits.join(' · ') || 'idle'
      const running = echo && echo.status === 'running'
      const complete = echo && echo.status === 'complete'
      els.answer.disabled = !running || !state.question
      els.cancel.disabled = !state.processId
      els.fetch.disabled = !complete
      if (echo && echo.status === 'stale') {
        state.question = null
        state.draft = ''
        els.question.innerHTML = ''
        els.draft.hidden = true
        els.copy.disabled = true
      }
    }
    function renderQuestion(question) {
      state.question = question || null
      els.question.innerHTML = ''
      if (!question) return
      const box = document.createElement('fieldset')
      const legend = document.createElement('legend')
      legend.textContent = question.text + (question.multiple ? ' (multiple)' : ' (single)')
      box.appendChild(legend)
      for (const option of question.options || []) {
        const id = 'opt-' + option.optionId
        const label = document.createElement('label')
        const input = document.createElement('input')
        input.type = question.multiple ? 'checkbox' : 'radio'
        input.name = 'option'
        input.value = option.optionId
        input.id = id
        label.appendChild(input)
        label.appendChild(document.createTextNode(' ' + option.text))
        box.appendChild(label)
        box.appendChild(document.createElement('br'))
      }
      if (question.allowCustom) {
        const custom = document.createElement('textarea')
        custom.id = 'custom'
        custom.rows = 2
        custom.placeholder = 'customText (XOR with selectedOptionIds)'
        box.appendChild(custom)
      }
      els.question.appendChild(box)
      els.answer.disabled = false
    }
    function selectedArgs() {
      const question = state.question
      if (!question) throw new Error('no current question')
      const custom = document.getElementById('custom')
      const customText = custom && custom.value.trim()
      const selected = [...document.querySelectorAll('input[name=option]:checked')].map((node) => node.value)
      if (customText) {
        if (selected.length) throw new Error('selectedOptionIds and customText are mutually exclusive')
        return { processId: state.processId, questionId: question.questionId, customText }
      }
      return { processId: state.processId, questionId: question.questionId, selectedOptionIds: selected }
    }
    els.start.addEventListener('click', async () => {
      els.error.textContent = ''
      try {
        const sessionId = els.sessionId.value.trim()
        if (!sessionId) {
          throw new Error('sessionId is required. Paste an existing Host session. Auto-discovery is blocked; this page will not create one.')
        }
        const args = { sessionId }
        const seed = els.seed.value.trim()
        if (seed) args.seedText = seed
        const started = await clarify('start', args)
        renderEcho(started)
        renderQuestion(started.question)
        els.draft.hidden = true
        els.copy.disabled = true
      } catch (error) { showError(error) }
    })
    els.answer.addEventListener('click', async () => {
      els.error.textContent = ''
      try {
        const next = await clarify('answer', selectedArgs())
        renderEcho(next)
        renderQuestion(next.question)
        if (next.status === 'complete') {
          els.fetch.disabled = false
        }
      } catch (error) { showError(error) }
    })
    els.cancel.addEventListener('click', async () => {
      els.error.textContent = ''
      try {
        const cancelled = await clarify('cancel', { processId: state.processId })
        renderEcho(cancelled)
        renderQuestion(null)
      } catch (error) { showError(error) }
    })
    els.fetch.addEventListener('click', async () => {
      els.error.textContent = ''
      try {
        const fetched = await clarify('fetchDraft', { processId: state.processId })
        renderEcho(fetched)
        if (fetched.draft) {
          state.draft = fetched.draft
          els.draft.hidden = false
          els.draft.textContent = fetched.draft
          els.copy.disabled = false
        } else {
          state.draft = ''
          els.draft.hidden = true
          els.copy.disabled = true
        }
      } catch (error) { showError(error) }
    })
    els.copy.addEventListener('click', async () => {
      if (!state.draft) return
      await navigator.clipboard.writeText(state.draft)
      els.status.textContent = 'draft copied — paste into the regular composer yourself; this page does not send'
    })
  </script>
</body>
</html>
`
}
