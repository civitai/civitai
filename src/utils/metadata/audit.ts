import type { ImageMetaProps } from '~/server/schema/image.schema';
import { normalizeText } from '~/utils/normalize-text';
import { trimNonAlphanumeric } from '~/utils/string-helpers';
import {
  blockedNSFW,
  nsfwPromptWords,
  nsfwWordsSoft,
  nsfwWordsPaddle,
  poiWords,
  youngWords,
  harmfulCombinations,
  blockedNSFWOverridable,
  promptTags,
  youngComposedNouns,
} from '@civitai/mod-utils/prompt-audit/lists';
import { prepareWordRegex, prepareWordRegexBody } from '@civitai/mod-utils/prompt-audit/word-regex';
import {
  ages,
  canonicalNumberWords,
  templateParts,
  templates,
} from '@civitai/mod-utils/prompt-audit/lists/ages';
import { blockedNSFWRegexLazy, blockedRegexLazy } from '~/utils/metadata/audit-base';
import { createProfanityFilter } from '~/libs/profanity-simple';
import { AuditTimer, type AuditTimerOptions } from '~/utils/metadata/audit-slow-log';

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
  | 'external'
  // Input longer than MAX_AUDIT_PROMPT_LENGTH: refused unscanned. Hard — never add it to
  // SOFT_BLOCK_CATEGORIES, or a click-through would skip the regex layer for long prompts.
  | 'over_length';

export type PromptTriggerField = 'prompt' | 'negativePrompt';

/** What one rule matched. Every field past `category` is absent when the rule cannot supply it. */
export interface PromptTriggerMatch {
  category: PromptTriggerCategory;
  matchedWord?: string;
  /** Source of the regex that matched, for the rules that match by regex. */
  matchedRegex?: string;
  /** The literal span found in the audited text, when the match gives one. */
  matchedText?: string;
  matchedField?: PromptTriggerField;
  /** The NSFW-list text that opened the gate a rule needs before it runs. */
  gateWord?: string;
}

export interface PromptTrigger extends Omit<PromptTriggerMatch, 'category'> {
  category: PromptTriggerCategory;
  message: string;
  /** Every rule that matched, the first being this trigger's own fields. Set on the first trigger of a block only; old rows lack it. */
  matches?: PromptTriggerMatch[];
}

/**
 * Categories a user may click through with a warning ("I know what I'm doing").
 * Everything not listed here is a hard block and has no override path.
 *
 * Do NOT add anything minor- or real-person-related. `minor_age` is the near
 * miss: it fires on innocent text ("an 8 year old oak tree") but also on
 * suggestive-minor prompts carrying no explicit term, which `inappropriate_minor`
 * cannot catch because it requires an NSFW word.
 *
 * Do NOT add `external`. Its trigger message is whatever a deployment configured
 * — `extModeration.moderatePrompt` relabels provider categories through the
 * `EXTERNAL_MODERATION_CATEGORIES` env var — so severity would hinge on an env
 * string no invariant covers.
 */
const SOFT_BLOCK_CATEGORIES = new Set<PromptTriggerCategory>(['nsfw_blocklist', 'profanity']);

/**
 * `nsfw_blocklist` is NOT one severity — the same flat list holds `rape` and
 * `daughter`. Severity is per matched WORD and defaults to hard, so adding a term
 * to the main blocklist can never accidentally make it overridable.
 *
 * Distinct from `nsfwWordsSoft` above, which is mild-NSFW *matching* vocabulary.
 * This file changes nothing about what matches.
 */
const overridableNsfwWords = new Set(blockedNSFWOverridable);

function isSoftBlockTrigger(trigger: PromptTrigger) {
  if (!SOFT_BLOCK_CATEGORIES.has(trigger.category)) return false;
  if (trigger.category === 'nsfw_blocklist') {
    return trigger.matchedWord != null && overridableNsfwWords.has(trigger.matchedWord);
  }
  return true;
}

/** A block is soft only when EVERY trigger is soft — one hard trigger poisons the set. */
export function isSoftBlock(triggers: PromptTrigger[]) {
  return triggers.length > 0 && triggers.every(isSoftBlockTrigger);
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
// User-facing: reaches the generation error toast as "Your prompt was flagged: <this>".
// Names the limit so someone who pasted a long prompt knows what to fix.
const OVER_LENGTH_MESSAGE = `Prompt exceeds the maximum allowed length (${MAX_AUDIT_PROMPT_LENGTH.toLocaleString(
  'en-US'
)} characters)`;

/**
 * True when the block is the over-length size refusal and nothing else. That refusal is about the
 * input's SIZE, not its content — it returns before any detector runs — so the recording path
 * treats it as a size refusal rather than as evidence of a prohibited prompt.
 */
export function isOverLengthRefusal(triggers: PromptTrigger[]) {
  return triggers.length > 0 && triggers.every((t) => t.category === 'over_length');
}

/**
 * True when there is nothing to audit: the prompt AND the negative prompt are both blank.
 *
 * This is the one predicate for the empty-input fast path — `auditPromptEnriched`,
 * `classifyPromptServer` and `auditPromptServer` all skip on it. Keying the fast path on the prompt
 * alone left a non-empty negative prompt unaudited whenever the prompt was empty.
 */
export function isBlankAuditInput(prompt?: string | null, negativePrompt?: string | null) {
  return !prompt?.trim() && !negativePrompt?.trim();
}

/**
 * Enriched version of auditPrompt that returns structured trigger data alongside blockedFor.
 * Used server-side for UserBan records, moderator UI, and the false-positive allowlist system.
 *
 * An empty prompt does not skip the audit when the negative prompt is non-empty: the negative
 * prompt then gets every check it gets beside a non-empty prompt, including the length cap.
 *
 * `options.privateInput` keeps the text out of the slow-audit log line (see audit-slow-log.ts); the
 * result is the same either way.
 */
export const auditPromptEnriched = (
  prompt: string,
  negativePrompt?: string,
  checkProfanity?: boolean,
  options?: AuditTimerOptions
): EnrichedAuditResult => {
  const result = auditFirstBlock(prompt, negativePrompt, checkProfanity, options);
  // Evidence is collected only for a block, not on the passing path.
  const [first] = result.triggers;
  if (
    !result.success &&
    first &&
    first.category !== 'over_length' &&
    first.category !== 'profanity'
  ) {
    const matches = collectTriggerMatches(prompt, negativePrompt, first);
    if (matches.length > 0) first.matches = matches;
  }
  return result;
};

const auditFirstBlock = (
  prompt: string,
  negativePrompt?: string,
  checkProfanity?: boolean,
  options?: AuditTimerOptions
): EnrichedAuditResult => {
  if (isBlankAuditInput(prompt, negativePrompt))
    return { blockedFor: [], triggers: [], success: true };
  // Block over-length input outright (#2727 M2). Truncating then scanning would let
  // a banned word buried past MAX_AUDIT_PROMPT_LENGTH evade the regex layer; a
  // prompt this long is anomalous so we refuse it rather than scan a truncated copy.
  //
  // 🔴 The refusal carries a trigger. A trigger-less refusal once fell through to the
  // external classifier alone, because the server audit raised a regex block only when
  // `triggers.length > 0` — so over-length input skipped the regex layer entirely.
  // `classifyPromptServer` now refuses any `success: false` (hard when trigger-less), but the
  // trigger is still what names the refusal for the recording path (`isOverLengthRefusal`).
  // `over_length` is a hard category (not in SOFT_BLOCK_CATEGORIES), so it can never be
  // clicked through.
  if (
    prompt.length > MAX_AUDIT_PROMPT_LENGTH ||
    (negativePrompt != null && negativePrompt.length > MAX_AUDIT_PROMPT_LENGTH)
  ) {
    return {
      blockedFor: [OVER_LENGTH_MESSAGE],
      triggers: [{ category: 'over_length', message: OVER_LENGTH_MESSAGE }],
      success: false,
    };
  }

  // Per-sub-check timing instrumentation. Always-on but threshold-gated: below
  // AUDIT_SLOW_LOG_MS it costs only a handful of `performance.now()` deltas and
  // emits nothing. On the pathological 11-47s CPU-pin (the "504 wave" DoS) it logs
  // ONE structured line naming the slowest sub-check + an input fingerprint. The
  // timer NEVER alters the audit result and `finish()` can never throw — it is
  // called on every return path below with the (normalized) prompts. The raw text
  // passed to finish() is what was audited; logging it is privacy-gated (see
  // audit-slow-log.ts). See that module's header for the full incident writeup.
  const timer = new AuditTimer(options);

  prompt = timer.time('normalize', () => normalizeText(prompt));
  negativePrompt = timer.time('normalize', () => normalizeText(negativePrompt));

  // 1. Minor age check
  const ageCheck = timer.time('minor_age', () => findMinorAge(prompt));
  const { found, age } = ageCheck;
  if (found && age != null) {
    const message = `${age} year old`;
    timer.finish(prompt, negativePrompt);
    return {
      blockedFor: [message],
      triggers: [
        compact({
          category: 'minor_age' as const,
          message,
          matchedWord: String(age),
          matchedRegex: ageCheck.regex,
          matchedText: ageCheck.matchedText,
          matchedField: 'prompt' as const,
        }),
      ],
      success: false,
    };
  }

  // 2. POI check
  const poiMatch = timer.time('poi', () => findPoi(prompt));
  if (poiMatch) {
    const message = 'Prompt cannot include celebrity names';
    timer.finish(prompt, negativePrompt);
    return {
      blockedFor: [message],
      triggers: [
        compact({
          category: 'poi' as const,
          message,
          matchedWord: poiMatch.word,
          matchedRegex: poiMatch.regex,
          matchedText: poiMatch.matchedText,
          matchedField: 'prompt' as const,
        }),
      ],
      success: false,
    };
  }
  const negPoiMatch = timer.time('poi', () => findPoi(negativePrompt));
  if (negPoiMatch) {
    const message = 'Negative prompt cannot include celebrity names';
    timer.finish(prompt, negativePrompt);
    return {
      blockedFor: [message],
      triggers: [
        compact({
          category: 'poi' as const,
          message,
          matchedWord: negPoiMatch.word,
          matchedRegex: negPoiMatch.regex,
          matchedText: negPoiMatch.matchedText,
          matchedField: 'negativePrompt' as const,
        }),
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
      triggers: [
        compact({
          category,
          message,
          matchedWord: inappropriateResult.matchedWord,
          matchedRegex: inappropriateResult.regex,
          matchedText: inappropriateResult.matchedText,
          matchedField: inappropriateResult.field,
          gateWord: inappropriateResult.gateWord,
        }),
      ],
      success: false,
    };
  }

  // 4. NSFW blocklist check
  // A HARD term anywhere in the prompt wins over a soft term that happens to sit
  // earlier in the list. Returning the first match outright would let any soft
  // word act as a universal override key: `daughter` is entry 23 of 191, so
  // "daughter, <any hard term below it>" would report the soft `daughter` and
  // offer a click-through. Only a prompt whose every blocklist match is soft may
  // be soft. Cost is bounded — the full scan already runs on every clean prompt,
  // and a hard match still exits immediately.
  const nsfwBlock = timer.time('nsfw_blocklist', () => {
    let softMatch: { word: string; regex: RegExp } | undefined;
    for (const entry of blockedNSFWRegexLazy()) {
      if (!entry.regex.test(prompt)) continue;
      if (!overridableNsfwWords.has(entry.word)) return entry;
      softMatch ??= entry;
    }
    return softMatch;
  });
  if (nsfwBlock != null) {
    timer.finish(prompt, negativePrompt);
    return {
      blockedFor: [nsfwBlock.word],
      triggers: [
        {
          category: 'nsfw_blocklist',
          message: nsfwBlock.word,
          matchedWord: nsfwBlock.word,
          matchedRegex: nsfwBlock.regex.source,
          matchedField: 'prompt',
        },
      ],
      success: false,
    };
  }

  // 5. Profanity check (green domain only)
  if (checkProfanity) {
    const profanityResults = timer.time('profanity', () => {
      const profanityFilter = createProfanityFilter();
      // Strip Danbooru rating/score/source tags first, for the same reason
      // `includesMinorAge` does: they are metadata, not language. `rating_explicit` is
      // how a booru labels an image, and obscenity matches inside it — so the tag alone
      // refused prompts whose images the SFW domain publishes.
      return profanityFilter.analyze(prompt.replace(falsePositiveTagPattern, ' '));
    });
    if (profanityResults.isProfane) {
      timer.finish(prompt, negativePrompt);
      // Report the word the input carried, not the dataset word it matched: obscenity matches
      // substrings, so a `fagus` tag would otherwise be blocked "for" `fag`.
      const offendingWords = profanityResults.matchedWords.length
        ? profanityResults.matchedWords
        : profanityResults.matches;
      return {
        blockedFor: offendingWords,
        triggers: offendingWords.map((word: string) => ({
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

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/**
 * Every rule that matches a prompt the audit has already blocked, in the order the audit applies
 * them, so entry 0 is the rule that decided the verdict. Evidence only: it never changes one.
 */
function collectTriggerMatches(
  rawPrompt: string,
  rawNegativePrompt: string | undefined,
  decided: PromptTrigger
): PromptTriggerMatch[] {
  const prompt = normalizeText(rawPrompt);
  const negativePrompt = normalizeText(rawNegativePrompt);
  const matches: PromptTriggerMatch[] = [];

  const age = findMinorAge(prompt);
  if (age.found && age.age != null) {
    matches.push(
      compact({
        category: 'minor_age' as const,
        matchedWord: String(age.age),
        matchedRegex: age.regex,
        matchedText: age.matchedText,
        matchedField: 'prompt' as const,
      })
    );
  }

  for (const [text, field] of [
    [prompt, 'prompt'],
    [negativePrompt, 'negativePrompt'],
  ] as const) {
    const poi = findPoi(text);
    if (poi) {
      matches.push(
        compact({
          category: 'poi' as const,
          matchedWord: poi.word,
          matchedRegex: poi.regex,
          matchedText: poi.matchedText,
          matchedField: field,
        })
      );
    }
  }

  for (const hit of findInappropriateEnriched({ prompt, negativePrompt }, undefined, true)) {
    matches.push(
      compact({
        category:
          hit.type === 'minor' ? ('inappropriate_minor' as const) : ('inappropriate_poi' as const),
        matchedWord: hit.matchedWord,
        matchedRegex: hit.regex,
        matchedText: hit.matchedText,
        matchedField: hit.field,
        gateWord: hit.gateWord,
      })
    );
  }

  for (const { word, regex } of blockedNSFWRegexLazy()) {
    if (!regex.test(prompt)) continue;
    matches.push({
      category: 'nsfw_blocklist',
      matchedWord: word,
      matchedRegex: regex.source,
      matchedField: 'prompt',
    });
  }

  // Scan order can differ from verdict order, so move the deciding rule to the front.
  const decidingIndex = matches.findIndex(
    (m) => m.category === decided.category && m.matchedWord === decided.matchedWord
  );
  if (decidingIndex > 0) matches.unshift(...matches.splice(decidingIndex, 1));

  return matches;
}
// #endregion [enriched audit]

export const auditPrompt = (
  prompt: string,
  negativePrompt?: string,
  checkProfanity?: boolean,
  options?: AuditTimerOptions
): { blockedFor: string[]; success: boolean } => {
  const { blockedFor, success } = auditPromptEnriched(
    prompt,
    negativePrompt,
    checkProfanity,
    options
  );
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
// Prepare Regexes - Two Phase Approach
// --------------------------------------
// Phase 1: Quick screening pattern - rejects most prompts instantly
const quickScreenPattern =
  /(?:age[ds]?|year|old|birthday|anos|\b(?:1[0-7]|[1-9])\b|teen|eleven|twelve|one|two|three|four|five|six|seven|eight|nine|ten)/i;

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

// The trailing `\b` goes on canonical spellings only; `canonicalNumberWords` in
// `lists/ages.ts` carries why the typo variants must not get one.
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

// Prompt attention-weight syntax embeds a decimal that isn't an age. Without stripping it,
// `(@ningen mame:0.8), year` falsely matches the `{age} {years}` template because the `8`
// from the `0.8` weight sits within 3 non-alphanumeric chars of `year`. Only the decimal
// weight (a `:x.y` immediately preceding a closing `)`/`]`) is removed, so a real age inside
// a weighted group — e.g. `(8 year old:1.2)` — and integer forms like `age:8` are preserved.
const promptWeightPattern = /:\s*\d+\.\d+(?=\s*[)\]])/g;

// --------------------------------------
// Age Check Function (Two-Phase Approach)
// --------------------------------------
export function includesMinorAge(prompt: string | undefined) {
  const { found, age } = findMinorAge(prompt);
  return { found, age };
}

/** `includesMinorAge` plus the span and regex that matched. */
function findMinorAge(prompt: string | undefined): {
  found: boolean;
  age: number | undefined;
  matchedText?: string;
  regex?: string;
} {
  if (!prompt) return { found: false, age: undefined };

  const cleaned = prompt.replace(falsePositiveTagPattern, ' ').replace(promptWeightPattern, '');

  // Phase 1: Quick screening - skip if prompt clearly doesn't contain age references
  // This rejects 99%+ of prompts instantly with a tiny regex
  if (!quickScreenPattern.test(cleaned)) {
    return { found: false, age: undefined };
  }

  // Phase 2: Detailed matching - check each age with smaller per-age patterns
  for (const { age, regexes } of perAgeRegexes) {
    for (const regex of regexes) {
      const match = regex.exec(cleaned);
      if (match) {
        return { found: true, age, matchedText: match[0], regex: regex.source };
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
// The builder is shared with audit-base.ts and the mod-utils prompt-audit copy; the
// ReDoS rationale for the zero-width boundaries lives with it. The proof that the
// boundaries are equivalent to the old consuming form is
// audit-matching-equivalence.test.ts (brute-force oracle, deliberately independent).
// NOTE: match[0] does not include the boundary char(s); callers run it through
// trimNonAlphanumeric (a near-no-op) so the highlight path is unaffected.

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

const words = {
  nsfw: checkable(nsfwWords),
  young: {
    nouns: checkable(youngWords.nouns.concat(youngComposedNouns), {
      pluralize: true,
    }),
    negativeNouns: checkable(youngWords.negativeNouns, {
      pluralize: true,
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
): { type: 'minor' | 'poi'; matchedText: string; regex: string } | false {
  if (!prompt) return false;

  const normalizedPrompt = normalizeText(prompt);

  for (const combination of harmfulCombinations) {
    const match = combination.pattern.exec(normalizedPrompt);
    if (match) {
      return { type: combination.type, matchedText: match[0], regex: combination.pattern.source };
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

  // 🔴 This makes the nsfw word list load-bearing for more than nsfw: the POI and minor checks
  // below run only if it matches (callers that pass no `nsfw` argument — every search gate —
  // depend entirely on it). So anything that can suppress a term on that list turns off two
  // other checks for that input, not just its own.
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

type InappropriateMatch = {
  type: 'minor' | 'poi';
  matchedWord?: string;
  regex?: string;
  pattern?: string;
  matchedText?: string;
  field: PromptTriggerField;
  gateWord?: string;
};

type CheckableHit = string | { matchedText: string; pattern: string; regex: string };

function describeHit(hit: CheckableHit) {
  return typeof hit === 'object'
    ? { matchedWord: hit.matchedText, regex: hit.regex, pattern: hit.pattern }
    : { matchedWord: hit };
}

/** `includesPoi` plus the regex and span that matched. */
function findPoi(prompt: string | undefined) {
  if (!prompt) return false;
  let found = undefined as { word: string; regex: string; matchedText?: string } | undefined;
  const matcher = (text: string, checkable: Checkable) => {
    if (inPromptEdit(text, checkable)) return false;
    const match = checkable.regex.exec(text);
    if (!match) return false;
    found = { word: checkable.word, regex: checkable.regex.source, matchedText: match[0] };
    return checkable.word;
  };
  return words.poi.inPrompt(prompt, matcher) ? found ?? false : false;
}

/** Every sub-check that matches, in audit order; `collectAll` false stops at the first hit. */
function findInappropriateEnriched(
  input: { prompt?: string; negativePrompt?: string },
  nsfw: boolean | undefined,
  collectAll: boolean
): InappropriateMatch[] {
  const hits: InappropriateMatch[] = [];
  if (!input.prompt) return hits;
  input.prompt = input.prompt.replace(/'|\.|\-/g, '');
  const done = () => !collectAll;

  // Harmful combinations (with matched text capture)
  const harmfulCombo = includesHarmfulCombinationsEnriched(input.prompt);
  if (harmfulCombo) {
    hits.push({
      type: harmfulCombo.type,
      matchedWord: harmfulCombo.matchedText,
      matchedText: harmfulCombo.matchedText,
      regex: harmfulCombo.regex,
      field: 'prompt',
    });
    if (done()) return hits;
  }

  // Same gate as in `includesInappropriate` above, and the same consequence: the nsfw word
  // list decides whether the POI and minor checks below run at all.
  let gateWord: string | undefined;
  if (!nsfw) {
    const gate = words.nsfw.inPrompt(input.prompt);
    if (!gate) return hits;
    gateWord = typeof gate === 'object' ? gate.matchedText : gate;
  }

  // Negative prompt harmful combinations
  if (input.negativePrompt) {
    const negativeHarmfulCombo = includesHarmfulCombinationsEnriched(input.negativePrompt);
    if (negativeHarmfulCombo) {
      hits.push({
        type: negativeHarmfulCombo.type,
        matchedWord: negativeHarmfulCombo.matchedText,
        matchedText: negativeHarmfulCombo.matchedText,
        regex: negativeHarmfulCombo.regex,
        field: 'negativePrompt',
        gateWord,
      });
      if (done()) return hits;
    }
  }

  const poi = findPoi(input.prompt);
  if (poi) {
    hits.push({
      type: 'poi',
      matchedWord: poi.word,
      matchedText: poi.matchedText,
      regex: poi.regex,
      field: 'prompt',
      gateWord,
    });
    if (done()) return hits;
  }

  // Minor — check each sub-check individually to capture the matched word
  const ageCheck = findMinorAge(input.prompt);
  if (ageCheck.found && ageCheck.age != null) {
    hits.push({
      type: 'minor',
      matchedWord: `${ageCheck.age} year old`,
      matchedText: ageCheck.matchedText,
      regex: ageCheck.regex,
      field: 'prompt',
      gateWord,
    });
    if (done()) return hits;
  }

  const youngNoun = words.young.nouns.inPrompt(input.prompt);
  if (youngNoun) {
    hits.push({
      type: 'minor',
      ...describeHit(youngNoun),
      matchedText: typeof youngNoun === 'object' ? youngNoun.matchedText : undefined,
      field: 'prompt',
      gateWord,
    });
    if (done()) return hits;
  }

  if (input.negativePrompt) {
    const negYoung = words.young.negativeNouns.inPrompt(input.negativePrompt);
    if (negYoung) {
      hits.push({
        type: 'minor',
        ...describeHit(negYoung),
        matchedText: typeof negYoung === 'object' ? negYoung.matchedText : undefined,
        field: 'negativePrompt',
        gateWord,
      });
    }
  }

  return hits;
}

function includesInappropriateEnriched(
  input: { prompt?: string; negativePrompt?: string },
  nsfw?: boolean
): InappropriateMatch | false {
  return findInappropriateEnriched(input, nsfw, false)[0] ?? false;
}

// #endregion [inappropriate]

// #region [highlight]
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
