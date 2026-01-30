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
// Prepare Regexes - Two Phase Approach
// --------------------------------------
// Phase 1: Quick screening pattern - rejects most prompts instantly
const quickScreenPattern =
  /(?:age[ds]?|year|old|birthday|anos|\b(?:1[0-7]|[1-9])\b|teen|eleven|twelve|one|two|three|four|five|six|seven|eight|nine|ten)/i;

// Phase 2: Per-age regex patterns (much smaller than one giant alternation)
// Expand teen variations for ages 13-17
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

// Build regex patterns for each age separately
const yearsPattern = templateParts.years.join('|');
const oldPattern = templateParts.old.join('|');

const perAgeRegexes = ages.map((ageEntry) => {
  const agePattern = ageEntry.matches.join('|');
  const regexes = templates.map((template) => {
    let regexStr = template;
    regexStr = regexStr.replace('{age}', `(${agePattern})`);
    regexStr = regexStr.replace('{years}', `(${yearsPattern})`);
    regexStr = regexStr.replace('{old}', `(${oldPattern})`);
    // Limit to 0-3 non-alphanumeric chars between parts
    regexStr = regexStr.replace(/\s+/g, `[^a-zA-Z0-9]{0,3}`);
    regexStr = `([^a-zA-Z0-9]+|^)0*` + regexStr + `([^a-zA-Z0-9]+|$)`;
    return new RegExp(regexStr, 'i');
  });
  return { age: ageEntry.age, regexes };
});

// Legacy: Keep ageRegexes for debugAuditPrompt and highlightMinor (which iterate all templates)
// These use the combined pattern for detailed match info
const allAgeMatches = ages.flatMap((x) => x.matches);
const ageRegexes = templates.map((template) => {
  let regexStr = template;
  regexStr = regexStr.replace('{age}', `(?<age>${allAgeMatches.join('|')})`);
  regexStr = regexStr.replace('{years}', `(?<years>${yearsPattern})`);
  regexStr = regexStr.replace('{old}', `(?<old>${oldPattern})`);
  regexStr = regexStr.replace(/\s+/g, `[^a-zA-Z0-9]{0,3}`);
  regexStr = `([^a-zA-Z0-9]+|^)0*` + regexStr + `([^a-zA-Z0-9]+|$)`;
  return new RegExp(regexStr, 'i');
});

// --------------------------------------
// Age Check Function (Two-Phase Approach)
// --------------------------------------
export function includesMinorAge(prompt: string | undefined) {
  if (!prompt) return { found: false, age: undefined };

  // Phase 1: Quick screening - skip if prompt clearly doesn't contain age references
  // This rejects 99%+ of prompts instantly with a tiny regex
  if (!quickScreenPattern.test(prompt)) {
    return { found: false, age: undefined };
  }

  // Phase 2: Detailed matching - check each age with smaller per-age patterns
  for (const { age, regexes } of perAgeRegexes) {
    for (const regex of regexes) {
      if (regex.test(prompt)) {
        return { found: true, age };
      }
    }
  }

  return { found: false, age: undefined };
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
      const match = regex.exec(prompt);
      if (match) {
        // Return object with matched text (for highlighting) and pattern (for debugging)
        return { matchedText: match[0], pattern: word, regex: regex.source };
      }
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
): { type: 'minor' | 'poi'; matchedWord?: string; regex?: string; pattern?: string } | false {
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
  if (youngNoun) {
    const isObject = typeof youngNoun === 'object';
    const matchedWord = isObject
      ? youngNoun.matchedText
      : typeof youngNoun === 'string'
      ? youngNoun
      : undefined;
    const regex = isObject ? youngNoun.regex : undefined;
    const pattern = isObject ? youngNoun.pattern : undefined;
    return { type: 'minor', matchedWord, regex, pattern };
  }

  if (input.negativePrompt) {
    const negYoung = words.young.negativeNouns.inPrompt(input.negativePrompt);
    if (negYoung) {
      const isObject = typeof negYoung === 'object';
      const matchedWord = isObject
        ? negYoung.matchedText
        : typeof negYoung === 'string'
        ? negYoung
        : undefined;
      const regex = isObject ? negYoung.regex : undefined;
      const pattern = isObject ? negYoung.pattern : undefined;
      return { type: 'minor', matchedWord, regex, pattern };
    }
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

// #region [debug]
// --------------------------------------
// Debug Audit Function
// --------------------------------------
export interface DebugAuditMatch {
  check: string;
  matched: boolean;
  matchedText?: string;
  regex?: string;
  context?: string;
  details?: Record<string, unknown>;
}

export interface DebugAuditResult {
  normalizedPrompt: string;
  normalizedNegativePrompt?: string;
  matches: DebugAuditMatch[];
  wouldBlock: boolean;
  blockReason?: string;
}

/**
 * Debug version of audit that returns detailed information about ALL checks,
 * not just the first failure. Used for debugging problematic prompts.
 */
export function debugAuditPrompt(prompt: string, negativePrompt?: string): DebugAuditResult {
  const matches: DebugAuditMatch[] = [];
  const normalizedPrompt = normalizeText(prompt);
  const normalizedNegativePrompt = normalizeText(negativePrompt);

  // 1. Minor age check - test all templates
  for (let i = 0; i < ageRegexes.length; i++) {
    const regex = ageRegexes[i];
    const match = regex.exec(normalizedPrompt);
    if (match) {
      const ageText = match?.groups?.age?.toLowerCase();
      const age = ages.find((x) => x.matches.includes(ageText ?? ''))?.age;
      matches.push({
        check: `minor_age`,
        matched: true,
        matchedText: match[0],
        regex: regex.source,
        context: normalizedPrompt.substring(
          Math.max(0, (match.index ?? 0) - 30),
          (match.index ?? 0) + (match[0]?.length ?? 0) + 30
        ),
        details: { templateIndex: i, template: templates[i], ageText, detectedAge: age },
      });
    }
  }

  // 2. POI check
  const poiMatch = includesPoi(normalizedPrompt);
  if (poiMatch) {
    matches.push({
      check: 'poi',
      matched: true,
      matchedText: typeof poiMatch === 'string' ? poiMatch : undefined,
    });
  }
  const negPoiMatch = includesPoi(normalizedNegativePrompt);
  if (negPoiMatch) {
    matches.push({
      check: 'poi (negative)',
      matched: true,
      matchedText: typeof negPoiMatch === 'string' ? negPoiMatch : undefined,
    });
  }

  // 3. Inappropriate content check
  const inappropriateResult = includesInappropriateEnriched({
    prompt: normalizedPrompt,
    negativePrompt: normalizedNegativePrompt,
  });
  if (inappropriateResult) {
    matches.push({
      check: `inappropriate_${inappropriateResult.type}`,
      matched: true,
      matchedText: inappropriateResult.matchedWord,
      regex: inappropriateResult.regex,
      details: inappropriateResult.pattern ? { pattern: inappropriateResult.pattern } : undefined,
    });
  }

  // 4. NSFW blocklist check
  for (const { word, regex } of blockedNSFWRegexLazy()) {
    const match = regex.exec(normalizedPrompt);
    if (match) {
      matches.push({
        check: `nsfw_blocklist`,
        matched: true,
        matchedText: match[0],
        regex: regex.source,
        details: { blockedWord: word },
        context: normalizedPrompt.substring(
          Math.max(0, (match.index ?? 0) - 20),
          (match.index ?? 0) + (match[0]?.length ?? 0) + 20
        ),
      });
    }
  }

  // 5. Young nouns check (only if not already captured by inappropriate_minor)
  const hasInappropriateMinor = inappropriateResult && inappropriateResult.type === 'minor';
  if (!hasInappropriateMinor) {
    const youngNoun = words.young.nouns.inPrompt(normalizedPrompt);
    if (youngNoun) {
      const isObject = typeof youngNoun === 'object';
      matches.push({
        check: 'young_nouns',
        matched: true,
        matchedText: isObject
          ? youngNoun.matchedText
          : typeof youngNoun === 'string'
          ? youngNoun
          : undefined,
        regex: isObject ? youngNoun.regex : undefined,
        details: isObject ? { pattern: youngNoun.pattern } : undefined,
      });
    }
  }

  // 6. Young negative nouns check (only if not already captured by inappropriate_minor from negative prompt)
  if (normalizedNegativePrompt && !hasInappropriateMinor) {
    const negYoung = words.young.negativeNouns.inPrompt(normalizedNegativePrompt);
    if (negYoung) {
      const isObject = typeof negYoung === 'object';
      matches.push({
        check: 'young_nouns (negative)',
        matched: true,
        matchedText: isObject
          ? negYoung.matchedText
          : typeof negYoung === 'string'
          ? negYoung
          : undefined,
        regex: isObject ? negYoung.regex : undefined,
        details: isObject ? { pattern: negYoung.pattern } : undefined,
      });
    }
  }

  // Determine if this would block
  const auditResult = auditPromptEnriched(prompt, negativePrompt, false);

  return {
    normalizedPrompt,
    normalizedNegativePrompt: normalizedNegativePrompt || undefined,
    matches,
    wouldBlock: !auditResult.success,
    blockReason: auditResult.blockedFor[0],
  };
}
// #endregion [debug]
