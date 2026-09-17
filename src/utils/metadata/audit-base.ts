import { foldDiacritics } from '~/utils/fold-diacritics';
import nsfwPromptWords from './lists/words-nsfw-prompt.json';
import nsfwWordsPaddle from './lists/words-paddle-nsfw.json';
import blockedNSFW from './lists/blocklist-nsfw.json';
import blocked from './lists/blocklist.json';
import { lazy } from '~/shared/utils/lazy';

export function prepareWordRegex(word: string, pluralize = false) {
  let regexStr = word;
  regexStr = regexStr.replace(/\s+/g, `[^a-zA-Z0-9]+`);
  if (!word.includes('[')) {
    regexStr = regexStr
      .replace(/i/g, '[i|l|1]')
      .replace(/o/g, '[o|0]')
      .replace(/s/g, '[s|z]')
      .replace(/e/g, '[e|3]');
  }
  if (pluralize) regexStr += '[s|z]*';
  // Zero-width word boundaries instead of consuming `[^a-zA-Z0-9]+` runs — the
  // greedy leading/trailing groups backtrack O(n²) over a long non-Latin (CJK)
  // prompt, pinning the api event loop for seconds (user-triggerable DoS). The
  // lookbehind/lookahead are boolean-equivalent ("not preceded/followed by an
  // alnum" ≡ "preceded/followed by non-alnum or string edge") but zero-width →
  // nothing to backtrack → linear. Mirrors the fix in audit.ts.
  regexStr = `(?<![a-zA-Z0-9])` + regexStr + `(?![a-zA-Z0-9])`;
  const regex = new RegExp(regexStr, 'i');
  return regex;
}

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
