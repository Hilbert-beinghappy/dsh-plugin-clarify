/**
 * Sole deterministic fixture for state-machine, transport, and T3 tests.
 * This directory is excluded from the published package; production Clarify
 * has no scripted semantic fallback.
 */
export const STUB_ASKS = [
  {
    kind: 'ask',
    question: 'What is the main thing you want to accomplish?',
    options: ['Add a feature', 'Fix a bug', 'Something else'],
    multiple: false,
    allowCustom: true,
    draftPreview: 'User draft pending first answer.',
    materialChanges: ['opened the goal question'],
  },
  {
    kind: 'ask',
    question: 'Which constraints should the draft respect?',
    options: ['Timeboxed', 'Compatibility', 'No extra constraints'],
    multiple: true,
    allowCustom: false,
    draftPreview: 'User draft after choosing a goal.',
    materialChanges: ['recorded the goal'],
  },
]

export class StubInferenceEngine {
  async infer(input, signal) {
    if (signal.aborted) throw new Error('aborted')
    if (input.refineFeedback?.trim()) {
      const prior = input.priorPublishedDraft?.draftPreview ?? assembleDraft(input)
      return {
        kind: 'await_accept',
        draftPreview: `${prior}\nRefinement: ${input.refineFeedback.trim()}`,
        materialChanges: ['applied one-shot refinement feedback'],
      }
    }
    const ask = STUB_ASKS[input.acceptedDecisions.length]
    if (ask) {
      return { ...ask, options: [...ask.options], materialChanges: [...ask.materialChanges] }
    }
    return {
      kind: 'await_accept',
      draftPreview: assembleDraft(input),
      materialChanges: ['assembled the user draft'],
    }
  }
}

function assembleDraft(input) {
  const lines = ['User draft (not an assistant reply, not a plan, not a tool instruction):']
  if (input.seedText?.trim()) lines.push(`Starting from: ${input.seedText.trim()}`)
  for (const decision of input.acceptedDecisions) {
    lines.push(decision.answer === 'custom' ? decision.customText : decision.selectedOptionTexts.join(', '))
  }
  return lines.join('\n')
}
