import type { ImageMetaProps } from '~/server/schema/image.schema';
import { normalizeText } from '~/utils/normalize-text';
import { trimNonAlphanumeric } from '~/utils/string-helpers';
import blockedNSFW from './lists/blocklist-nsfw.json';
import promptTags from './lists/prompt-tags.json';
import nsfwPromptWords from './lists/words-nsfw-prompt.json';
import nsfwWordsSoft from './lists/words-nsfw-soft.json';
import nsfwWordsPaddle from './lists/words-paddle-nsfw.json';
import poiWords from './lists/words-poi.json';
import youngWords from './lists/words-young.json';
import { harmfulCombinations } from './lists/harmful-combinations';
import { blockedNSFWRegexLazy, blockedRegexLazy } from '~/utils/metadata/audit-base';
import { createProfanityFilter } from '~/libs/profanity-simple';

const nsfwWords = [...new Set([...nsfwPromptWords, ...nsfwWordsSoft, ...nsfwWordsPaddle])];

// #region [audit]

export function getPossibleBlockedNsfwWords(value?: string | null) {
  if (!value) return [];
  const regex = new RegExp(value, 'i');
  return blockedNSFW.filter((word) => regex.test(word));
}

export const auditMetaData = (meta: ImageMetaProps | undefined, nsfw: boolean) => {
  if (!meta) return { blockedFor: [], success: true };
  const prompt = normalizeText(meta.prompt);

  // Add minor check
  if (nsfw) {
    const { found, age } = includesMinorAge(prompt);
    if (found && age != null) return { blockedFor: [`${age} year old`], success: false };
  }

  const blockList = nsfw ? blockedNSFWRegexLazy() : blockedRegexLazy();
  const blockedFor = blockList
    .filter(({ regex }) => meta?.prompt && regex.test(prompt))
    .map((x) => x.word);
  return { blockedFor, success: !blockedFor.length };
};

// #region [enriched audit]
// Structured trigger data for server-side tracking, moderator review, and false-positive allowlisting
export type PromptTriggerCategory =
  | 'minor_age'
  | 'poi'
  | 'inappropriate_minor'
  | 'inappropriate_poi'
  | 'nsfw_blocklist'
  | 'profanity'
  | 'harmful_combo'
  | 'external';

export interface PromptTrigger {
  category: PromptTriggerCategory;
  message: string;
  matchedWord?: string;
}

export interface EnrichedAuditResult {
  blockedFor: string[];
  triggers: PromptTrigger[];
  success: boolean;
}

/**
 * Enriched version of auditPrompt that returns structured trigger data alongside blockedFor.
 * Used server-side for UserBan records, moderator UI, and the false-positive allowlist system.
 */
export const auditPromptEnriched = (
  prompt: string,
  negativePrompt?: string,
  checkProfanity?: boolean
): EnrichedAuditResult => {
  if (!prompt.trim().length) return { blockedFor: [], triggers: [], success: true };
  prompt = normalizeText(prompt);
  negativePrompt = normalizeText(negativePrompt);

  // 1. Minor age check
  const { found, age } = includesMinorAge(prompt);
  if (found && age != null) {
    const message = `${age} year old`;
    return {
      blockedFor: [message],
      triggers: [{ category: 'minor_age', message, matchedWord: String(age) }],
      success: false,
    };
  }

  // 2. POI check
  const poiMatch = includesPoi(prompt);
  if (poiMatch) {
    const message = 'Prompt cannot include celebrity names';
    return {
      blockedFor: [message],
      triggers: [
        {
          category: 'poi',
          message,
          matchedWord: typeof poiMatch === 'string' ? poiMatch : undefined,
        },
      ],
      success: false,
    };
  }
  const negPoiMatch = includesPoi(negativePrompt);
  if (negPoiMatch) {
    const message = 'Negative prompt cannot include celebrity names';
    return {
      blockedFor: [message],
      triggers: [
        {
          category: 'poi',
          message,
          matchedWord: typeof negPoiMatch === 'string' ? negPoiMatch : undefined,
        },
      ],
      success: false,
    };
  }

  // 3. Inappropriate content check (with matched word capture)
  const inappropriateResult = includesInappropriateEnriched({ prompt, negativePrompt });
  if (inappropriateResult) {
    const message =
      inappropriateResult.type === 'minor'
        ? 'Inappropriate minor content'
        : 'Inappropriate real person content';
    const category: PromptTriggerCategory =
      inappropriateResult.type === 'minor' ? 'inappropriate_minor' : 'inappropriate_poi';
    return {
      blockedFor: [message],
      triggers: [{ category, message, matchedWord: inappropriateResult.matchedWord }],
      success: false,
    };
  }

  // 4. NSFW blocklist check
  for (const { word, regex } of blockedNSFWRegexLazy()) {
    if (regex.test(prompt)) {
      return {
        blockedFor: [word],
        triggers: [{ category: 'nsfw_blocklist', message: word, matchedWord: word }],
        success: false,
      };
    }
  }

  // 5. Profanity check (green domain only)
  if (checkProfanity) {
    const profanityFilter = createProfanityFilter();
    const profanityResults = profanityFilter.analyze(prompt);
    if (profanityResults.isProfane) {
      return {
        blockedFor: profanityResults.matches,
        triggers: profanityResults.matches.map((word: string) => ({
          category: 'profanity' as const,
          message: word,
          matchedWord: word,
        })),
        success: false,
      };
    }
  }

  return { blockedFor: [], triggers: [], success: true };
};
// #endregion [enriched audit]

export const auditPrompt = (
  prompt: string,
  negativePrompt?: string,
  checkProfanity?: boolean
): { blockedFor: string[]; success: boolean } => {
  const { blockedFor, success } = auditPromptEnriched(prompt, negativePrompt, checkProfanity);
  return { blockedFor, success };
};

const nsfwPromptExpressions = nsfwPromptWords.map((word) => prepareWordRegex(word));
const paddleNsfwExpressions = nsfwWordsPaddle.map((word) => prepareWordRegex(word));

export function hasNsfwPrompt(text?: string | null) {
  if (!text) return false;
  const str = normalizeText(text);
  for (const expression of [...nsfwPromptExpressions, ...paddleNsfwExpressions]) {
    if (expression.test(str)) {
      return true;
    }
  }
  return false;
}
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
    negativeNouns: checkable(youngWords.negativeNouns, {
      pluralize: true,
    }),
  },
  poi: checkable(poiWords, {
    preprocessor: (word) => word.replace(/[^\w\s\|\:\[\],]/g, ''),
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

export function includesMinor(prompt: string | undefined, negativePrompt?: string) {
  if (!prompt) return false;

  return (
    includesMinorAge(prompt).found ||
    words.young.nouns.inPrompt(prompt) ||
    (negativePrompt && words.young.negativeNouns.inPrompt(negativePrompt))
  );
}

function includesHarmfulCombinations(prompt: string): 'minor' | 'poi' | false {
  if (!prompt) return false;

  const normalizedPrompt = normalizeText(prompt);

  for (const combination of harmfulCombinations) {
    if (combination.pattern.test(normalizedPrompt)) {
      return combination.type;
    }
  }

  return false;
}

function includesHarmfulCombinationsEnriched(
  prompt: string
): { type: 'minor' | 'poi'; matchedText: string } | false {
  if (!prompt) return false;

  const normalizedPrompt = normalizeText(prompt);

  for (const combination of harmfulCombinations) {
    const match = combination.pattern.exec(normalizedPrompt);
    if (match) {
      return { type: combination.type, matchedText: match[0] };
    }
  }

  return false;
}

export function includesInappropriate(
  input: { prompt?: string; negativePrompt?: string },
  nsfw?: boolean
) {
  if (!input.prompt) return false;
  input.prompt = input.prompt.replace(/'|\.|\-/g, '');

  const harmfulCombo = includesHarmfulCombinations(input.prompt);
  if (harmfulCombo) return harmfulCombo;

  if (!nsfw && !includesNsfw(input.prompt)) return false;

  // Check for harmful combinations first

  // Also check negative prompt for harmful combinations
  if (input.negativePrompt) {
    const negativeHarmfulCombo = includesHarmfulCombinations(input.negativePrompt);
    if (negativeHarmfulCombo) return negativeHarmfulCombo;
  }

  if (includesPoi(input.prompt)) return 'poi';
  if (includesMinor(input.prompt, input.negativePrompt)) return 'minor';
  return false;
}

function includesInappropriateEnriched(
  input: { prompt?: string; negativePrompt?: string },
  nsfw?: boolean
): { type: 'minor' | 'poi'; matchedWord?: string } | false {
  if (!input.prompt) return false;
  input.prompt = input.prompt.replace(/'|\.|\-/g, '');

  // Harmful combinations (with matched text capture)
  const harmfulCombo = includesHarmfulCombinationsEnriched(input.prompt);
  if (harmfulCombo) return { type: harmfulCombo.type, matchedWord: harmfulCombo.matchedText };

  if (!nsfw && !includesNsfw(input.prompt)) return false;

  // Negative prompt harmful combinations
  if (input.negativePrompt) {
    const negativeHarmfulCombo = includesHarmfulCombinationsEnriched(input.negativePrompt);
    if (negativeHarmfulCombo)
      return { type: negativeHarmfulCombo.type, matchedWord: negativeHarmfulCombo.matchedText };
  }

  // POI — includesPoi returns the matched name (string) or false
  const poiResult = includesPoi(input.prompt);
  if (poiResult)
    return { type: 'poi', matchedWord: typeof poiResult === 'string' ? poiResult : undefined };

  // Minor — check each sub-check individually to capture the matched word
  const ageCheck = includesMinorAge(input.prompt);
  if (ageCheck.found && ageCheck.age != null)
    return { type: 'minor', matchedWord: `${ageCheck.age} year old` };

  const youngNoun = words.young.nouns.inPrompt(input.prompt);
  if (youngNoun)
    return { type: 'minor', matchedWord: typeof youngNoun === 'string' ? youngNoun : undefined };

  if (input.negativePrompt) {
    const negYoung = words.young.negativeNouns.inPrompt(input.negativePrompt);
    if (negYoung)
      return { type: 'minor', matchedWord: typeof negYoung === 'string' ? negYoung : undefined };
  }

  return false;
}

// #endregion [inappropriate]

// #region [highlight]
const highlighters = {
  positive: [
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
  ],
  negative: [
    {
      color: '#339AF0',
      fn: words.young.negativeNouns.highlight,
    },
  ],
};

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
  for (const { regex } of blockedNSFWRegexLazy()) {
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

export function highlightInappropriate({
  prompt,
  negativePrompt,
}: {
  prompt?: string;
  negativePrompt?: string;
}) {
  if (!prompt) return prompt;
  for (const { fn, color } of highlighters.positive) {
    prompt = fn(prompt, (word) => `<span style="color: ${color}">${word}</span>`);
  }
  if (negativePrompt) {
    for (const { fn, color } of highlighters.negative) {
      negativePrompt = fn(negativePrompt, (word) => `<span style="color: ${color}">${word}</span>`);
    }
    prompt += `<br><br><span style="color: #777">Negative Prompt:</span><br>${negativePrompt}`;
  }

  return prompt;
}

export function cleanPrompt({
  prompt,
  negativePrompt,
}: {
  prompt?: string;
  negativePrompt?: string;
}): { prompt?: string; negativePrompt?: string } {
  if (!prompt) return {};
  prompt = normalizeText(prompt); // Parse HTML Entities
  negativePrompt = normalizeText(negativePrompt);

  // Remove blocked nsfw words
  for (const { word } of blockedNSFWRegexLazy()) {
    prompt = promptWordReplace(prompt, word);
  }

  // Determine if the prompt is nsfw
  const nsfw = includesNsfw(prompt);
  if (nsfw) {
    // Remove minor references
    prompt = highlightMinor(prompt, () => '');
    prompt = words.young.nouns.highlight(prompt, () => '');
    if (negativePrompt)
      negativePrompt = words.young.negativeNouns.highlight(negativePrompt ?? '', () => '');

    // Remove poi references
    prompt = words.poi.highlight(prompt, () => '');
  }

  return { prompt, negativePrompt };
}
// #endregion [highlight]
