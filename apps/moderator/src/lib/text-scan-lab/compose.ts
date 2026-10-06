import type { LabField } from './types';

/**
 * The user message a scan sends for these fields, uncapped. Must stay identical to the main app's
 * `composeUserMessage` (src/server/services/text-scan/prompt.ts): a test case's `text_hash` is compared
 * with the hashes production records, so any drift here makes every case look edited.
 */
export const composeUserMessage = (fields: LabField[]) =>
  fields
    .filter((field) => field.text?.trim())
    .map((field) => `## ${field.heading}\n${field.text.trim()}`)
    .join('\n\n');

export const MISSING_HEADING = 'Every field with text needs a heading.';

/**
 * The fields a scan or a test case keeps: only those with text, headings trimmed. The main app sends an
 * absent optional field (a model without a description) as null text. A field with text but no heading
 * is refused with `MISSING_HEADING` wherever fields enter the lab, so the copies cannot drift.
 */
export function normaliseLabFields(
  fields: readonly { heading: string; text?: string | null }[]
): LabField[] | typeof MISSING_HEADING {
  const kept: LabField[] = [];
  for (const { heading, text } of fields) {
    if (typeof text !== 'string' || !text.trim()) continue;
    if (!heading.trim()) return MISSING_HEADING;
    kept.push({ heading: heading.trim(), text });
  }
  return kept;
}
