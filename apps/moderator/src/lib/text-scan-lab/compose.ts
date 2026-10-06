import { HARNESS_LIMITS, HEADING_TOO_LONG } from './limits';
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
 * is refused with `MISSING_HEADING`, and a heading the harness would refuse with `HEADING_TOO_LONG`,
 * wherever fields enter the lab, so the copies cannot drift.
 */
export function normaliseLabFields(
  fields: readonly { heading: string; text?: string | null }[]
): LabField[] | string {
  const kept: LabField[] = [];
  for (const { heading, text } of fields) {
    if (typeof text !== 'string' || !text.trim()) continue;
    const trimmed = heading.trim();
    if (!trimmed) return MISSING_HEADING;
    if (trimmed.length > HARNESS_LIMITS.headingChars) return HEADING_TOO_LONG;
    kept.push({ heading: trimmed, text });
  }
  return kept;
}
