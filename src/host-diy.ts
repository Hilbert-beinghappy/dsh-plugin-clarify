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
    <button type="button" id="accept" disabled>Accept preview</button>
    <button type="button" id="refine" disabled>Refine preview</button>
    <button type="button" id="cancel" disabled>Cancel</button>
    <button type="button" id="fetch" disabled>Fetch draft</button>
    <button type="button" id="copy" disabled>Copy draft</button>
  </div>
  <label>refine feedback (one-shot, not seed)<br/><textarea id="feedback" rows="2" placeholder="what to change in the current preview"></textarea></label>
  <p id="status" class="muted">idle</p>
  <p id="error" class="error"></p>
  <section id="previewPanel" hidden>
    <h2>Current draft preview</h2>
    <pre id="preview" class="draft"></pre>
    <h3>Changes this round</h3>
    <ul id="changes"></ul>
  </section>
  <div id="question"></div>
  <pre id="draft" class="draft" hidden></pre>
  <script>
    const NS = ${JSON.stringify(CLARIFY_REMOTE_NAMESPACE)}
    const METHODS = ${JSON.stringify(CLARIFY_REMOTE_METHODS)}
    window.CLARIFY_REMOTE = {
      namespace: NS,
      methods: METHODS,
      protocol: 'clarify.wire/1',
      channel: '/api',
      endpoints: ${JSON.stringify(CLARIFY_REMOTE_METHODS.map((method) => `${CLARIFY_REMOTE_NAMESPACE}/${method}`))},
    }
    const els = {
      seed: document.getElementById('seed'),
      sessionId: document.getElementById('sessionId'),
      start: document.getElementById('start'),
      answer: document.getElementById('answer'),
      accept: document.getElementById('accept'),
      refine: document.getElementById('refine'),
      feedback: document.getElementById('feedback'),
      cancel: document.getElementById('cancel'),
      fetch: document.getElementById('fetch'),
      copy: document.getElementById('copy'),
      status: document.getElementById('status'),
      error: document.getElementById('error'),
      previewPanel: document.getElementById('previewPanel'),
      preview: document.getElementById('preview'),
      changes: document.getElementById('changes'),
      question: document.getElementById('question'),
      draft: document.getElementById('draft'),
    }
    const state = { processId: '', question: null, draft: '', echo: null, previewVersion: '', busy: false }
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
        const failure = new Error((err.code || 'rpc') + ': ' + (err.message || text))
        failure.code = err.code || 'rpc'
        throw failure
      }
      return unwrapWire(json.result.value)
    }
    function unwrapWire(value) {
      if (!value || value.protocol !== 'clarify.wire/1' || typeof value.ok !== 'boolean') {
        const failure = new Error('Clarify response is not clarify.wire/1')
        failure.code = 'INVALID_ANSWER'
        failure.category = 'protocol'
        throw failure
      }
      if (value.ok === true) return value.value
      const err = value.error || {}
      const failure = new Error((err.code || 'rpc') + ': ' + (err.message || 'Clarify wire failure'))
      failure.code = err.code || 'rpc'
      failure.category = err.category
      throw failure
    }
    async function clarify(method, args) {
      return call(NS + '/' + method, { args })
    }
    function showError(error) {
      els.error.textContent = error instanceof Error ? error.message : String(error)
    }
    async function recoverLatest(error, method) {
      if (!error || error.category !== 'conflict') return false
      if (error.code === 'PROCESS_BUSY') {
        const latest = await clarify('fetchDraft', { processId: state.processId })
        renderEcho(latest)
        renderQuestion(latest.question)
        els.error.textContent = error.code + ': still inferring; reloaded the latest Host state without resubmitting'
        return true
      }
      if (error.code === 'PROCESS_NOT_FOUND') {
        els.error.textContent = error.code + ': process is gone; start a new process on the same session'
        return true
      }
      const reviewedPreviewVersion = state.previewVersion
      const latest = await clarify('fetchDraft', { processId: state.processId })
      if (latest && latest.status === 'complete') {
        if (method === 'answer' || method === 'refine') {
          throw new Error('Clarify ' + method + ' recovery reached complete before explicit preview review and acceptance')
        }
        if (latest.previewVersion !== reviewedPreviewVersion) {
          throw new Error('Clarify completed with a different preview version than the one you reviewed and confirmed; the unreviewed draft will not be exposed')
        }
      }
      renderEcho(latest)
      renderQuestion(latest.question)
      els.error.textContent = error.code + ': operation not committed; reloaded the latest Host state'
      return true
    }
    async function recoverOrShow(error, method) {
      try {
        if (await recoverLatest(error, method)) return
        showError(error)
      } catch (recoveryError) {
        showError(recoveryError)
      }
    }
    function rejectPrematureComplete(method, echo) {
      if (echo && echo.status === 'complete') {
        throw new Error('Clarify ' + method + ' returned complete before explicit preview review and acceptance')
      }
      return echo
    }
    function renderPreview(echo) {
      const running = echo && echo.status === 'running'
      const preview = running && typeof echo.draftPreview === 'string' ? echo.draftPreview : ''
      els.previewPanel.hidden = !preview
      els.preview.textContent = preview
      els.changes.replaceChildren()
      if (!preview) return
      for (const change of Array.isArray(echo.materialChanges) ? echo.materialChanges : []) {
        const item = document.createElement('li')
        item.textContent = change
        els.changes.appendChild(item)
      }
    }
    function syncControls() {
      const echo = state.echo
      const running = echo && echo.status === 'running'
      const complete = echo && echo.status === 'complete'
      els.start.disabled = state.busy
      els.answer.disabled = state.busy || !running || echo.kind !== 'ask' || !state.question
      els.accept.disabled = state.busy || !running || !state.previewVersion || typeof echo.draftPreview !== 'string'
      els.refine.disabled = state.busy || !running || !state.previewVersion || typeof echo.draftPreview !== 'string'
      els.cancel.disabled = state.busy || !state.processId
      els.fetch.disabled = state.busy || !complete
      els.copy.disabled = state.busy || !state.draft
    }
    function setBusy(busy) {
      state.busy = busy
      syncControls()
    }
    function renderEcho(echo) {
      state.echo = echo
      state.processId = echo && echo.processId || state.processId
      const running = echo && echo.status === 'running'
      state.previewVersion = running && typeof echo.previewVersion === 'string' ? echo.previewVersion : ''
      const bits = [echo && echo.status, echo && echo.processId, echo && echo.previewVersion, echo && echo.staleReason].filter(Boolean)
      els.status.textContent = bits.join(' · ') || 'idle'
      if (!running || echo.kind !== 'ask') state.question = null
      renderPreview(echo)
      if (!running) {
        state.draft = ''
        els.question.innerHTML = ''
        els.draft.hidden = true
      }
      syncControls()
    }
    function renderQuestion(question) {
      state.question = question || null
      els.question.innerHTML = ''
      if (!question) {
        syncControls()
        return
      }
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
      syncControls()
    }
    function selectedArgs() {
      const question = state.question
      if (!question) throw new Error('no current question')
      const custom = document.getElementById('custom')
      const customText = custom && custom.value.trim()
      const selected = [...document.querySelectorAll('input[name=option]:checked')].map((node) => node.value)
      if (customText) {
        if (selected.length) throw new Error('selectedOptionIds and customText are mutually exclusive')
        return { processId: state.processId, questionId: question.questionId, previewVersion: state.previewVersion, customText }
      }
      return { processId: state.processId, questionId: question.questionId, previewVersion: state.previewVersion, selectedOptionIds: selected }
    }
    els.start.addEventListener('click', async () => {
      if (state.busy) return
      setBusy(true)
      els.error.textContent = ''
      try {
        const sessionId = els.sessionId.value.trim()
        if (!sessionId) {
          throw new Error('sessionId is required. Paste an existing Host session. Auto-discovery is blocked; this page will not create one.')
        }
        const args = { sessionId }
        const seed = els.seed.value.trim()
        if (seed) args.seedText = seed
        const started = rejectPrematureComplete('start', await clarify('start', args))
        renderEcho(started)
        renderQuestion(started.question)
        els.draft.hidden = true
      } catch (error) { showError(error) }
      finally { setBusy(false) }
    })
    els.answer.addEventListener('click', async () => {
      if (state.busy) return
      setBusy(true)
      els.error.textContent = ''
      try {
        const next = rejectPrematureComplete('answer', await clarify('answer', selectedArgs()))
        renderEcho(next)
        renderQuestion(next.question)
      } catch (error) { await recoverOrShow(error, 'answer') }
      finally { setBusy(false) }
    })
    els.accept.addEventListener('click', async () => {
      if (state.busy) return
      setBusy(true)
      els.error.textContent = ''
      try {
        const completed = await clarify('accept', { processId: state.processId, previewVersion: state.previewVersion })
        renderEcho(completed)
        renderQuestion(null)
        if (completed.status === 'complete') {
          els.fetch.disabled = false
        }
      } catch (error) { await recoverOrShow(error, 'accept') }
      finally { setBusy(false) }
    })
    els.refine.addEventListener('click', async () => {
      if (state.busy) return
      setBusy(true)
      els.error.textContent = ''
      try {
        const feedback = els.feedback && els.feedback.value.trim()
        if (!feedback) throw new Error('feedback is required')
        const next = rejectPrematureComplete('refine', await clarify('refine', {
          processId: state.processId,
          previewVersion: state.previewVersion,
          feedback: feedback,
        }))
        renderEcho(next)
        renderQuestion(next.question)
      } catch (error) { await recoverOrShow(error, 'refine') }
      finally { setBusy(false) }
    })
    els.cancel.addEventListener('click', async () => {
      if (state.busy) return
      setBusy(true)
      els.error.textContent = ''
      try {
        const cancelled = await clarify('cancel', { processId: state.processId })
        renderEcho(cancelled)
        renderQuestion(null)
      } catch (error) { showError(error) }
      finally { setBusy(false) }
    })
    els.fetch.addEventListener('click', async () => {
      if (state.busy) return
      setBusy(true)
      els.error.textContent = ''
      try {
        const fetched = await clarify('fetchDraft', { processId: state.processId })
        renderEcho(fetched)
        if (fetched.draft) {
          state.draft = fetched.draft
          els.draft.hidden = false
          els.draft.textContent = fetched.draft
        } else {
          state.draft = ''
          els.draft.hidden = true
        }
      } catch (error) { showError(error) }
      finally { setBusy(false) }
    })
    els.copy.addEventListener('click', async () => {
      if (state.busy || !state.draft) return
      await navigator.clipboard.writeText(state.draft)
      els.status.textContent = 'draft copied — paste into the regular composer yourself; this page does not send'
    })
  </script>
</body>
</html>
`
}
