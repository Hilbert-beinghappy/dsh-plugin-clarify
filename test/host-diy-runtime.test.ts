import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { clarifyDiyHtml } from '../src/host-diy.ts'

type Listener = () => void | Promise<void>

class FakeElement {
  readonly children: FakeElement[] = []
  readonly listeners = new Map<string, Listener>()
  type = ''
  name = ''
  value = ''
  checked = false
  disabled = false
  hidden = false
  textContent = ''
  rows = 0
  placeholder = ''
  private html = ''

  constructor(readonly tagName: string, public id = '') {}

  get innerHTML(): string {
    return this.html
  }

  set innerHTML(value: string) {
    this.html = value
    this.children.length = 0
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child)
    return child
  }

  replaceChildren(...children: FakeElement[]): void {
    this.children.splice(0, this.children.length, ...children)
  }

  addEventListener(name: string, listener: Listener): void {
    this.listeners.set(name, listener)
  }

  async dispatch(name: string): Promise<void> {
    const listener = this.listeners.get(name)
    if (!listener) throw new Error(`missing ${name} listener on #${this.id}`)
    await listener()
  }
}

class FakeDocument {
  readonly elements = new Map<string, FakeElement>()

  constructor(ids: readonly string[]) {
    for (const id of ids) this.elements.set(id, new FakeElement('div', id))
  }

  getElementById(id: string): FakeElement | null {
    if (id === 'custom') return this.find(this.elements.get('question'), element => element.id === id)
    return this.elements.get(id) ?? null
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName)
  }

  createTextNode(text: string): FakeElement {
    const node = new FakeElement('#text')
    node.textContent = text
    return node
  }

  querySelectorAll(selector: string): FakeElement[] {
    if (selector !== 'input[name=option]:checked') return []
    const found: FakeElement[] = []
    this.walk(this.elements.get('question'), (element) => {
      if (element.tagName === 'input' && element.name === 'option' && element.checked) found.push(element)
    })
    return found
  }

  private find(root: FakeElement | undefined, predicate: (element: FakeElement) => boolean): FakeElement | null {
    let match: FakeElement | null = null
    this.walk(root, (element) => {
      if (match === null && predicate(element)) match = element
    })
    return match
  }

  private walk(root: FakeElement | undefined, visit: (element: FakeElement) => void): void {
    if (!root) return
    visit(root)
    for (const child of root.children) this.walk(child, visit)
  }
}

type RpcStep =
  | { readonly endpoint: string; readonly value: Record<string, unknown>; readonly hold?: Promise<void> }
  | {
      readonly endpoint: string
      readonly error: { readonly code: string; readonly message: string; readonly category?: string }
      readonly hold?: Promise<void>
      readonly gateway?: boolean
    }

const elementIds = [
  'seed', 'sessionId', 'start', 'answer', 'accept', 'refine', 'feedback', 'cancel', 'fetch', 'copy',
  'status', 'error', 'previewPanel', 'preview', 'changes', 'question', 'draft',
] as const

const question = {
  questionId: 'question-1',
  text: 'Which outcome matters most?',
  options: [
    { optionId: 'option-safe', text: 'Safety' },
    { optionId: 'option-fast', text: 'Speed' },
  ],
  multiple: false,
  allowCustom: false,
}

function running(
  kind: 'ask' | 'await_accept',
  previewVersion: string,
  draftPreview: string,
  materialChanges: string[],
  activeQuestion = question,
) {
  return {
    processId: 'process-1',
    sessionId: 'session-1',
    status: 'running',
    contextVersion: 'context-1',
    modelRouteId: 'route-1',
    kind,
    previewVersion,
    draftPreview,
    materialChanges,
    ...(kind === 'ask' ? { question: activeQuestion } : {}),
  }
}

function terminal(status: 'complete' | 'cancelled', extra: Record<string, unknown> = {}) {
  return {
    processId: 'process-1',
    sessionId: 'session-1',
    status,
    contextVersion: 'context-1',
    modelRouteId: 'route-1',
    previewVersion: 'preview-2',
    ...extra,
  }
}

function boot(steps: RpcStep[]) {
  const document = new FakeDocument(elementIds)
  document.getElementById('sessionId')!.value = 'session-1'
  document.getElementById('answer')!.disabled = true
  document.getElementById('accept')!.disabled = true
  document.getElementById('refine')!.disabled = true
  document.getElementById('cancel')!.disabled = true
  document.getElementById('fetch')!.disabled = true
  document.getElementById('copy')!.disabled = true
  document.getElementById('previewPanel')!.hidden = true
  document.getElementById('draft')!.hidden = true
  const calls: Array<{ endpoint: string; args: Record<string, unknown> }> = []
  const queue = [...steps]
  const fetch = vi.fn(async (_url: string, init: { body?: string }) => {
    const body = JSON.parse(init.body ?? '{}') as { method: string; payload?: { args?: Record<string, unknown> } }
    const step = queue.shift()
    if (!step) throw new Error(`unexpected ${body.method}`)
    expect(body.method).toBe(step.endpoint)
    calls.push({ endpoint: body.method, args: body.payload?.args ?? {} })
    if (step.hold) await step.hold
    const result = 'error' in step
      ? step.gateway === true
        ? { ok: false, error: step.error }
        : {
            ok: true,
            value: {
              protocol: 'clarify.wire/1',
              ok: false,
              error: {
                code: step.error.code,
                message: step.error.message,
                category: step.error.category ?? 'conflict',
              },
            },
          }
      : { ok: true, value: { protocol: 'clarify.wire/1', ok: true, value: step.value } }
    return {
      status: 200,
      text: async () => JSON.stringify({ type: 'server-response', rpcId: 'response-1', result }),
    }
  })
  const script = clarifyDiyHtml().match(/<script>([\s\S]*?)<\/script>/)?.[1]
  if (!script) throw new Error('Clarify DIY inline script is missing')
  runInNewContext(script, {
    window: {},
    document,
    fetch,
    crypto: { randomUUID: () => 'request-1' },
    navigator: { clipboard: { writeText: vi.fn() } },
  })
  return { document, calls }
}

function currentOption(document: FakeDocument): FakeElement {
  const option = document.querySelectorAll('input[name=option]:checked')[0]
    ?? document.getElementById('question')?.children[0]?.children.find(child => child.tagName === 'label')?.children[0]
  if (!option) throw new Error('rendered option input is missing')
  return option
}

describe('Clarify Host DIY executable interaction', () => {
  it('renders evolving previews, gates actions, accepts, and fetches the frozen draft', async () => {
    const { document, calls } = boot([
      { endpoint: 'clarify/start', value: running('ask', 'preview-1', 'Initial dynamic preview', ['Opened the goal question']) },
      { endpoint: 'clarify/answer', value: running('await_accept', 'preview-2', 'Ready dynamic preview', ['Resolved the selected priority']) },
      { endpoint: 'clarify/accept', value: terminal('complete') },
      { endpoint: 'clarify/fetchDraft', value: terminal('complete', { draft: 'Frozen user draft' }) },
    ])

    await document.getElementById('start')!.dispatch('click')
    expect(document.getElementById('previewPanel')!.hidden).toBe(false)
    expect(document.getElementById('preview')!.textContent).toBe('Initial dynamic preview')
    expect(document.getElementById('changes')!.children[0]?.textContent).toBe('Opened the goal question')
    expect(document.getElementById('answer')!.disabled).toBe(false)
    expect(document.getElementById('accept')!.disabled).toBe(false)
    expect(document.getElementById('refine')!.disabled).toBe(false)

    currentOption(document).checked = true
    await document.getElementById('answer')!.dispatch('click')
    expect(document.getElementById('preview')!.textContent).toBe('Ready dynamic preview')
    expect(document.getElementById('answer')!.disabled).toBe(true)
    expect(document.getElementById('accept')!.disabled).toBe(false)

    await document.getElementById('accept')!.dispatch('click')
    expect(document.getElementById('previewPanel')!.hidden).toBe(true)
    expect(document.getElementById('fetch')!.disabled).toBe(false)
    await document.getElementById('fetch')!.dispatch('click')
    expect(document.getElementById('draft')!.hidden).toBe(false)
    expect(document.getElementById('draft')!.textContent).toBe('Frozen user draft')
    expect(document.getElementById('copy')!.disabled).toBe(false)
    expect(calls.map(call => call.endpoint)).toEqual([
      'clarify/start', 'clarify/answer', 'clarify/accept', 'clarify/fetchDraft',
    ])
  })

  it.each(['PREVIEW_OUTDATED', 'INVALID_ANSWER'])('recovers answer %s by redrawing the current question', async (code) => {
    const recoveredQuestion = {
      ...question,
      questionId: 'question-2',
      options: [
        { optionId: 'option-recovered', text: 'Recovered choice' },
        { optionId: 'option-alternate', text: 'Alternate choice' },
      ],
    }
    const { document, calls } = boot([
      { endpoint: 'clarify/start', value: running('ask', 'preview-1', 'Preview before answer race', ['Opened the question']) },
      { endpoint: 'clarify/answer', error: { code, message: 'answer lost a concurrent race' } },
      { endpoint: 'clarify/fetchDraft', value: running('ask', 'preview-2', 'Latest question preview', ['Reloaded the current question'], recoveredQuestion) },
      { endpoint: 'clarify/answer', value: running('await_accept', 'preview-3', 'Ready after retry', ['Recorded the retried answer']) },
    ])

    await document.getElementById('start')!.dispatch('click')
    currentOption(document).checked = true
    await document.getElementById('answer')!.dispatch('click')
    expect(document.getElementById('error')!.textContent).toContain(code)
    expect(document.getElementById('preview')!.textContent).toBe('Latest question preview')
    expect(document.getElementById('answer')!.disabled).toBe(false)
    expect(document.getElementById('accept')!.disabled).toBe(false)
    expect(document.getElementById('refine')!.disabled).toBe(false)
    expect(document.querySelectorAll('input[name=option]:checked')).toEqual([])

    currentOption(document).checked = true
    await document.getElementById('answer')!.dispatch('click')
    expect(document.getElementById('preview')!.textContent).toBe('Ready after retry')
    expect(document.getElementById('answer')!.disabled).toBe(true)
    expect(document.getElementById('accept')!.disabled).toBe(false)
    expect(calls.map(call => call.endpoint)).toEqual([
      'clarify/start', 'clarify/answer', 'clarify/fetchDraft', 'clarify/answer',
    ])
    expect(calls[3]?.args).toEqual({
      processId: 'process-1',
      questionId: 'question-2',
      previewVersion: 'preview-2',
      selectedOptionIds: ['option-recovered'],
    })
    expect(calls.map(call => call.endpoint)).not.toContain('clarify/cancel')
  })

  it.each(['PREVIEW_OUTDATED', 'INVALID_ANSWER'])('recovers %s by refetching and keeps the live controls usable', async (code) => {
    const { document, calls } = boot([
      { endpoint: 'clarify/start', value: running('await_accept', 'preview-1', 'Preview before race', ['Prepared the draft']) },
      { endpoint: 'clarify/accept', error: { code, message: 'state changed concurrently' } },
      { endpoint: 'clarify/fetchDraft', value: running('await_accept', 'preview-2', 'Latest preserved preview', ['Applied the concurrent answer']) },
      { endpoint: 'clarify/accept', value: terminal('complete') },
    ])

    await document.getElementById('start')!.dispatch('click')
    await document.getElementById('accept')!.dispatch('click')
    expect(document.getElementById('error')!.textContent).toContain(code)
    expect(document.getElementById('preview')!.textContent).toBe('Latest preserved preview')
    expect(document.getElementById('accept')!.disabled).toBe(false)
    expect(document.getElementById('fetch')!.disabled).toBe(true)

    await document.getElementById('accept')!.dispatch('click')
    expect(document.getElementById('fetch')!.disabled).toBe(false)
    expect(calls.map(call => call.endpoint)).toEqual([
      'clarify/start', 'clarify/accept', 'clarify/fetchDraft', 'clarify/accept',
    ])
    expect(calls[3]?.args).toEqual({ processId: 'process-1', previewVersion: 'preview-2' })
  })

  it.each(['PREVIEW_OUTDATED', 'INVALID_ANSWER'])('does not expose an unreviewed completed draft after accept recovery %s', async (code) => {
    const { document, calls } = boot([
      { endpoint: 'clarify/start', value: running('await_accept', 'preview-reviewed', 'Reviewed preview', ['Prepared review']) },
      { endpoint: 'clarify/accept', error: { code, message: 'a concurrent client changed the terminal state' } },
      {
        endpoint: 'clarify/fetchDraft',
        value: terminal('complete', {
          previewVersion: 'preview-accepted-elsewhere',
          draft: 'UNREVIEWED CONCURRENT DRAFT',
        }),
      },
    ])

    await document.getElementById('start')!.dispatch('click')
    await document.getElementById('accept')!.dispatch('click')

    expect(document.getElementById('error')!.textContent).toMatch(/different preview version/i)
    expect(document.getElementById('fetch')!.disabled).toBe(true)
    expect(document.getElementById('draft')!.hidden).toBe(true)
    expect(document.getElementById('draft')!.textContent).not.toContain('UNREVIEWED')
    expect(calls.map(call => call.endpoint)).toEqual([
      'clarify/start', 'clarify/accept', 'clarify/fetchDraft',
    ])
  })

  it.each(['PREVIEW_OUTDATED', 'INVALID_ANSWER'])('does not expose a completed draft reached through answer recovery %s', async (code) => {
    const { document, calls } = boot([
      { endpoint: 'clarify/start', value: running('ask', 'preview-question', 'Question preview', ['Opened question']) },
      { endpoint: 'clarify/answer', error: { code, message: 'a concurrent client completed the process' } },
      {
        endpoint: 'clarify/fetchDraft',
        value: terminal('complete', {
          previewVersion: 'preview-complete',
          draft: 'UNREVIEWED CONCURRENT DRAFT',
        }),
      },
    ])

    await document.getElementById('start')!.dispatch('click')
    currentOption(document).checked = true
    await document.getElementById('answer')!.dispatch('click')

    expect(document.getElementById('error')!.textContent).toMatch(/answer recovery.*complete/i)
    expect(document.getElementById('fetch')!.disabled).toBe(true)
    expect(document.getElementById('draft')!.hidden).toBe(true)
    expect(document.getElementById('draft')!.textContent).not.toContain('UNREVIEWED')
    expect(calls.map(call => call.endpoint)).toEqual([
      'clarify/start', 'clarify/answer', 'clarify/fetchDraft',
    ])
  })

  it('ignores duplicate start and cross-action clicks while start is pending', async () => {
    let release!: () => void
    const hold = new Promise<void>((resolve) => { release = resolve })
    const { document, calls } = boot([
      { endpoint: 'clarify/start', value: running('ask', 'preview-1', 'One request only', ['Started once']), hold },
    ])

    const first = document.getElementById('start')!.dispatch('click')
    const duplicate = document.getElementById('start')!.dispatch('click')
    const crossAction = document.getElementById('answer')!.dispatch('click')
    expect(document.getElementById('start')!.disabled).toBe(true)
    expect(document.getElementById('answer')!.disabled).toBe(true)
    release()
    await Promise.all([first, duplicate, crossAction])

    expect(calls.map(call => call.endpoint)).toEqual(['clarify/start'])
    expect(document.getElementById('start')!.disabled).toBe(false)
    expect(document.getElementById('answer')!.disabled).toBe(false)
  })

  it('ignores duplicate answer clicks while answer is pending', async () => {
    let release!: () => void
    const hold = new Promise<void>((resolve) => { release = resolve })
    const { document, calls } = boot([
      { endpoint: 'clarify/start', value: running('ask', 'preview-1', 'Question preview', ['Started']) },
      { endpoint: 'clarify/answer', value: running('await_accept', 'preview-2', 'Ready once', ['Answered once']), hold },
    ])

    await document.getElementById('start')!.dispatch('click')
    currentOption(document).checked = true
    const first = document.getElementById('answer')!.dispatch('click')
    const duplicate = document.getElementById('answer')!.dispatch('click')
    expect(document.getElementById('answer')!.disabled).toBe(true)
    release()
    await Promise.all([first, duplicate])
    expect(calls.map(call => call.endpoint)).toEqual(['clarify/start', 'clarify/answer'])
  })

  it('ignores duplicate accept and fetch clicks while their RPC is pending', async () => {
    let releaseAccept!: () => void
    const acceptHold = new Promise<void>((resolve) => { releaseAccept = resolve })
    let releaseFetch!: () => void
    const fetchHold = new Promise<void>((resolve) => { releaseFetch = resolve })
    const { document, calls } = boot([
      { endpoint: 'clarify/start', value: running('await_accept', 'preview-1', 'Ready preview', ['Ready']) },
      { endpoint: 'clarify/accept', value: terminal('complete'), hold: acceptHold },
      { endpoint: 'clarify/fetchDraft', value: terminal('complete', { draft: 'Frozen once' }), hold: fetchHold },
    ])

    await document.getElementById('start')!.dispatch('click')
    const firstAccept = document.getElementById('accept')!.dispatch('click')
    const duplicateAccept = document.getElementById('accept')!.dispatch('click')
    expect(document.getElementById('accept')!.disabled).toBe(true)
    releaseAccept()
    await Promise.all([firstAccept, duplicateAccept])

    const firstFetch = document.getElementById('fetch')!.dispatch('click')
    const duplicateFetch = document.getElementById('fetch')!.dispatch('click')
    expect(document.getElementById('fetch')!.disabled).toBe(true)
    releaseFetch()
    await Promise.all([firstFetch, duplicateFetch])
    expect(calls.map(call => call.endpoint)).toEqual([
      'clarify/start', 'clarify/accept', 'clarify/fetchDraft',
    ])
    expect(document.getElementById('draft')!.textContent).toBe('Frozen once')
  })

  it.each(['start', 'answer'] as const)('fails closed when %s illegally returns complete', async (method) => {
    const steps: RpcStep[] = method === 'start'
      ? [{ endpoint: 'clarify/start', value: terminal('complete', { draft: 'LEAKED' }) }]
      : [
          { endpoint: 'clarify/start', value: running('ask', 'preview-1', 'Question preview', ['Started']) },
          { endpoint: 'clarify/answer', value: terminal('complete', { draft: 'LEAKED' }) },
        ]
    const { document, calls } = boot(steps)

    await document.getElementById('start')!.dispatch('click')
    if (method === 'answer') {
      currentOption(document).checked = true
      await document.getElementById('answer')!.dispatch('click')
    }

    expect(document.getElementById('error')!.textContent).toMatch(new RegExp(method + '.*complete', 'i'))
    expect(document.getElementById('fetch')!.disabled).toBe(true)
    expect(document.getElementById('draft')!.hidden).toBe(true)
    expect(calls.map(call => call.endpoint)).toEqual(method === 'start'
      ? ['clarify/start']
      : ['clarify/start', 'clarify/answer'])
  })

  it('accepts a reviewed ask preview without answering the live question', async () => {
    const { document, calls } = boot([
      { endpoint: 'clarify/start', value: running('ask', 'preview-1', 'Ask preview ready to accept', ['Opened the question']) },
      { endpoint: 'clarify/accept', value: terminal('complete') },
      { endpoint: 'clarify/fetchDraft', value: terminal('complete', { draft: 'Ask preview ready to accept' }) },
    ])
    await document.getElementById('start')!.dispatch('click')
    expect(document.getElementById('accept')!.disabled).toBe(false)
    await document.getElementById('accept')!.dispatch('click')
    await document.getElementById('fetch')!.dispatch('click')
    expect(document.getElementById('draft')!.textContent).toBe('Ask preview ready to accept')
    expect(calls.map(call => call.endpoint)).toEqual([
      'clarify/start', 'clarify/accept', 'clarify/fetchDraft',
    ])
  })

  it('refines the current ask preview through the same Remote', async () => {
    const { document, calls } = boot([
      { endpoint: 'clarify/start', value: running('ask', 'preview-1', 'Ask preview', ['Opened']) },
      { endpoint: 'clarify/refine', value: running('await_accept', 'preview-2', 'Refined preview', ['Applied refine feedback']) },
    ])
    await document.getElementById('start')!.dispatch('click')
    document.getElementById('feedback')!.value = 'add rollback'
    await document.getElementById('refine')!.dispatch('click')
    expect(document.getElementById('preview')!.textContent).toBe('Refined preview')
    expect(calls.map(call => call.endpoint)).toEqual(['clarify/start', 'clarify/refine'])
    expect(calls[1]?.args).toEqual({
      processId: 'process-1',
      previewVersion: 'preview-1',
      feedback: 'add rollback',
    })
  })
})
