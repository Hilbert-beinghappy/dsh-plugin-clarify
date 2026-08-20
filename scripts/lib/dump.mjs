import { sanitizeText } from './sanitize.mjs'

const CLARIFY_SECTION = /# == dsh-plugin-clarify\b[\s\S]{0,240}/
const CLARIFY_NAME = /dsh-plugin-clarify/
export const DUMP_ABSENT = 'dsh-plugin-clarify not found'

export function inspectClarifyDump(output) {
  const text = String(output ?? '')
  const section = text.match(CLARIFY_SECTION)
  const present = Boolean(section) || CLARIFY_NAME.test(text)
  let excerpt
  if (section) excerpt = sanitizeText(section[0].trim())
  else if (present) excerpt = 'dsh-plugin-clarify present (no isolated # == section)'
  else excerpt = DUMP_ABSENT
  return {
    present,
    excerpt,
    length: text.length,
  }
}

export function summarizeDump(output) {
  return inspectClarifyDump(output).excerpt
}

export function dumpBooleanTextContradictions(label, present, excerpt) {
  const text = String(excerpt ?? '')
  const errors = []
  if (present === true && /dsh-plugin-clarify not found/i.test(text)) {
    errors.push(`${label}: present=true but excerpt says not found`)
  }
  if (present === true && !CLARIFY_NAME.test(text)) {
    errors.push(`${label}: present=true but excerpt has no dsh-plugin-clarify`)
  }
  if (present === false && /# == dsh-plugin-clarify/.test(text)) {
    errors.push(`${label}: present=false but excerpt has clarify section`)
  }
  if (present === false && text !== DUMP_ABSENT) {
    errors.push(`${label}: present=false but excerpt is not the absent marker`)
  }
  return errors
}

export function dumpEvidenceContradictions(records) {
  const errors = []
  for (const record of records ?? []) {
    const inspected = inspectClarifyDump(record.raw)
    if (inspected.present !== record.present) {
      errors.push(`${record.label}: flag ${record.present} != full-dump inspect ${inspected.present}`)
    }
    if (record.excerpt !== inspected.excerpt) {
      errors.push(`${record.label}: recorded excerpt does not match full-dump summary`)
    }
    errors.push(...dumpBooleanTextContradictions(record.label, record.present, record.excerpt))
  }
  return errors
}
