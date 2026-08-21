#!/usr/bin/env node
import { ClarifyService, createClarifyRemote, unwrapClarifyWire } from '../lib/index.js'
import { StubInferenceEngine } from '../test/fixtures/stub-inference.mjs'

const results = []

function record(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const binding = {
  sessionId: 'session-e2e',
  contextVersion: 'ctx-e2e',
  modelRouteId: 'route-e2e',
}

function optionId(question, text) {
  const found = question.options.find((option) => option.text === text)
  if (!found) throw new Error(`missing option ${text}`)
  return found.optionId
}

try {
  console.log('NOTE this is an in-process Remote object smoke. Official Host T3 is docs/t0-evidence/<version>/host-t3.json via POST /api/clarify/<method>.')
  const service = new ClarifyService({
    resolveBinding: () => binding,
    inference: new StubInferenceEngine(),
  })
  const remote = createClarifyRemote(service)
  const started = unwrapClarifyWire(await remote.start('session-e2e', 'need an off-transcript clarify process'))
  record('start', started.status === 'running' && Boolean(started.question) && Boolean(started.previewVersion), `status=${started.status}`)

  const q2 = unwrapClarifyWire(await remote.answer(started.processId, started.question.questionId, started.previewVersion, [optionId(started.question, 'Add a feature')], ''))
  record('answer-1', q2.status === 'running' && q2.question?.multiple === true, `status=${q2.status}`)

  const ready = unwrapClarifyWire(await remote.answer(started.processId, q2.question.questionId, q2.previewVersion, [optionId(q2.question, 'Compatibility'), optionId(q2.question, 'Timeboxed')], ''))
  record('answer-ready-without-draft', ready.status === 'running' && ready.draft === undefined, `status=${ready.status}`)

  const refined = unwrapClarifyWire(await remote.refine(started.processId, ready.previewVersion, 'add rollback and a concrete acceptance check'))
  record('refine-same-process', refined.status === 'running' && refined.processId === started.processId && refined.previewVersion !== ready.previewVersion && typeof refined.draftPreview === 'string', `status=${refined.status}`)

  const completed = unwrapClarifyWire(await remote.accept(started.processId, refined.previewVersion))
  record('accept-complete-without-draft', completed.status === 'complete' && completed.draft === undefined, `status=${completed.status}`)

  const fetched = unwrapClarifyWire(await remote.fetchDraft(started.processId))
  record('fetchDraft', fetched.status === 'complete' && typeof fetched.draft === 'string', 'draft present only after complete')

  const cancelledService = new ClarifyService({
    resolveBinding: () => binding,
    inference: new StubInferenceEngine(),
  })
  const cancelledRemote = createClarifyRemote(cancelledService)
  const live = unwrapClarifyWire(await cancelledRemote.start('session-e2e', ''))
  await cancelledRemote.cancel(live.processId)
  const cancelledAnswer = unwrapClarifyWire(await cancelledRemote.answer(live.processId, live.question.questionId, live.previewVersion, [optionId(live.question, 'Add a feature')], ''))
  record('answer-on-cancelled', cancelledAnswer.status === 'cancelled', `status=${cancelledAnswer.status}`)

  const staleService = new ClarifyService({
    resolveBinding: () => binding,
    inference: new StubInferenceEngine(),
  })
  const staleRemote = createClarifyRemote(staleService)
  const staleLive = unwrapClarifyWire(await staleRemote.start('session-e2e', ''))
  staleService.markStale(staleLive.processId, 'session-changed')
  const staleAnswer = unwrapClarifyWire(await staleRemote.answer(staleLive.processId, staleLive.question.questionId, staleLive.previewVersion, [optionId(staleLive.question, 'Add a feature')], ''))
  record('answer-on-stale', staleAnswer.status === 'stale' && staleAnswer.staleReason === 'session-changed', `status=${staleAnswer.status}`)

  const askAcceptService = new ClarifyService({
    resolveBinding: () => binding,
    inference: new StubInferenceEngine(),
  })
  const askAcceptRemote = createClarifyRemote(askAcceptService)
  const askLive = unwrapClarifyWire(await askAcceptRemote.start('session-e2e', 'accept from ask'))
  const acceptedAsk = unwrapClarifyWire(await askAcceptRemote.accept(askLive.processId, askLive.previewVersion))
  const fetchedAsk = unwrapClarifyWire(await askAcceptRemote.fetchDraft(askLive.processId))
  record('accept-on-ask', acceptedAsk.status === 'complete' && fetchedAsk.draft === askLive.draftPreview && askLive.kind === 'ask', `status=${acceptedAsk.status}`)
} catch (error) {
  record('unhandled', false, error instanceof Error ? error.message : String(error))
}

const failed = results.filter((item) => !item.ok)
if (failed.length > 0) {
  console.error(`T3 e2e failed: ${failed.map((item) => item.name).join(', ')}`)
  process.exit(1)
}
console.log('T3 e2e passed')
