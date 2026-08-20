#!/usr/bin/env node
import { ClarifyService, createClarifyRemote } from '../lib/index.js'

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

try {
  console.log('NOTE this is an in-process Remote object smoke. Official Host T3 is docs/t0-evidence/<version>/host-t3.json via POST /api/clarify/<method>.')
  const service = new ClarifyService({ resolveBinding: () => binding })
  const remote = createClarifyRemote(service)
  const started = await remote.start('session-e2e', 'need an off-transcript clarify process')
  record('start', started.status === 'running' && Boolean(started.question), `status=${started.status}`)

  const q2 = await remote.answer(started.processId, started.question.questionId, ['o-feature'], '')
  record('answer-1', q2.status === 'running' && q2.question?.multiple === true, `status=${q2.status}`)

  const completed = await remote.answer(started.processId, q2.question.questionId, ['o-compat', 'o-time'], '')
  record('answer-complete-without-draft', completed.status === 'complete' && completed.draft === undefined, `status=${completed.status}`)

  const fetched = await remote.fetchDraft(started.processId)
  record('fetchDraft', fetched.status === 'complete' && typeof fetched.draft === 'string', 'draft present only after complete')

  const cancelledService = new ClarifyService({ resolveBinding: () => binding })
  const cancelledRemote = createClarifyRemote(cancelledService)
  const live = await cancelledRemote.start('session-e2e', '')
  await cancelledRemote.cancel(live.processId)
  const cancelledAnswer = await cancelledRemote.answer(live.processId, live.question.questionId, ['o-feature'], '')
  record('answer-on-cancelled', cancelledAnswer.status === 'cancelled', `status=${cancelledAnswer.status}`)

  const staleService = new ClarifyService({ resolveBinding: () => binding })
  const staleRemote = createClarifyRemote(staleService)
  const staleLive = await staleRemote.start('session-e2e', '')
  staleService.markStale(staleLive.processId, 'session-changed')
  const staleAnswer = await staleRemote.answer(staleLive.processId, staleLive.question.questionId, ['o-feature'], '')
  record('answer-on-stale', staleAnswer.status === 'stale' && staleAnswer.staleReason === 'session-changed', `status=${staleAnswer.status}`)
} catch (error) {
  record('unhandled', false, error instanceof Error ? error.message : String(error))
}

const failed = results.filter((item) => !item.ok)
if (failed.length > 0) {
  console.error(`T3 e2e failed: ${failed.map((item) => item.name).join(', ')}`)
  process.exit(1)
}
console.log('T3 e2e passed')
