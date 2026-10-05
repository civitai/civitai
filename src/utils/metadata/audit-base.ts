import { foldDiacritics } from '~/utils/fold-diacritics';
import {
  blocked,
  blockedNSFW,
  nsfwPromptWords,
  nsfwWordsPaddle,
} from '@civitai/mod-utils/prompt-audit/lists';
import { lazy } from '~/shared/utils/lazy';

import { prepareWordRegex } from '@civitai/mod-utils/prompt-audit/word-regex';

export { prepareWordRegex };

const escapeRegex = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const blockedBoth = '\\%|\\~|\\\\$|\\.|-|\\(|\\)|\\[|\\]|\\{|\\}|:|\\|';
function tokenRegex(word: string) {
  return new RegExp(`(^|\\s|,|${blockedBoth})${escapeRegex(word)}(\\s|,|$|${blockedBoth})`, 'mi');
}

export const blockedRegexLazy = lazy(() =>
  blocked.map((word) => ({
    word,
    regex: tokenRegex(word),
  }))
);
export const blockedNSFWRegexLazy = lazy(() =>
  blockedNSFW.map((word) => ({
    word,
    regex: tokenRegex(word),
  }))
);
const expressionsLazy = lazy(() =>
  [...new Set([...nsfwPromptWords, ...nsfwWordsPaddle])].map((word) => prepareWordRegex(word))
);
// Folds accents but does NOT decode HTML entities. Every caller passes a title or a name, and
// those render as text, so an entity in one is literal to the reader and decoding it would make
// this check disagree with what they see. A caller that handles generation prompts wants the
// decode-and-fold helper instead. Swapping this back to it also puts `he` in the feed's initial
// chunk, which is what utils/fold-diacritics.ts exists to avoid.
export function hasNsfwWords(text?: string | null) {
  if (!text) return false;
  const str = foldDiacritics(text);
  for (const expression of expressionsLazy()) {
    if (expression.test(str)) {
      return true;
    }
  }
  return false;
}

export function getBlockedNsfwWords(value?: string | null) {
  if (!value) return [];
  return blockedNSFWRegexLazy()
    .filter(({ regex }) => regex.test(value))
    .map((x) => x.word);
}
