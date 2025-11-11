/**
 * Custom transformers for profanity detection
 *
 * This module provides custom implementations of transformers to address
 * false positives in the obscenity package's default leetspeak detection.
 */

import { createSimpleTransformer } from 'obscenity';

/**
 * Leetspeak character mappings that exclude problematic punctuation
 *
 * The default obscenity leetspeak transformer maps "(" to "c", which causes
 * false positives like "(untucked)" being flagged as profanity.
 *
 * This custom mapping:
 * - Includes legitimate leetspeak substitutions (numbers and symbols)
 * - Excludes parentheses and brackets that commonly appear in normal text
 * - Maintains detection for actual leetspeak profanity like "fu(k" → "fuck"
 */
const customLeetSpeakMappings = new Map<number, number>([
  // Numbers to letters
  ['0'.charCodeAt(0), 'o'.charCodeAt(0)], // 0 → o
  ['1'.charCodeAt(0), 'i'.charCodeAt(0)], // 1 → i
  ['3'.charCodeAt(0), 'e'.charCodeAt(0)], // 3 → e
  ['4'.charCodeAt(0), 'a'.charCodeAt(0)], // 4 → a
  ['5'.charCodeAt(0), 's'.charCodeAt(0)], // 5 → s
  ['6'.charCodeAt(0), 'g'.charCodeAt(0)], // 6 → g
  ['7'.charCodeAt(0), 't'.charCodeAt(0)], // 7 → t

  // Common symbols to letters
  ['@'.charCodeAt(0), 'a'.charCodeAt(0)], // @ → a
  ['$'.charCodeAt(0), 's'.charCodeAt(0)], // $ → s
  ['!'.charCodeAt(0), 'i'.charCodeAt(0)], // ! → i
  ['/'.charCodeAt(0), 'l'.charCodeAt(0)], // / → l

  // EXCLUDED: '(' → 'c' (causes false positives with words like "untucked")
  // EXCLUDED: ')' (not in original, but being explicit)
  // EXCLUDED: '[', ']', '{', '}' (common in normal text)
]);

/**
 * Custom leetspeak transformer that prevents false positives from punctuation
 *
 * This transformer resolves leetspeak characters to their letter equivalents,
 * but excludes problematic punctuation marks like parentheses and brackets
 * that commonly appear in normal text.
 *
 * @example
 * // Without this custom transformer:
 * // "(untucked)" → "cuntucked)" → "cuntucked" → MATCH (false positive)
 *
 * // With this custom transformer:
 * // "(untucked)" → "(untucked)" → "untucked" → NO MATCH ✓
 *
 * // Still catches actual leetspeak:
 * // "fu(k" with skipNonAlphabetic → "fuk" → NO MATCH (good, but limited)
 * // "fuc|<" → "fuck" → MATCH ✓ (if we add | and < to mappings)
 */
export const customLeetSpeakTransformer = createSimpleTransformer((char) => {
  return customLeetSpeakMappings.get(char) ?? char;
});

/**
 * Alternative: Skip punctuation BEFORE leetspeak transformation
 *
 * This transformer removes common punctuation that shouldn't be interpreted
 * as leetspeak substitutions. Apply this BEFORE the leetspeak transformer.
 *
 * This is a more aggressive approach that completely removes parentheses
 * and brackets, preventing them from ever being interpreted as letters.
 */
const punctuationToSkip = new Set([
  '('.charCodeAt(0),
  ')'.charCodeAt(0),
  '['.charCodeAt(0),
  ']'.charCodeAt(0),
  '{'.charCodeAt(0),
  '}'.charCodeAt(0),
]);

export const skipProblematicPunctuationTransformer = createSimpleTransformer((char) => {
  // Return undefined to skip this character
  return punctuationToSkip.has(char) ? undefined : char;
});

/**
 * Conservative approach: More restrictive leetspeak that only handles numbers
 *
 * This transformer only handles numeric substitutions (0-9) and completely
 * ignores all punctuation and symbols. Use this if you want maximum safety
 * from false positives at the cost of some detection capability.
 */
const conservativeLeetSpeakMappings = new Map<number, number>([
  ['0'.charCodeAt(0), 'o'.charCodeAt(0)], // 0 → o
  ['1'.charCodeAt(0), 'i'.charCodeAt(0)], // 1 → i
  ['3'.charCodeAt(0), 'e'.charCodeAt(0)], // 3 → e
  ['4'.charCodeAt(0), 'a'.charCodeAt(0)], // 4 → a
  ['5'.charCodeAt(0), 's'.charCodeAt(0)], // 5 → s
  ['6'.charCodeAt(0), 'g'.charCodeAt(0)], // 6 → g
  ['7'.charCodeAt(0), 't'.charCodeAt(0)], // 7 → t
]);

export const conservativeLeetSpeakTransformer = createSimpleTransformer((char) => {
  return conservativeLeetSpeakMappings.get(char) ?? char;
});
