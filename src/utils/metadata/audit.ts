import { ImageMetaProps } from '~/server/schema/image.schema';
import { normalizeText, trimNonAlphanumeric } from '~/utils/string-helpers';
import blockedNSFW from './lists/blocklist-nsfw.json';
import blocked from './lists/blocklist.json';
import nsfwWords from './lists/words-nsfw.json';
import youngWords from './lists/words-young.json';
import poiWords from './lists/words-poi.json';
import promptTags from './lists/prompt-tags.json';

// #region [audit]
const escapeRegex = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const blockedBoth = '\\%|\\~|\\\\$|\\.|-|\\(|\\)|\\[|\\]|\\{|\\}|:|\\|';
const tokenRegex = (word: string) =>
  new RegExp(`(^|\\s|,|${blockedBoth})${escapeRegex(word)}(\\s|,|$|${blockedBoth})`, 'mi');
const blockedRegex = blocked.map((word) => ({
  word,
  regex: tokenRegex(word),
}));
const blockedNSFWRegex = blockedNSFW.map((word) => ({
  word,
  regex: tokenRegex(word),
}));
export const auditMetaData = (meta: ImageMetaProps | undefined, nsfw: boolean) => {
  if (!meta) return { blockedFor: [], success: true };
  const prompt = normalizeText(meta.prompt);

  // Add minor check
  if (nsfw) {
    const { found, age } = includesMinorAge(prompt);
    if (found) return { blockedFor: [`${age} year old`], success: false };
  }

  const blockList = nsfw ? blockedNSFWRegex : blockedRegex;
  const blockedFor = blockList
    .filter(({ regex }) => meta?.prompt && regex.test(prompt))
    .map((x) => x.word);
  return { blockedFor, success: !blockedFor.length };
};

export const auditPrompt = (prompt: string) => {
  prompt = normalizeText(prompt); // Parse HTML Entities
  const { found, age } = includesMinorAge(prompt);
  if (found) return { blockedFor: [`${age} year old`], success: false };

  const inappropriate = includesInappropriate(prompt);
  if (inappropriate === 'minor')
    return { blockedFor: ['Inappropriate minor content'], success: false };
  else if (inappropriate === 'poi')
    return { blockedFor: ['Inappropriate real person content'], success: false };

  for (const { word, regex } of blockedNSFWRegex) {
    if (regex.test(prompt)) return { blockedFor: [word], success: false };
  }

  return { blockedFor: [], success: true };
};
// #endregion

// #region [minorCheck]
// --------------------------------------
// Age Check Definition
// --------------------------------------
const ages = [
  { age: 17, matches: ['seven{teen}', 'sevn{teen}', 'sevem{teen}', 'seve{teen}', '7{teen}', '17'] },
  { age: 16, matches: ['six{teen}', 'sicks{teen}', 'sixe{teen}', '6{teen}', '16'] },
  {
    age: 15,
    matches: ['fif{teen}', 'fiv{teen}', 'five{teen}', 'fife{teen}', 'fivve{teen}', '5{teen}', '15'],
  },
  { age: 14, matches: ['four{teen}', 'for{teen}', 'fore{teen}', 'foure{teen}', '4{teen}', '14'] },
  {
    age: 13,
    matches: [
      'thir{teen}',
      '3{teen}',
      'ther{teen}',
      'three{teen}',
      'tree{teen}',
      'thee{teen}',
      'thre{teen}',
      'thri{teen}',
      '3{teen}',
      '13',
    ],
  },
  { age: 12, matches: ['twelve', 'twelv', 'twelf', '2{teen}', 'twel', '12'] },
  { age: 11, matches: ['eleven', 'eleve', 'elevn', '1{teen}', 'elvn', '11'] },
  { age: 10, matches: ['ten', 'tenn', 'tene', '10'] },
  { age: 9, matches: ['nine', 'nien', 'nein', 'niene', '9'] },
  { age: 8, matches: ['eight', 'eigt', 'eigh', '8'] },
  { age: 7, matches: ['seven', 'sevn', 'sevem', 'seve', '7'] },
  { age: 6, matches: ['six', 'sicks', 'sixe', '6'] },
  { age: 5, matches: ['five', 'fiv', 'fife', 'fivve', '5'] },
  { age: 4, matches: ['four', 'for', 'fore', 'foure', '4'] },
  { age: 3, matches: ['three', 'thee', 'thre', 'thri', '3'] },
  { age: 2, matches: ['two', '2'] },
  { age: 1, matches: ['one', 'uno', '1'] },
];

const templateParts = {
  age: [] as string[], // Filled in later
  teen: ['teen', 'ten', 'tein', 'tien', 'tn'],
  years: ['y', 'yr', 'yrs', 'years', 'year', 'anos'],
  old: ['o', 'old'],
};
const templates = [
  'aged {age}',
  'age {age}',
  'age of {age}',
  '{age} age',
  '{age} {old}',
  '{age} {years} {old}',
  '{age} {years}',
  '{age}th birthday',
  "s?he [i|']s \\w* {age}",
];

// --------------------------------------
// Prepare Regexes
// --------------------------------------
for (const age of ages) {
  const newMatches = new Set<string>();
  for (const match of age.matches) {
    if (!match.includes('{teen}')) newMatches.add(match);
    else {
      const base = match.replace('{teen}', '').trim();
      for (const teen of templateParts.teen) {
        newMatches.add(base + teen);
        newMatches.add(base + ' ' + teen);
      }
    }
  }
  age.matches = Array.from(newMatches);
}
templateParts.age = ages.flatMap((x) => x.matches);

const partRegexStrings: Record<keyof typeof templateParts, string> = Object.entries(
  templateParts
).reduce((acc, [key, values]) => {
  acc[key as keyof typeof templateParts] = values.join('|');
  return acc;
}, {} as Record<keyof typeof templateParts, string>);
const ageRegexes = templates.map((template) => {
  let regexStr = template;
  for (const [key, value] of Object.entries(partRegexStrings)) {
    regexStr = regexStr.replace(`{${key}}`, `(?<${key}>${value})`);
  }
  regexStr = regexStr.replace(/\s+/g, `[^a-zA-Z0-9]*`);
  regexStr = `([^a-zA-Z0-9]+|^)0*` + regexStr + `([^a-zA-Z0-9]+|$)`;
  return new RegExp(regexStr, 'i');
});

// --------------------------------------
// Age Check Function
// --------------------------------------
export function includesMinorAge(prompt: string | undefined) {
  if (!prompt) return { found: false, age: undefined };

  let found = false;
  let age: number | undefined = undefined;
  for (const regex of ageRegexes) {
    if (regex.test(prompt)) {
      const match = regex.exec(prompt);
      found = true;

      const ageText = match?.groups?.age?.toLowerCase();
      age = ages.find((x) => x.matches.includes(ageText ?? ''))?.age;
      break;
    }
  }

  return { found, age };
}

// #endregion

// #region [inappropriate]
function prepareWordRegex(word: string, pluralize = false) {
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

export function promptWordReplace(prompt: string, word: string, replacement = '') {
  const regex = prepareWordRegex(word);
  const match = regex.exec(prompt);
  if (!match || typeof match.index === 'undefined') return prompt;
  const target = trimNonAlphanumeric(match[0]) as string;
  return (
    prompt.substring(0, match.index) + prompt.substring(match.index).replace(target, replacement)
  );
}

type Checkable = { regex: RegExp; word: string };
type MatcherFn = (prompt: string, checkable: Checkable) => string | false;
type PreprocessorFn = (word: string) => string;
export function checkable(
  words: string[],
  options?: { pluralize?: boolean; matcher?: MatcherFn; preprocessor?: PreprocessorFn }
) {
  const regexes = words.map((word) => {
    const regex = prepareWordRegex(word, options?.pluralize);
    return { regex, word } as Checkable;
  });
  function preprocessor(prompt: string) {
    prompt = prompt.trim();
    if (options?.preprocessor) return options.preprocessor(prompt);
    return prompt;
  }

  function inPrompt(prompt: string, matcher?: MatcherFn) {
    prompt = preprocessor(prompt);
    matcher ??= options?.matcher;
    for (const { regex, word } of regexes) {
      if (matcher) {
        const result = matcher(prompt, { regex, word });
        if (result !== false) return result;
        else continue;
      }
      if (regex.test(prompt)) return word;
    }
    return false;
  }
  function highlight(prompt: string, replaceFn: (word: string) => string) {
    const target = preprocessor(prompt);
    for (const { regex } of regexes) {
      if (regex.test(target)) {
        const match = regex.exec(target);
        const word = trimNonAlphanumeric(match?.[0]);
        if (!word) continue;
        // prompt = prompt.replace(word, replaceFn(word));
        prompt = highlightReplacement(target, match, replaceFn);
      }
    }
    return prompt;
  }
  return { inPrompt, highlight };
}

function inPromptEdit(prompt: string, { regex }: Checkable) {
  const match = prompt.match(regex);
  if (!match) return false;

  // see if the word is wrapped in `[` and `]` and also has a `|` or `:` between the braces
  const wrapped = match.some((m) => {
    const start = prompt.lastIndexOf('[', prompt.indexOf(m));
    const end = prompt.indexOf(']', prompt.indexOf(m));
    const insideBlock = start !== -1 && end !== -1 && start < end;
    if (!insideBlock) return false;

    // Also has a `|` or `:` between the braces
    const hasPipe =
      prompt
        .slice(start, end)
        .split('|')
        .filter((x) => x.trim().length > 0).length > 1;
    const hasColon =
      prompt
        .slice(start, end)
        .split(':')
        .filter((x) => x.trim().length > 0).length > 2;
    return hasPipe || hasColon;
  });
  return wrapped;
}

const composedNouns = youngWords.partialNouns.flatMap((word) => {
  return youngWords.adjectives.map((adj) => adj + '([\\s|\\w]*|[^\\w]+)' + word);
});
const words = {
  nsfw: checkable(nsfwWords),
  young: {
    nouns: checkable(youngWords.nouns.concat(composedNouns), {
      pluralize: true,
    }),
  },
  poi: checkable(poiWords, {
    preprocessor: (word) => word.replace(/[^\w\s\|\:\[\]]/g, ''),
  }),
  tags: Object.entries(promptTags).map(([tag, words]) => ({ tag, words: checkable(words) })),
};

export function getTagsFromPrompt(prompt: string | undefined) {
  if (!prompt) return false;

  const tags = new Set<string>();
  for (const lookup of words.tags) {
    if (lookup.words.inPrompt(prompt)) tags.add(lookup.tag);
  }

  return [...tags];
}

export function includesNsfw(prompt: string | undefined) {
  if (!prompt) return false;

  return words.nsfw.inPrompt(prompt);
}

export function includesPoi(prompt: string | undefined, includeEdit = false) {
  if (!prompt) return false;
  let matcher = undefined;
  if (!includeEdit)
    matcher = (prompt: string, checkable: Checkable) => {
      if (inPromptEdit(prompt, checkable)) return false;
      const found = checkable.regex.test(prompt);
      if (found) return checkable.word;
      return false;
    };

  return words.poi.inPrompt(prompt, matcher);
}

export function includesMinor(prompt: string | undefined) {
  if (!prompt) return false;

  return includesMinorAge(prompt).found || words.young.nouns.inPrompt(prompt);
}

export function includesInappropriate(prompt: string | undefined, nsfw?: boolean) {
  if (!prompt) return false;
  prompt = prompt.replace(/'|\.|\-/g, '');
  if (!nsfw && !includesNsfw(prompt)) return false;
  if (includesPoi(prompt)) return 'poi';
  if (includesMinor(prompt)) return 'minor';
  return false;
}

// #endregion [inappropriate]

// #region [highlight]
const highlighters = [
  {
    color: '#7950F2',
    fn: highlightMinor,
  },
  {
    color: '#339AF0',
    fn: words.young.nouns.highlight,
  },
  {
    color: '#38d9a9',
    fn: words.poi.highlight,
  },
  {
    color: '#F03E3E',
    fn: highlightBlocked,
  },
  {
    color: '#FD7E14',
    fn: words.nsfw.highlight,
  },
];

function highlightReplacement(
  prompt: string,
  match: RegExpMatchArray | null,
  replaceFn: (word: string) => string
) {
  if (!match || typeof match.index === 'undefined') return prompt;
  const word = trimNonAlphanumeric(match[0]) as string;
  return (
    prompt.substring(0, match.index) + prompt.substring(match.index).replace(word, replaceFn(word))
  );
}

function highlightBlocked(prompt: string, replaceFn: (word: string) => string) {
  for (const { regex } of blockedNSFWRegex) {
    if (regex.test(prompt)) {
      const match = regex.exec(prompt);
      const word = trimNonAlphanumeric(match?.[0]);
      if (!word) continue;
      prompt = prompt.replace(word, replaceFn(word));
    }
  }
  return prompt;
}

function highlightMinor(prompt: string, replaceFn: (word: string) => string) {
  for (const regex of ageRegexes) {
    if (regex.test(prompt)) {
      const match = regex.exec(prompt);
      const ageText = match?.groups?.age?.toLowerCase();
      const age = ages.find((x) => x.matches.includes(ageText ?? ''))?.age;
      if (!age) continue;

      const word = trimNonAlphanumeric(match?.[0]);
      if (!word) continue;
      prompt = prompt.replace(word, replaceFn(word));
    }
  }

  return prompt;
}

export function highlightInappropriate(prompt: string | undefined) {
  if (!prompt) return prompt;
  for (const { fn, color } of highlighters) {
    prompt = fn(prompt, (word) => `<span style="color: ${color}">${word}</span>`);
  }
  return prompt;
}
// #endregion [highlight]
