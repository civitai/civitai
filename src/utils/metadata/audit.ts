import { ImageMetaProps } from '~/server/schema/image.schema';
import blockedNSFW from './lists/blocklist-nsfw.json';
import blocked from './lists/blocklist.json';
import nsfwWords from './lists/words-nsfw.json';
import youngWords from './lists/words-young.json';

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

  // Add minor check
  if (nsfw) {
    const { found, age } = includesMinor(meta.prompt);
    if (found) return { blockedFor: [`${age} year old`], success: false };
    if (includesInappropriate(meta.prompt, true))
      return { blockedFor: ['Inappropriate minor content'], success: false };
  }

  const blockList = nsfw ? blockedNSFWRegex : blockedRegex;
  const blockedFor = blockList
    .filter(({ regex }) => meta?.prompt && regex.test(meta.prompt))
    .map((x) => x.word);
  return { blockedFor, success: !blockedFor.length };
};

export const auditPrompt = (prompt: string) => {
  const { found, age } = includesMinor(prompt);
  if (found) return { blockedFor: [`${age} year old`], success: false };

  const inappropriate = includesInappropriate(prompt);
  if (inappropriate) return { blockedFor: ['Inappropriate minor content'], success: false };

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
  { age: 2, matches: ['two', 'too', 'to', 'tu', '2'] },
  { age: 1, matches: ['one', 'uno', '1'] },
];

const templateParts = {
  age: [] as string[], // Filled in later
  teen: ['teen', 'ten', 'tein', 'tien', 'tn'],
  years: ['y', 'yr', 'yrs', 'years', 'year'],
  old: ['o', 'old'],
};
const templates = [
  'aged {age}',
  'age {age}',
  '{age} age',
  '{age} {years} {old}',
  '{age} {years}',
  '{age}th birthday',
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
  regexStr = regexStr.replace(/\s+/g, `[^\\w]*`);
  regexStr = `([^\\w]+|^)` + regexStr + `([^\\w]+|$)`;
  return new RegExp(regexStr, 'i');
});

// --------------------------------------
// Age Check Function
// --------------------------------------
export function includesMinor(prompt: string | undefined) {
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
export function checkable(words: string[], options?: { pluralize?: boolean }) {
  const regexes = words.map((word) => {
    let regexStr = word;
    regexStr = regexStr.replace(/\s+/g, `[^\\w]*`);
    if (!word.includes('[')) {
      regexStr = regexStr
        .replace(/i/g, '[i|l|1]')
        .replace(/o/g, '[o|0]')
        .replace(/s/g, '[s|z]')
        .replace(/e/g, '[e|3]');
    }
    if (options?.pluralize) regexStr += '[s|z]*';
    regexStr = `([^\\w]+|^)` + regexStr + `([^\\w]+|$)`;
    return new RegExp(regexStr, 'i');
  });
  function inPrompt(prompt: string) {
    prompt = prompt.trim();
    for (const regex of regexes) {
      if (regex.test(prompt)) return true;
    }
    return false;
  }
  return { inPrompt };
}

const composedNouns = youngWords.partialNouns.flatMap((word) => {
  return youngWords.adjectives.map((adj) => adj + '([\\s|\\w]*|[^\\w]+)' + word);
});
const words = {
  nsfw: checkable(nsfwWords),
  young: {
    nouns: checkable(youngWords.nouns.concat(composedNouns), { pluralize: true }),
  },
};

export function includesInappropriate(prompt: string | undefined, nsfw?: boolean) {
  if (!prompt) return false;
  if (!nsfw && !words.nsfw.inPrompt(prompt)) return false;
  return words.young.nouns.inPrompt(prompt);
}
// #endregion [inappropriate]
