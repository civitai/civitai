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
import { AuditTimer } from '~/utils/metadata/audit-slow-log';

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

// Defense-in-depth length cap applied before any audit regex runs. Every
// sub-check scans the prompt with hundreds of regexes; the worst-case cost of a
// pathological pattern grows with prompt length (the "504 wave" DoS was a regex
// backtracking on a long adversarial prompt). It also bounds an evasion class:
// any prompt LONGER than this ceiling is BLOCKED outright (see auditPromptEnriched
// below), not silently truncated — a prior truncate-then-scan let a banned word
// buried past the cap slip through the regex layer (#2727 M2). We do NOT rely on a
// schema `.max()` to make over-length input unreachable: the generation prompt
// schemas (including the `z.any()` generateFromGraph path) have NO `.max()`, so
// the audit layer is the only guard. A >20k-char prompt is anomalous (realistic
// prompts are <1500), so blocking is safe and closes the evasion for ALL callers.
// Complements the per-pattern quantifier bounds (e.g. the composed young-noun gap
// below): the bounds keep individual regexes linear, this keeps the whole
// pipeline's input bounded.
export const MAX_AUDIT_PROMPT_LENGTH = 20000;
const capAuditLength = <T extends string | undefined>(s: T): T =>
  typeof s === 'string' && s.length > MAX_AUDIT_PROMPT_LENGTH
    ? (s.slice(0, MAX_AUDIT_PROMPT_LENGTH) as T)
    : s;

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
  // Block over-length input outright (#2727 M2). Truncating then scanning would let
  // a banned word buried past MAX_AUDIT_PROMPT_LENGTH evade the regex layer; a
  // prompt this long is anomalous so we refuse it rather than scan a truncated copy.
  if (
    prompt.length > MAX_AUDIT_PROMPT_LENGTH ||
    (negativePrompt != null && negativePrompt.length > MAX_AUDIT_PROMPT_LENGTH)
  ) {
    return { blockedFor: ['Prompt exceeds the maximum allowed length'], triggers: [], success: false };
  }
  prompt = capAuditLength(prompt);
  negativePrompt = capAuditLength(negativePrompt);

  // Per-sub-check timing instrumentation. Always-on but threshold-gated: below
  // AUDIT_SLOW_LOG_MS it costs only a handful of `performance.now()` deltas and
  // emits nothing. On the pathological 11-47s CPU-pin (the "504 wave" DoS) it logs
  // ONE structured line naming the slowest sub-check + an input fingerprint. The
  // timer NEVER alters the audit result and `finish()` can never throw — it is
  // called on every return path below with the (normalized) prompts. The raw text
  // passed to finish() is what was audited; logging it is privacy-gated (see
  // audit-slow-log.ts). See that module's header for the full incident writeup.
  const timer = new AuditTimer();

  prompt = timer.time('normalize', () => normalizeText(prompt));
  negativePrompt = timer.time('normalize', () => normalizeText(negativePrompt));

  // 1. Minor age check
  const { found, age } = timer.time('minor_age', () => includesMinorAge(prompt));
  if (found && age != null) {
    const message = `${age} year old`;
    timer.finish(prompt, negativePrompt);
    return {
      blockedFor: [message],
      triggers: [{ category: 'minor_age', message, matchedWord: String(age) }],
      success: false,
    };
  }

  // 2. POI check
  const poiMatch = timer.time('poi', () => includesPoi(prompt));
  if (poiMatch) {
    const message = 'Prompt cannot include celebrity names';
    timer.finish(prompt, negativePrompt);
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
  const negPoiMatch = timer.time('poi', () => includesPoi(negativePrompt));
  if (negPoiMatch) {
    const message = 'Negative prompt cannot include celebrity names';
    timer.finish(prompt, negativePrompt);
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
  const inappropriateResult = timer.time('inappropriate', () =>
    includesInappropriateEnriched({ prompt, negativePrompt })
  );
  if (inappropriateResult) {
    const message =
      inappropriateResult.type === 'minor'
        ? 'Inappropriate minor content'
        : 'Inappropriate real person content';
    const category: PromptTriggerCategory =
      inappropriateResult.type === 'minor' ? 'inappropriate_minor' : 'inappropriate_poi';
    timer.finish(prompt, negativePrompt);
    return {
      blockedFor: [message],
      triggers: [{ category, message, matchedWord: inappropriateResult.matchedWord }],
      success: false,
    };
  }

  // 4. NSFW blocklist check
  const nsfwBlock = timer.time('nsfw_blocklist', () => {
    for (const { word, regex } of blockedNSFWRegexLazy()) {
      if (regex.test(prompt)) return word;
    }
    return undefined;
  });
  if (nsfwBlock != null) {
    timer.finish(prompt, negativePrompt);
    return {
      blockedFor: [nsfwBlock],
      triggers: [{ category: 'nsfw_blocklist', message: nsfwBlock, matchedWord: nsfwBlock }],
      success: false,
    };
  }

  // 5. Profanity check (green domain only)
  if (checkProfanity) {
    const profanityResults = timer.time('profanity', () => {
      const profanityFilter = createProfanityFilter();
      return profanityFilter.analyze(prompt);
    });
    if (profanityResults.isProfane) {
      timer.finish(prompt, negativePrompt);
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

  timer.finish(prompt, negativePrompt);
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
  { age: 4, matches: ['four', 'fore', 'foure', '4'] },
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

// TEST-ONLY. Exposes the POST-teen-expansion `ages` table so the age-path oracle in
// `__tests__/audit-matching-equivalence.test.ts` can replicate `highlightMinor`'s
// `ages.find(x => x.matches.includes(ageText))` age-resolution step EXACTLY (it is
// boundary-invariant — the same lookup for both the live zero-width `ageRegexes` and
// the old consuming-boundary reference — so reusing the live table keeps the oracle
// from drifting). Read-only intent; do NOT mutate or call from production code.
export function __getAgesForTest() {
  return ages;
}

// Build regex patterns for each age separately
const yearsPattern = templateParts.years.join('|');
const oldPattern = templateParts.old.join('|');

// Canonical English number words. These require a trailing `\b` so that compound
// words don't match — e.g. "eight" must not match "eighty" via the {age} {years}
// template (single-letter "y" year unit), and "seven" must not match "seventy".
// Truncated/typo variants (eigt, eigh, sevn, sevem, etc.) intentionally skip the
// boundary so that they still catch ordinal forms via the {age}th birthday
// template ("eigh" + "th" → "eighth birthday").
const canonicalNumberWords = new Set([
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
]);
const buildAgePattern = (matches: string[]) =>
  matches.map((m) => (canonicalNumberWords.has(m) ? `${m}\\b` : m)).join('|');

const perAgeRegexes = ages.map((ageEntry) => {
  const agePattern = buildAgePattern(ageEntry.matches);
  const regexes = templates.map((template) => {
    let regexStr = template;
    regexStr = regexStr.replace('{age}', `(${agePattern})`);
    regexStr = regexStr.replace('{years}', `(${yearsPattern})`);
    regexStr = regexStr.replace('{old}', `(${oldPattern})`);
    // Limit to 0-3 non-alphanumeric chars between parts
    regexStr = regexStr.replace(/\s+/g, `[^a-zA-Z0-9]{0,3}`);
    // Zero-width word boundaries instead of consuming non-alnum runs. Logically
    // equivalent for the boolean match ("preceded/followed by non-alnum or string
    // edge" ≡ "not preceded/followed by an alnum") but, being zero-width, there is
    // nothing for the engine to backtrack over a long non-Latin (CJK) run — this
    // collapses the O(regexes × n²) catastrophic backtracking to linear. See
    // audit-base.ts prepareWordRegex + audit-cjk-redos.test.ts for the incident.
    regexStr = `(?<![a-zA-Z0-9])0*` + regexStr + `(?![a-zA-Z0-9])`;
    return new RegExp(regexStr, 'i');
  });
  return { age: ageEntry.age, regexes };
});

// TEST-ONLY. Reconstructs the per-age regexes EXACTLY as `perAgeRegexes` above but
// with the PRE-#2722 *consuming* boundary groups (`([^a-zA-Z0-9]+|^)0*…([^a-zA-Z0-9]+|$)`)
// instead of the zero-width assertions. It deliberately reuses the SAME in-module
// building blocks (the post-teen-expansion `ages`, `templates`, `buildAgePattern`,
// `yearsPattern`, `oldPattern`) so the equivalence oracle in
// `__tests__/audit-matching-equivalence.test.ts` is a faithful old-vs-new comparison
// that can never drift from the live construction (no copy-pasted data to rot).
// Not used by any runtime path — exported solely so the test can prove the #2722
// boundary refactor preserved age matching. Do NOT call from production code.
export function __buildOldAgeRegexesForTest() {
  return ages.map((ageEntry) => {
    const agePattern = buildAgePattern(ageEntry.matches);
    const regexes = templates.map((template) => {
      let regexStr = template;
      regexStr = regexStr.replace('{age}', `(${agePattern})`);
      regexStr = regexStr.replace('{years}', `(${yearsPattern})`);
      regexStr = regexStr.replace('{old}', `(${oldPattern})`);
      regexStr = regexStr.replace(/\s+/g, `[^a-zA-Z0-9]{0,3}`);
      // Pre-#2722 consuming boundaries (the only intended difference vs perAgeRegexes).
      regexStr = `([^a-zA-Z0-9]+|^)0*` + regexStr + `([^a-zA-Z0-9]+|$)`;
      return new RegExp(regexStr, 'i');
    });
    return { age: ageEntry.age, regexes };
  });
}

// Legacy: Keep ageRegexes for debugAuditPrompt and highlightMinor (which iterate all templates)
// These use the combined pattern for detailed match info
const allAgeMatches = ages.flatMap((x) => x.matches);
const allAgePattern = buildAgePattern(allAgeMatches);
const ageRegexes = templates.map((template) => {
  let regexStr = template;
  regexStr = regexStr.replace('{age}', `(?<age>${allAgePattern})`);
  regexStr = regexStr.replace('{years}', `(?<years>${yearsPattern})`);
  regexStr = regexStr.replace('{old}', `(?<old>${oldPattern})`);
  regexStr = regexStr.replace(/\s+/g, `[^a-zA-Z0-9]{0,3}`);
  // Zero-width boundaries — see the perAgeRegexes note above (same ReDoS fix).
  regexStr = `(?<![a-zA-Z0-9])0*` + regexStr + `(?![a-zA-Z0-9])`;
  return new RegExp(regexStr, 'i');
});

// TEST-ONLY. Reconstructs the COMBINED `ageRegexes` above (the legacy path feeding
// `debugAuditPrompt` / `highlightMinor`) but with the PRE-#2722 *consuming* boundary
// groups (`([^a-zA-Z0-9]+|^)0*…([^a-zA-Z0-9]+|$)`) instead of the zero-width
// assertions. #2723 added an old-vs-new oracle for the PER-AGE path
// (`__buildOldAgeRegexesForTest` / `includesMinorAge`) but NOT for this combined
// `ageRegexes` path, which ALSO got the #2722 boundary change. This sibling export
// closes that gap: it reuses the SAME in-module building blocks (`templates`,
// `allAgePattern`, `yearsPattern`, `oldPattern`, including the named capture groups)
// so the only difference vs the live `ageRegexes` is the boundary form — no
// copy-pasted data that could rot. Not used by any runtime path; exported solely so
// `__tests__/audit-matching-equivalence.test.ts` can prove the #2722 boundary
// refactor preserved the legacy age path. Do NOT call from production code.
export function __buildOldAgeRegexesCombinedForTest() {
  return templates.map((template) => {
    let regexStr = template;
    regexStr = regexStr.replace('{age}', `(?<age>${allAgePattern})`);
    regexStr = regexStr.replace('{years}', `(?<years>${yearsPattern})`);
    regexStr = regexStr.replace('{old}', `(?<old>${oldPattern})`);
    regexStr = regexStr.replace(/\s+/g, `[^a-zA-Z0-9]{0,3}`);
    // Pre-#2722 consuming boundaries (the only intended difference vs ageRegexes).
    regexStr = `([^a-zA-Z0-9]+|^)0*` + regexStr + `([^a-zA-Z0-9]+|$)`;
    return new RegExp(regexStr, 'i');
  });
}

// Danbooru-style tags that embed digits but aren't ages. Without stripping these,
// prompts like `score_9, year 2025` falsely match the `{age} {years}` template
// because the trailing digit in `score_9` sits within 3 non-alphanumeric chars of `year`.
const falsePositiveTagPattern = /\bscore_\d(?:_up|_down)?\b|\bsource_\w+\b|\brating_\w+\b/gi;

// --------------------------------------
// Age Check Function (Two-Phase Approach)
// --------------------------------------
export function includesMinorAge(prompt: string | undefined) {
  if (!prompt) return { found: false, age: undefined };

  const cleaned = prompt.replace(falsePositiveTagPattern, ' ');

  // Phase 1: Quick screening - skip if prompt clearly doesn't contain age references
  // This rejects 99%+ of prompts instantly with a tiny regex
  if (!quickScreenPattern.test(cleaned)) {
    return { found: false, age: undefined };
  }

  // Phase 2: Detailed matching - check each age with smaller per-age patterns
  for (const { age, regexes } of perAgeRegexes) {
    for (const regex of regexes) {
      if (regex.test(cleaned)) {
        return { found: true, age };
      }
    }
  }

  return { found: false, age: undefined };
}

// #endregion

// #region [inappropriate]
// Builds the "body" of a word pattern (everything between the leading/trailing
// zero-width boundary assertions). Extracted so the combined-regex pre-filter
// ("gate") in `checkable` can reuse the EXACT same body inside the EXACT same
// `(?<![a-zA-Z0-9])` / `(?![a-zA-Z0-9])` boundaries that `prepareWordRegex` uses,
// guaranteeing the gate is the literal union of the per-word regexes (superset).
function prepareWordRegexBody(word: string, pluralize = false, leet = true) {
  let regexStr = word;
  regexStr = regexStr.replace(/\s+/g, `[^a-zA-Z0-9]+`);
  if (leet && !word.includes('[')) {
    regexStr = regexStr
      .replace(/i/g, '[i|l|1]')
      .replace(/o/g, '[o|0]')
      .replace(/s/g, '[s|z]')
      .replace(/e/g, '[e|3]');
  }
  if (pluralize) regexStr += '[s|z]*';
  return regexStr;
}

function prepareWordRegex(word: string, pluralize = false, leet = true) {
  const body = prepareWordRegexBody(word, pluralize, leet);
  // Zero-width word boundaries instead of CONSUMING non-alnum runs. The old form
  // `([^a-zA-Z0-9]+|^)…([^a-zA-Z0-9]+|$)` had a greedy `[^a-zA-Z0-9]+` group on each
  // side; run UNANCHORED over a long non-Latin (CJK/Japanese/…) prompt — one giant
  // `[^a-zA-Z0-9]` run — across hundreds of word regexes, the leading group
  // backtracks at every position → O(regexes × n²) → seconds of synchronous CPU
  // (proven 1.6s–84s prod api event-loop pin = user-triggerable DoS / "504 wave").
  // The lookbehind/lookahead are LOGICALLY EQUIVALENT for the boolean match
  // ("preceded/followed by non-alnum or string edge" ≡ "not preceded/followed by an
  // alnum") but, being zero-width, have nothing to backtrack over → linear. The
  // proof is audit-matching-equivalence.test.ts (brute-force oracle, unchanged).
  // NOTE: match[0] no longer includes the boundary char(s); callers run it through
  // trimNonAlphanumeric (now a near-no-op) so the highlight path is unaffected.
  const regexStr = `(?<![a-zA-Z0-9])` + body + `(?![a-zA-Z0-9])`;
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

  // Combined-regex pre-filter ("gate"): one alternation regex per chunk that
  // answers "does ANY word in this chunk match at all?" in a single exec. The
  // dominant case — a prompt that matches nothing in the list — then costs
  // `ceil(N / CHUNK)` exec calls instead of N (originally PR #2452, ~300x on the
  // no-match scan). It was reverted in #2719 because #2452 built the gate with
  // CONSUMING greedy boundaries `([^a-zA-Z0-9]+|^)…([^a-zA-Z0-9]+|$)` that
  // backtracked O(n²) on long non-Latin/CJK prompts (the same ReDoS class #2722
  // fixed on the per-word regexes). This restores the gate, but built with the
  // ZERO-WIDTH boundaries from #2722:
  //
  //   (?<![a-zA-Z0-9])(?:body1|body2|…|bodyN)(?![a-zA-Z0-9])
  //
  // Each `body` is the EXACT per-word body (prepareWordRegexBody) wrapped in a
  // non-capturing group, inside the SAME zero-width boundaries `prepareWordRegex`
  // uses. So the gate is literally the union of the per-word regexes: it matches
  // iff at least one per-word regex matches → a gate MISS guarantees no per-word
  // match (no false negatives, safe to skip). Being zero-width, the boundaries
  // have nothing to backtrack over a long non-alnum run → linear, so the gate
  // CANNOT reintroduce the #2452/#2722 CJK backtrack. On a gate HIT we fall back
  // to the unchanged per-word loop to identify the specific match, so results are
  // byte-for-byte identical to the gateless implementation.
  //
  // Chunking keeps each combined pattern well under JS engine limits (large
  // alternations can blow the compiled-regex size budget) and bounds the cost of
  // any single exec.
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
    for (const gate of gateRegexes) {
      if (gate.test(prompt)) return true;
    }
    return false;
  }

  function preprocessor(prompt: string) {
    prompt = prompt.trim();
    if (options?.preprocessor) return options.preprocessor(prompt);
    return prompt;
  }

  function inPrompt(prompt: string, matcher?: MatcherFn) {
    prompt = preprocessor(prompt);
    // Fast no-match gate: if nothing in any chunk can match, no per-word regex
    // (and no matcher, which only returns a value when `regex.test` is true) can
    // either — short-circuit the O(N) loop.
    if (!gatePasses(prompt)) return false;
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
    // Same gate as inPrompt: highlight rewrites only words that match, so if the
    // gate misses there is nothing to rewrite and we return the prompt unchanged.
    if (!gatePasses(target)) return prompt;
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

// The gap between a young-adjective and a partial-noun. BOUNDED quantifiers
// ({0,200}/{1,200}) instead of the original unbounded `([\s|\w]*|[^\w]+)`: the
// partial nouns end in `\w*` (e.g. `\w*girl+\w*`), so an unbounded gap sat
// adjacent to another unbounded `\w*` over the SAME input run → O(n^2)
// catastrophic backtracking on a long Latin `\w` run (`"young " + "a"*24000`
// took ~2.8s of synchronous main-thread CPU through `words.young.nouns` — a
// user-triggerable DoS of the same class as the #2722 CJK ReDoS, surfaced by the
// #2725 audit). Any FINITE bound collapses this to linear, so a wider bound costs
// nothing perf-wise. Widened 40→200 chars (#2727 M1 recall fix): `girl`/`boy` are
// reachable ONLY via this composed path, and a 40-char (~7 word) window missed
// real spaced "young … girl" phrasings >40 chars on the CSAM/minor-detection path
// — closing that recall gap while staying linear. Verified equal to the old form
// on the equivalence-oracle corpus, whose `youngComposedNouns` reference mirrors
// this exact body.
const composedNouns = youngWords.partialNouns.flatMap((word) => {
  return youngWords.adjectives.map((adj) => adj + '([\\s|\\w]{0,200}|[^\\w]{1,200})' + word);
});
const words = {
  nsfw: checkable(nsfwWords),
  young: {
    nouns: checkable(youngWords.nouns.concat(composedNouns), {
      pluralize: true,
    }),
    negativeNouns: checkable(youngWords.negativeNouns, {
      pluralize: true,
      // "mature content" is a boilerplate NSFW-avoidance tag, not an attempt to
      // steer the subject younger — drop it so its bare "mature" doesn't flag minor.
      preprocessor: (prompt) => prompt.replace(/mature[^a-zA-Z0-9]+content[s|z]*/gi, ' '),
    }),
  },
  poi: checkable(poiWords, {
    leet: false,
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

// TEST-ONLY. Exposes the LIVE combined `ageRegexes` array (zero-width boundaries) so
// the oracle can compute the legacy age-path DETECTION signal (per-template match +
// resolved age) and compare it against the old consuming-boundary reference built by
// `__buildOldAgeRegexesCombinedForTest`. Read-only; do NOT mutate or call from
// production code.
export function __getAgeRegexesForTest() {
  return ageRegexes;
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
