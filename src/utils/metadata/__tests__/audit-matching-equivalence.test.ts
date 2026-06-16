import { describe, it, expect } from 'vitest';
import {
  includesNsfw,
  includesPoi,
  getTagsFromPrompt,
  includesMinor,
  includesMinorAge,
  checkable,
} from '~/utils/metadata/audit';
import { trimNonAlphanumeric } from '~/utils/string-helpers';
import poiWords from '~/utils/metadata/lists/words-poi.json';
import nsfwPromptWords from '~/utils/metadata/lists/words-nsfw-prompt.json';
import nsfwWordsSoft from '~/utils/metadata/lists/words-nsfw-soft.json';
import nsfwWordsPaddle from '~/utils/metadata/lists/words-paddle-nsfw.json';
import promptTags from '~/utils/metadata/lists/prompt-tags.json';
import youngWords from '~/utils/metadata/lists/words-young.json';

/**
 * Equivalence guard for the combined-regex pre-filter ("gate") added to
 * `checkable().inPrompt` in audit.ts.
 *
 * The gate must NEVER change the matching result — only the speed of reaching
 * it. These tests reconstruct the original brute-force per-word matching loop
 * as a reference oracle and assert the public audit API agrees with it across a
 * broad sample of prompts (every real list entry as a positive case + benign /
 * adversarial negatives). A single divergence here means the optimization
 * changed moderation behavior.
 */

// --- Reference (pre-optimization) per-word matching, copied verbatim ---
function refPrepareWordRegex(word: string, pluralize = false, leet = true) {
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
  regexStr = `([^a-zA-Z0-9]+|^)` + regexStr + `([^a-zA-Z0-9]+|$)`;
  return new RegExp(regexStr, 'i');
}

const nsfwWords = [...new Set([...nsfwPromptWords, ...nsfwWordsSoft, ...nsfwWordsPaddle])];
const nsfwRefRegexes = nsfwWords.map((w) => refPrepareWordRegex(w));
const poiRefRegexes = (poiWords as string[]).map((w) => ({
  word: w,
  regex: refPrepareWordRegex(w, false, false),
}));
const poiPreprocess = (s: string) => s.trim().replace(/[^\w\s\|\:\[\],]/g, '');

// Reference includesNsfw: true if any nsfw word matches
function refIncludesNsfw(prompt: string): boolean {
  const s = prompt.trim();
  return nsfwRefRegexes.some((r) => r.test(s));
}

// Reference includesPoi (default, includeEdit=false path) mirrors the matcher:
// returns the FIRST word whose regex matches and which isn't an edit-wrapped match.
function refInPromptEdit(prompt: string, regex: RegExp): boolean {
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
function refIncludesPoi(prompt: string): string | false {
  const s = poiPreprocess(prompt);
  for (const { word, regex } of poiRefRegexes) {
    if (refInPromptEdit(s, regex)) continue;
    if (regex.test(s)) return word;
  }
  return false;
}

// Reference getTagsFromPrompt
const tagRefGroups = Object.entries(promptTags as Record<string, string[]>).map(([tag, words]) => ({
  tag,
  regexes: words.map((w) => refPrepareWordRegex(w)),
}));
function refGetTags(prompt: string): string[] {
  const s = prompt.trim();
  const tags = new Set<string>();
  for (const group of tagRefGroups) {
    if (group.regexes.some((r) => r.test(s))) tags.add(group.tag);
  }
  return [...tags];
}

// --- Reference (pre-optimization) young.nouns matching ---
// Mirrors audit.ts: words.young.nouns = checkable(youngWords.nouns.concat(composedNouns),
// { pluralize: true }). leet defaults to true. The composed nouns interleave every
// adjective with every partialNoun via the body `adj·([\s|\w]*|[^\w]+)·noun` — the
// highest-risk class for alternation interaction inside the gate.
const youngComposedNouns = youngWords.partialNouns.flatMap((word) =>
  youngWords.adjectives.map((adj) => adj + '([\\s|\\w]*|[^\\w]+)' + word)
);
const youngNounList = youngWords.nouns.concat(youngComposedNouns);
const youngNounRefRegexes = youngNounList.map((w) => refPrepareWordRegex(w, true, true));

// Per-word brute-force: does ANY young-noun regex match? (gate-free reference)
function refYoungNounMatches(prompt: string): boolean {
  const s = prompt.trim();
  return youngNounRefRegexes.some((r) => r.test(s));
}

// Mirrors includesMinor's composition exactly: age OR young-noun. The age sub-check
// is not under test here (it has no gate), so we reuse the real includesMinorAge as
// an oracle helper and isolate the gated young.nouns path.
function refIncludesMinor(prompt: string): boolean {
  return includesMinorAge(prompt).found || refYoungNounMatches(prompt);
}

// --- Reference (pre-optimization) highlight() for a single checkable ---
// Copies the un-gated highlight loop from checkable() in audit.ts. Used to confirm
// the gate short-circuit in highlight() never changes the rewritten output.
function refHighlight(
  prompt: string,
  refRegexes: RegExp[],
  preprocess: (s: string) => string,
  replaceFn: (word: string) => string
): string {
  const target = preprocess(prompt.trim());
  for (const regex of refRegexes) {
    if (regex.test(target)) {
      const match = regex.exec(target);
      const word = trimNonAlphanumeric(match?.[0]);
      if (!word) continue;
      if (typeof match?.index === 'undefined') continue;
      // Mirror highlightReplacement(target, match, replaceFn) EXACTLY: each matching
      // regex rebuilds from the original `target`, reassigning `prompt` fresh — the
      // last matching word wins, output is single-wrapped. (Chaining off the
      // progressively-rewritten `prompt` would double-wrap; that's not what audit does.)
      prompt =
        target.substring(0, match.index) +
        target.substring(match.index).replace(word, replaceFn(word));
    }
  }
  return prompt;
}

// Deterministic PRNG (mulberry32) — fixed seed keeps the random-string batch stable
// across runs while still exercising alternation backtracking. Avoids Math.random().
function makeRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Build a batch of random strings from an alphabet that biases toward the
// characters that drive young-noun matches (letters, digits, separators, brackets,
// leet substitutes) so the random batch actually probes the alternation engine.
function buildRandomStrings(count: number): string[] {
  const rng = makeRng(0x9e3779b9);
  const alphabet =
    'abcdefghijklmnopqrstuvwxyz0123456789 _-[]|:,.+girlboysonchild teenkidlolishota01345';
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const len = 4 + Math.floor(rng() * 28);
    let s = '';
    for (let j = 0; j < len; j++) s += alphabet[Math.floor(rng() * alphabet.length)];
    out.push(s);
  }
  return out;
}

// --- Build a broad corpus of test prompts ---
function buildCorpus(): string[] {
  const prompts: string[] = [];
  // Every POI name embedded in a realistic prompt (positive cases)
  for (const n of poiWords as string[])
    prompts.push(`a detailed portrait of ${n}, 8k, masterpiece`);
  // Every nsfw word
  for (const w of nsfwWords) prompts.push(`a scene featuring ${w}, cinematic lighting`);
  // Every tag word
  for (const [, words] of Object.entries(promptTags as Record<string, string[]>))
    for (const w of words) prompts.push(`${w} in the frame`);
  // Benign / adversarial negatives
  prompts.push(
    '',
    '   ',
    'a beautiful landscape, masterpiece, best quality',
    'cyberpunk city, neon lights, rain',
    'score_9, score_8_up, source_pony, rating_safe, year 2025',
    'alpacino', // substring of "al pacino" but no boundary — must NOT match
    'a red car on a road',
    'donald j. trump giving a speech', // entry with a literal dot
    'mountains rivers forests',
    '[al pacino|brad pitt] morphing' // edit-wrapped POI — matcher should skip
  );
  return prompts;
}

const corpus = buildCorpus();

// --- Young-noun specific corpus ---
// Adversarial embeddings designed to exercise the composed-regex bodies
// (adj·([\s|\w]*|[^\w]+)·noun) and the pluralize/leet substitutions: punctuation,
// extra spacing, leet digits adjacent to letters, and brackets. Each entry pairs a
// realistic prompt frame with a positive young-noun trigger.
function buildYoungCorpus(): string[] {
  const prompts: string[] = [];

  // Every plain young noun, in a benign frame.
  for (const w of youngWords.nouns) prompts.push(`a portrait of a ${w}, studio lighting`);

  // Every composed adjective+partialNoun pairing, both directly adjacent and with a
  // word/space between them (the `([\s|\w]*|[^\w]+)` body should accept both).
  for (const noun of youngWords.partialNouns) {
    // strip regex meta from partialNoun to make a concrete probe string
    const concreteNoun = noun.replace(/\\w\*/g, '').replace(/\+/g, '').replace(/\\/g, '') || 'girl';
    for (const adj of youngWords.adjectives) {
      const concreteAdj = adj
        .replace(/\+/g, '')
        .replace(/\\w\*/g, '')
        .replace(/\?/g, '')
        .replace(/\[.*?\]/g, '')
        .replace(/o\+/g, 'o');
      prompts.push(`${concreteAdj} ${concreteNoun}, masterpiece`);
      prompts.push(`${concreteAdj}${concreteNoun} in frame`);
      prompts.push(`${concreteAdj} looking ${concreteNoun}`);
    }
  }

  // Adversarial: punctuation / leet / spacing variants around concrete triggers.
  prompts.push(
    'young   girl',
    'young-girl',
    'young.girl',
    'young_girl',
    'y0ung girl', // leet o->0
    'l1ttle boy', // leet i->1
    'sm4ll child', // non-leet digit (4 not a leet substitute) — must NOT spuriously match
    'a t0ddler', // leet o in toddler
    'ch1ld portrait',
    'kid',
    'kiddo running',
    '[young|old] girl morphing',
    'teenager at school',
    'pre teen',
    'kindergarten classroom',
    'newborn baby',
    'photo of a youngster',
    // Negatives that look adjacent but lack a boundary / are unrelated
    'youngish vineyard', // "young" inside a larger word w/ boundary semantics
    'a girlfriend on the beach', // contains "girl" via \w*girl+\w* partialNoun
    'cowboy hat', // contains "boy" via \w*bo+y+\w* partialNoun
    'a mature adult woman',
    'a red car on a road',
    ''
  );

  // POI words too (highlight test exercises poi.highlight as well).
  for (const n of (poiWords as string[]).slice(0, 50))
    prompts.push(`a portrait of ${n}, cinematic`);

  return prompts;
}

const youngCorpus = buildYoungCorpus();
const randomBatch = buildRandomStrings(4000);

// Gated checkables built with the EXACT same word lists + options as audit.ts's
// `words.young.nouns` and `words.poi`. `checkable(...).highlight` is the gated
// function under test; `refHighlight` over the matching per-word regexes is the
// pre-gate reference loop. Comparing the two isolates the gate short-circuit in
// highlight() without reconstructing the full highlightInappropriate pipeline.
const youngNounsCheckable = checkable(youngNounList, { pluralize: true });
const poiCheckable = checkable(poiWords as string[], {
  leet: false,
  preprocessor: (word) => word.replace(/[^\w\s\|\:\[\],]/g, ''),
});
const identityPreprocess = (s: string) => s;
const highlightFn = (word: string) => `<<${word}>>`;

describe('audit matching equivalence (gate vs brute-force)', () => {
  it('includesNsfw matches the reference for every prompt', () => {
    for (const p of corpus) {
      expect(Boolean(includesNsfw(p)), `includesNsfw mismatch for: ${JSON.stringify(p)}`).toBe(
        refIncludesNsfw(p)
      );
    }
  });

  // Brute-force POI equivalence over the full corpus is CPU-bound (the POI
  // reference set is large); it correctly asserts but can exceed the 10s global
  // testTimeout on a loaded CI runner. Give it room — logic is unchanged.
  it(
    'includesPoi returns the same matched name as the reference',
    () => {
      for (const p of corpus) {
        expect(includesPoi(p), `includesPoi mismatch for: ${JSON.stringify(p)}`).toEqual(
          refIncludesPoi(p)
        );
      }
    },
    60000
  );

  it('getTagsFromPrompt returns the same tag set as the reference', () => {
    for (const p of corpus) {
      const got = getTagsFromPrompt(p);
      const expected = !p ? false : refGetTags(p);
      if (expected === false) {
        expect(got, `getTagsFromPrompt mismatch for: ${JSON.stringify(p)}`).toBe(false);
      } else {
        expect(
          [...(got as string[])].sort(),
          `getTagsFromPrompt mismatch for: ${JSON.stringify(p)}`
        ).toEqual([...expected].sort());
      }
    }
  });

  it('young.nouns: includesMinor matches the brute-force reference (composed nouns + adversarial)', () => {
    for (const p of youngCorpus) {
      expect(Boolean(includesMinor(p)), `includesMinor mismatch for: ${JSON.stringify(p)}`).toBe(
        refIncludesMinor(p)
      );
    }
  });

  it('young.nouns: includesMinor matches the reference across a deterministic random batch', () => {
    for (const p of randomBatch) {
      expect(
        Boolean(includesMinor(p)),
        `includesMinor random-batch mismatch for: ${JSON.stringify(p)}`
      ).toBe(refIncludesMinor(p));
    }
  });

  it('highlight: young.nouns gated highlight equals the un-gated reference', () => {
    for (const p of [...youngCorpus, ...randomBatch.slice(0, 1000)]) {
      const gated = youngNounsCheckable.highlight(p, highlightFn);
      const reference = refHighlight(p, youngNounRefRegexes, identityPreprocess, highlightFn);
      expect(gated, `young.nouns highlight mismatch for: ${JSON.stringify(p)}`).toBe(reference);
    }
  });

  // Same CPU-bound POI brute-force shape as above — generous per-test timeout
  // so a loaded runner does not flake it. Assertions are unchanged.
  it(
    'highlight: poi gated highlight equals the un-gated reference',
    () => {
      const poiRefRegexList = poiRefRegexes.map((x) => x.regex);
      for (const p of [...corpus, ...youngCorpus]) {
        const gated = poiCheckable.highlight(p, highlightFn);
        const reference = refHighlight(p, poiRefRegexList, poiPreprocess, highlightFn);
        expect(gated, `poi highlight mismatch for: ${JSON.stringify(p)}`).toBe(reference);
      }
    },
    60000
  );
});
