// Prompt inappropriate-content detection + highlighting, ported from the main app's
// src/utils/metadata/audit.ts (the `includesInappropriate` / `highlightInappropriate` path only —
// no profanity/enriched/debug branches).
//
// The vocabulary (`./lists`) and the term->regex builder (`./word-regex`) are now shared: the main
// app imports both from here, so there is one copy of each. What is still duplicated is the
// DETECTION LOGIC below — the checkable/gate machinery and the age engine — which the main app
// still has its own copy of. Keeping those in step is manual.
//
// Highlighting differs from the legacy HTML approach: instead of sequential string-replace into
// `<span>` (which injects unescaped user text — unsafe in Svelte — and mangles punctuation on the poi
// pass), detection yields the matched TERMS and a linear indexOf pass maps them to character ranges on
// the displayed (normalized) text. Result is a safe `PromptSegment[]` the client renders with <mark>.

import nsfwPromptWords from './lists/words-nsfw-prompt.json';
import nsfwWordsSoft from './lists/words-nsfw-soft.json';
import nsfwWordsPaddle from './lists/words-paddle-nsfw.json';
import poiWords from './lists/words-poi.json';
import youngWords from './lists/words-young.json';
import blockedNSFW from './lists/blocklist-nsfw.json';
import { prepareWordRegex, prepareWordRegexBody } from './word-regex';
import { ages, canonicalNumberWords, templateParts, templates } from './lists/ages';
import { harmfulCombinations } from './lists/harmful-combinations';
import { youngComposedNouns } from './lists/composed-nouns';

// Defense-in-depth length cap (main app's MAX_AUDIT_PROMPT_LENGTH). Realistic prompts are <1500 chars;
// anything past this is anomalous, so we bound the work rather than scan an adversarial input.
const MAX_PROMPT_LENGTH = 20000;
const cap = (s?: string) => (s && s.length > MAX_PROMPT_LENGTH ? s.slice(0, MAX_PROMPT_LENGTH) : s);

function lazy<T>(fn: () => T): () => T {
  let cache: T | undefined;
  let initialized = false;
  return () => {
    if (!initialized) {
      cache = fn();
      initialized = true;
    }
    return cache!;
  };
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};
function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code =
        entity[1] === 'x' || entity[1] === 'X'
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

// NFD-strip diacritics + decode HTML entities (the main app defers entity decode to `he`; a compact
// decoder is dependency-free and deterministic — real prompts rarely use exotic named entities).
export function normalizeText(input?: string): string {
  if (!input) return '';
  const decoded = input.includes('&') ? decodeEntities(input) : input;
  return decoded.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function trimNonAlphanumeric(str: string | null | undefined) {
  return str?.replace(/^[^\w]+|[^\w]+$/g, '') ?? '';
}

const nsfwWords = [...new Set([...nsfwPromptWords, ...nsfwWordsSoft, ...nsfwWordsPaddle])];

// #region [token-regex machinery]
const escapeRegex = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const blockedBoth = '\\%|\\~|\\\\$|\\.|-|\\(|\\)|\\[|\\]|\\{|\\}|:|\\|';
function tokenRegex(word: string) {
  return new RegExp(`(^|\\s|,|${blockedBoth})${escapeRegex(word)}(\\s|,|$|${blockedBoth})`, 'mi');
}

const blockedNSFWRegexLazy = lazy(() =>
  blockedNSFW.map((word) => ({ word, regex: tokenRegex(word) }))
);
// #endregion

// #region [checkable — verbatim gate + per-word regexes, plus range/term collectors]
type Checkable = { regex: RegExp; word: string };
type MatcherFn = (prompt: string, checkable: Checkable) => string | false;
type PreprocessorFn = (word: string) => string;

function checkable(
  words: string[],
  options?: {
    pluralize?: boolean;
    leet?: boolean;
    matcher?: MatcherFn;
    preprocessor?: PreprocessorFn;
  }
) {
  const bodies: string[] = [];
  const regexes = words.map((word) => {
    bodies.push(prepareWordRegexBody(word, options?.pluralize, options?.leet));
    const regex = prepareWordRegex(word, options?.pluralize, options?.leet);
    return { regex, word } as Checkable;
  });

  const GATE_CHUNK_SIZE = 200;
  const gateRegexes: RegExp[] = [];
  for (let i = 0; i < bodies.length; i += GATE_CHUNK_SIZE) {
    const chunk = bodies
      .slice(i, i + GATE_CHUNK_SIZE)
      .map((body) => `(?:${body})`)
      .join('|');
    gateRegexes.push(new RegExp(`(?<![a-zA-Z0-9])(?:${chunk})(?![a-zA-Z0-9])`, 'i'));
  }
  function gatePasses(prompt: string) {
    for (const gate of gateRegexes) if (gate.test(prompt)) return true;
    return false;
  }

  function preprocessor(prompt: string) {
    prompt = prompt.trim();
    if (options?.preprocessor) return options.preprocessor(prompt);
    return prompt;
  }

  function inPrompt(prompt: string, matcher?: MatcherFn) {
    prompt = preprocessor(prompt);
    if (!gatePasses(prompt)) return false;
    matcher ??= options?.matcher;
    for (const { regex, word } of regexes) {
      if (matcher) {
        const result = matcher(prompt, { regex, word });
        if (result !== false) return result;
        else continue;
      }
      const match = regex.exec(prompt);
      if (match) return { matchedText: match[0], pattern: word, regex: regex.source };
    }
    return false;
  }

  // Matched term text for every per-word regex that hits (first match each) — the highlight source.
  function terms(prompt: string): string[] {
    const target = preprocessor(prompt);
    if (!gatePasses(target)) return [];
    const out: string[] = [];
    for (const { regex } of regexes) {
      const match = regex.exec(target);
      const word = trimNonAlphanumeric(match?.[0]);
      if (word) out.push(word);
    }
    return out;
  }

  return { inPrompt, terms };
}
// #endregion

// #region [minor-age engine — verbatim]

const yearsPattern = templateParts.years.join('|');
const oldPattern = templateParts.old.join('|');

const buildAgePattern = (matches: string[]) =>
  matches.map((m) => (canonicalNumberWords.has(m) ? `${m}\\b` : m)).join('|');

const perAgeRegexes = ages.map((ageEntry) => {
  const agePattern = buildAgePattern(ageEntry.matches);
  const regexes = templates.map((template) => {
    let regexStr = template;
    regexStr = regexStr.replace('{age}', `(${agePattern})`);
    regexStr = regexStr.replace('{years}', `(${yearsPattern})`);
    regexStr = regexStr.replace('{old}', `(${oldPattern})`);
    regexStr = regexStr.replace(/\s+/g, `[^a-zA-Z0-9]{0,3}`);
    regexStr = `(?<![a-zA-Z0-9])0*` + regexStr + `(?![a-zA-Z0-9])`;
    return new RegExp(regexStr, 'i');
  });
  return { age: ageEntry.age, regexes };
});

const allAgeMatches = ages.flatMap((x) => x.matches);
const allAgePattern = buildAgePattern(allAgeMatches);
const ageRegexes = templates.map((template) => {
  let regexStr = template;
  regexStr = regexStr.replace('{age}', `(?<age>${allAgePattern})`);
  regexStr = regexStr.replace('{years}', `(?<years>${yearsPattern})`);
  regexStr = regexStr.replace('{old}', `(?<old>${oldPattern})`);
  regexStr = regexStr.replace(/\s+/g, `[^a-zA-Z0-9]{0,3}`);
  regexStr = `(?<![a-zA-Z0-9])0*` + regexStr + `(?![a-zA-Z0-9])`;
  return new RegExp(regexStr, 'i');
});

const quickScreenPattern =
  /(?:age[ds]?|year|old|birthday|anos|\b(?:1[0-7]|[1-9])\b|teen|eleven|twelve|one|two|three|four|five|six|seven|eight|nine|ten)/i;
const falsePositiveTagPattern = /\bscore_\d(?:_up|_down)?\b|\bsource_\w+\b|\brating_\w+\b/gi;

function includesMinorAge(prompt: string | undefined) {
  if (!prompt) return { found: false, age: undefined as number | undefined };
  const cleaned = prompt.replace(falsePositiveTagPattern, ' ');
  if (!quickScreenPattern.test(cleaned)) return { found: false, age: undefined };
  for (const { age, regexes } of perAgeRegexes) {
    for (const regex of regexes) {
      if (regex.test(cleaned)) return { found: true, age };
    }
  }
  return { found: false, age: undefined };
}

// The age phrases actually present in the prompt (for highlighting), mirroring highlightMinor: only
// phrases whose captured `age` group resolves to a known age.
function minorAgeTerms(prompt: string): string[] {
  const out: string[] = [];
  for (const regex of ageRegexes) {
    const match = regex.exec(prompt);
    if (!match) continue;
    const ageText = match.groups?.age?.toLowerCase();
    const age = ages.find((x) => x.matches.includes(ageText ?? ''))?.age;
    if (!age) continue;
    const word = trimNonAlphanumeric(match[0]);
    if (word) out.push(word);
  }
  return out;
}
// #endregion

// #region [detectors — verbatim]
const words = {
  nsfw: checkable(nsfwWords),
  young: {
    nouns: checkable(youngWords.nouns.concat(youngComposedNouns), { pluralize: true }),
    negativeNouns: checkable(youngWords.negativeNouns, { pluralize: true }),
  },
  poi: checkable(poiWords, {
    leet: false,
    preprocessor: (word) => word.replace(/[^\w\s\|\:\[\],]/g, ''),
  }),
};

function inPromptEdit(prompt: string, { regex }: Checkable) {
  const match = prompt.match(regex);
  if (!match) return false;
  return match.some((m) => {
    const start = prompt.lastIndexOf('[', prompt.indexOf(m));
    const end = prompt.indexOf(']', prompt.indexOf(m));
    const insideBlock = start !== -1 && end !== -1 && start < end;
    if (!insideBlock) return false;
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
}

function includesNsfw(prompt: string | undefined) {
  if (!prompt) return false;
  return words.nsfw.inPrompt(prompt);
}

function includesPoi(prompt: string | undefined, includeEdit = false) {
  if (!prompt) return false;
  let matcher: MatcherFn | undefined = undefined;
  if (!includeEdit)
    matcher = (p: string, c: Checkable) => {
      if (inPromptEdit(p, c)) return false;
      if (c.regex.test(p)) return c.word;
      return false;
    };
  return words.poi.inPrompt(prompt, matcher);
}

function includesMinor(prompt: string | undefined, negativePrompt?: string) {
  if (!prompt) return false;
  return (
    includesMinorAge(prompt).found ||
    words.young.nouns.inPrompt(prompt) ||
    (!!negativePrompt && words.young.negativeNouns.inPrompt(negativePrompt))
  );
}

function includesHarmfulCombinations(prompt: string): 'minor' | 'poi' | false {
  if (!prompt) return false;
  const normalizedPrompt = normalizeText(prompt);
  for (const combination of harmfulCombinations) {
    if (combination.pattern.test(normalizedPrompt)) return combination.type;
  }
  return false;
}

export function includesInappropriate(
  input: { prompt?: string; negativePrompt?: string },
  nsfw?: boolean
): 'poi' | 'minor' | false {
  if (!input.prompt) return false;
  const prompt = input.prompt.replace(/'|\.|\-/g, '');

  const harmfulCombo = includesHarmfulCombinations(prompt);
  if (harmfulCombo) return harmfulCombo;

  if (!nsfw && !includesNsfw(prompt)) return false;

  if (input.negativePrompt) {
    const negativeHarmfulCombo = includesHarmfulCombinations(input.negativePrompt);
    if (negativeHarmfulCombo) return negativeHarmfulCombo;
  }

  if (includesPoi(prompt)) return 'poi';
  if (includesMinor(prompt, input.negativePrompt)) return 'minor';
  return false;
}
// #endregion

// #region [segment highlighting]
// `age` is an explicit age mention of ANY age ("18yo", "21 years old") — not in the legacy, added for
// minor review where a claimed age (even 18+) is exactly what the moderator scrutinizes. `minor` still
// wins over `age` for sub-18 ages (both match, priority resolves).
export type PromptHighlightCategory = 'minor' | 'age' | 'young' | 'poi' | 'blocked' | 'nsfw';
export type PromptSegment = { text: string; category: PromptHighlightCategory | null };

// Higher wins where flagged spans overlap.
const CATEGORY_PRIORITY: Record<PromptHighlightCategory, number> = {
  minor: 6,
  age: 5,
  young: 4,
  poi: 3,
  blocked: 2,
  nsfw: 1,
};

// Any explicit age mention: "18yo", "21 yo", "16yrs", "18 years old", "8 y/o".
const AGE_MENTION = /\b\d{1,3}\s?(?:y\/?o|years?\s?old|yrs?)\b/gi;
function ageMentionTerms(text: string): string[] {
  return text.match(AGE_MENTION) ?? [];
}

function blockedTerms(prompt: string): string[] {
  const out: string[] = [];
  for (const { regex } of blockedNSFWRegexLazy()) {
    const word = trimNonAlphanumeric(regex.exec(prompt)?.[0]);
    if (word) out.push(word);
  }
  return out;
}

// Mark every occurrence of each flagged term on the display text; priority resolves overlaps. indexOf
// is linear (the ReDoS surface is the detection regexes above, which already ran) and keeps ranges
// aligned to the exact text the client renders.
function buildSegments(
  text: string,
  termsByCategory: Array<{ category: PromptHighlightCategory; terms: string[] }>
): PromptSegment[] {
  if (!text) return [];
  const charCategory = new Array<PromptHighlightCategory | null>(text.length).fill(null);
  const charPriority = new Array<number>(text.length).fill(0);
  const hay = text.toLowerCase();

  for (const { category, terms } of termsByCategory) {
    const priority = CATEGORY_PRIORITY[category];
    for (const term of terms) {
      const needle = term.toLowerCase();
      if (!needle) continue;
      let from = 0;
      let idx = hay.indexOf(needle, from);
      while (idx !== -1) {
        for (let i = idx; i < idx + needle.length; i++) {
          if (priority > charPriority[i]) {
            charCategory[i] = category;
            charPriority[i] = priority;
          }
        }
        from = idx + needle.length;
        idx = hay.indexOf(needle, from);
      }
    }
  }

  const segments: PromptSegment[] = [];
  let i = 0;
  while (i < text.length) {
    let j = i;
    while (j < text.length && charCategory[j] === charCategory[i]) j++;
    segments.push({ text: text.slice(i, j), category: charCategory[i] });
    i = j;
  }
  return segments;
}

export type PromptHighlightResult = {
  // Whether the audit considers this prompt inappropriate (the main app's minor card gates on this).
  includesInappropriate: boolean;
  prompt: PromptSegment[];
  negativePrompt: PromptSegment[] | null;
  // Any flagged span in either prompt — lets a caller skip rendering when there's nothing to show.
  hasHighlights: boolean;
};

// Segment-highlight a prompt/negativePrompt for moderator review. By default highlights all categories
// (minor-age/young/poi/blocked/nsfw), matching the legacy highlightInappropriate. Pass `categories` to
// restrict which detectors run — e.g. the minor queue only wants minor-relevant terms (`['minor',
// 'young']`), not every nsfw/poi word in a spicy prompt. Runs SERVER-SIDE (pulls ~50KB of word lists) —
// never import into client bundles.
export function getPromptHighlightSegments(
  rawPrompt?: string | null,
  rawNegativePrompt?: string | null,
  options?: { categories?: PromptHighlightCategory[] }
): PromptHighlightResult {
  const prompt = normalizeText(cap(rawPrompt ?? undefined));
  const negativePrompt = normalizeText(cap(rawNegativePrompt ?? undefined));

  const includesFlag = includesInappropriate({ prompt, negativePrompt }) !== false;

  const cats = options?.categories;
  const wants = (c: PromptHighlightCategory) => !cats || cats.includes(c);

  const sources: Array<{ category: PromptHighlightCategory; terms: string[] }> = [];
  if (prompt) {
    if (wants('minor')) sources.push({ category: 'minor', terms: minorAgeTerms(prompt) });
    if (wants('age')) sources.push({ category: 'age', terms: ageMentionTerms(prompt) });
    if (wants('young')) sources.push({ category: 'young', terms: words.young.nouns.terms(prompt) });
    if (wants('poi')) sources.push({ category: 'poi', terms: words.poi.terms(prompt) });
    if (wants('blocked')) sources.push({ category: 'blocked', terms: blockedTerms(prompt) });
    if (wants('nsfw')) sources.push({ category: 'nsfw', terms: words.nsfw.terms(prompt) });
  }
  const promptSegments = prompt ? buildSegments(prompt, sources) : [];

  const negativeSegments =
    negativePrompt && wants('young')
      ? buildSegments(negativePrompt, [
          { category: 'young', terms: words.young.negativeNouns.terms(negativePrompt) },
        ])
      : null;

  const hasHighlights =
    promptSegments.some((s) => s.category !== null) ||
    (negativeSegments?.some((s) => s.category !== null) ?? false);

  return {
    includesInappropriate: includesFlag,
    prompt: promptSegments,
    negativePrompt: negativeSegments,
    hasHighlights,
  };
}
// #endregion
