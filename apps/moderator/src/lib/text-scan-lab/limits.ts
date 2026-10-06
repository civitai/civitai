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
} as const;

/** Above this many billed scans, a batch is quoted and has to be confirmed first. */
export const QUOTE_ABOVE = 10;

export const textChars = (fields: readonly LabField[]) =>
  fields.reduce((sum, field) => sum + field.text.length, 0);

/** Why the harness would refuse this text, or null when it fits. */
export function textTooLarge(fields: readonly LabField[]): string | null {
  const chars = textChars(fields);
  if (fields.length <= HARNESS_LIMITS.fieldsPerText && chars <= HARNESS_LIMITS.charsPerText)
    return null;
  return `too large: ${fields.length} fields / ${chars} chars (the scan limit is ${HARNESS_LIMITS.fieldsPerText} fields / ${HARNESS_LIMITS.charsPerText} chars)`;
}

/** Splits fitting texts into requests of at most `size` texts and the per-request character cap. */
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
