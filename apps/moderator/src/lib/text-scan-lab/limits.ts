import type { LabField } from './types';

/**
 * The main app harness's request limits (`TEXT_SCAN_HARNESS_LIMITS` in
 * src/server/services/text-scan/harness.ts). The harness refuses a whole request over any of them, so
 * the lab checks each text first and keeps an oversize one out of every shared request.
 */
export const HARNESS_LIMITS = {
  textsPerRequest: 50,
  fieldsPerText: 500,
  charsPerText: 200_000,
  charsPerRequest: 1_000_000,
  headingChars: 100,
} as const;

export const HEADING_TOO_LONG = `A field heading is at most ${HARNESS_LIMITS.headingChars} characters.`;

export const textChars = (fields: readonly LabField[]) =>
  fields.reduce((sum, field) => sum + field.text.length, 0);

export function textTooLarge(fields: readonly LabField[]): string | null {
  if (fields.some((field) => field.heading.length > HARNESS_LIMITS.headingChars))
    return HEADING_TOO_LONG;
  const chars = textChars(fields);
  if (fields.length <= HARNESS_LIMITS.fieldsPerText && chars <= HARNESS_LIMITS.charsPerText)
    return null;
  return `too large: ${fields.length} fields / ${chars} chars (the scan limit is ${HARNESS_LIMITS.fieldsPerText} fields / ${HARNESS_LIMITS.charsPerText} chars)`;
}

export function chunkTexts<T extends { fields: readonly LabField[] }>(
  texts: readonly T[],
  size: number
) {
  const chunks: T[][] = [];
  let current: T[] = [];
  let chars = 0;
  for (const text of texts) {
    const n = textChars(text.fields);
    if (current.length && (current.length >= size || chars + n > HARNESS_LIMITS.charsPerRequest)) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(text);
    chars += n;
  }
  if (current.length) chunks.push(current);
  return chunks;
}
