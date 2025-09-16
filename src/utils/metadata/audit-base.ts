import { normalizeText } from '~/utils/normalize-text';
import nsfwPromptWords from './lists/words-nsfw-prompt.json';
import nsfwWordsPaddle from './lists/words-paddle-nsfw.json';
import blockedNSFW from './lists/blocklist-nsfw.json';
import blocked from './lists/blocklist.json';
import { lazy } from '~/shared/utils/lazy';

export function prepareWordRegex(word: string, pluralize = false) {
  let regexStr = word;
  regexStr = regexStr.replace(/\s+/g, `[^a-zA-Z0-9]*`);
  if (!word.includes('[')) {
    regexStr = regexStr
      .replace(/i/g, '[i|l|1]')
      .replace(/o/g, '[o|0]')
      .replace(/s/g, '[s|z]')
      .replace(/e/g, '[e|3]');
  }
  if (pluralize) regexStr += '[s|z]*';
  regexStr = `([^a-zA-Z0-9]+|^)` + regexStr + `([^a-zA-Z0-9]+|$)`;
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
export function hasNsfwWords(text?: string | null) {
  if (!text) return false;
  const str = normalizeText(text);
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
