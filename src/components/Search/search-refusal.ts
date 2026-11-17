import { includesInappropriate, includesPoi } from '~/utils/metadata/audit';
import { getBlockedNsfwWords } from '~/utils/metadata/audit-base';

export type SearchRefusal = 'illegal' | 'profanity' | 'poi' | 'blocked-words';

/**
 * Why a search text is refused before anything searches it, or undefined when it may run. Profanity
 * is the one refusal not decided here: it needs the `useCheckProfanity` hook, and only applies on
 * the green domain.
 */
export function getSearchRefusal({
  text,
  auditedText,
  disablePoi,
}: {
  text: string;
  /** `text` with the moderator-whitelisted benign phrases stripped. */
  auditedText: string;
  disablePoi: boolean;
}): Exclude<SearchRefusal, 'profanity'> | undefined {
  if (!text) return undefined;
  if (includesInappropriate({ prompt: auditedText }) === 'minor') return 'illegal';
  if (disablePoi && includesPoi(auditedText)) return 'poi';
  // Raw text on purpose: this reads a different list (blocked NSFW words) which the benign
  // phrases do not carve out, and it blocks rather than flags.
  if (getBlockedNsfwWords(text).length) return 'blocked-words';
  return undefined;
}
