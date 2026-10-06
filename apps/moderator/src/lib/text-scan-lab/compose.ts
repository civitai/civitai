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
