import { describe, it, expect } from 'vitest';
import { includesNsfw, includesPoi, getTagsFromPrompt } from '~/utils/metadata/audit';
import poiWords from '~/utils/metadata/lists/words-poi.json';
import nsfwPromptWords from '~/utils/metadata/lists/words-nsfw-prompt.json';
import nsfwWordsSoft from '~/utils/metadata/lists/words-nsfw-soft.json';
import nsfwWordsPaddle from '~/utils/metadata/lists/words-paddle-nsfw.json';
import promptTags from '~/utils/metadata/lists/prompt-tags.json';

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

describe('audit matching equivalence (gate vs brute-force)', () => {
  it('includesNsfw matches the reference for every prompt', () => {
    for (const p of corpus) {
      expect(Boolean(includesNsfw(p)), `includesNsfw mismatch for: ${JSON.stringify(p)}`).toBe(
        refIncludesNsfw(p)
      );
    }
  });

  it('includesPoi returns the same matched name as the reference', () => {
    for (const p of corpus) {
      expect(includesPoi(p), `includesPoi mismatch for: ${JSON.stringify(p)}`).toEqual(
        refIncludesPoi(p)
      );
    }
  });

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
});
