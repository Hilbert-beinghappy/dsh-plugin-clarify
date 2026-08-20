import type { AnswerRecord, ClarifyQuestion, InferenceEngine, InferenceInput, InferenceResult } from './types.ts'

export const STUB_QUESTIONS: readonly ClarifyQuestion[] = [
  {
    questionId: 'q-goal',
    text: 'What is the main thing you want to accomplish?',
    options: [
      { optionId: 'o-feature', text: 'Add a feature' },
      { optionId: 'o-bugfix', text: 'Fix a bug' },
      { optionId: 'o-other', text: 'Something else' },
    ],
    multiple: false,
    allowCustom: true,
  },
  {
    questionId: 'q-constraints',
    text: 'Which constraints should the draft respect?',
    options: [
      { optionId: 'o-time', text: 'Timeboxed' },
      { optionId: 'o-compat', text: 'Compatibility' },
      { optionId: 'o-none', text: 'No extra constraints' },
    ],
    multiple: true,
    allowCustom: false,
  },
]

export class StubInferenceEngine implements InferenceEngine {
  async infer(input: InferenceInput, signal: AbortSignal): Promise<InferenceResult> {
    if (signal.aborted) throw new Error('aborted')
    if (input.history.length === 0) return { kind: 'question', question: STUB_QUESTIONS[0]! }
    if (input.history.length === 1) return { kind: 'question', question: STUB_QUESTIONS[1]! }
    return { kind: 'draft', draft: assembleDraft(input.seedText, input.history) }
  }
}

export function assembleDraft(seedText: string | undefined, history: readonly AnswerRecord[]): string {
  const lines = [
    'User draft (not an assistant reply, not a plan, not a tool instruction):',
  ]
  if (seedText?.trim()) lines.push(`Starting from: ${seedText.trim()}`)
  for (const answer of history) {
    if (answer.customText !== undefined) {
      lines.push(`${answer.questionId}: ${answer.customText}`)
    } else {
      lines.push(`${answer.questionId}: ${(answer.selectedOptionIds ?? []).join(', ')}`)
    }
  }
  return lines.join('\n')
}
