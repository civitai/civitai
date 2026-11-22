import { blockedWords } from '@civitai/mod-utils/profanity/lists';
import {
  cleanWord,
  isUsableBlockedEntry,
  managedProfanityEntries,
  MIN_MANAGED_PROFANITY_ENTRIES,
} from '@civitai/mod-utils/profanity/word-rules';
import { describe, expect, it } from 'vitest';
import { createProfanityFilter, type SimpleProfanityFilter } from '~/libs/profanity-simple';
import { processNsfwWords } from '~/libs/profanity-simple/word-processor';

// Synthetic, letters only and 4+ long, so every one is usable; on no real list.
const usable = (count: number) =>
  Array.from(
    { length: count },
    (_, i) => `zorb${String.fromCharCode(97 + (i % 26))}${'q'.repeat(Math.floor(i / 26))}`
  );
// Each fails a different usability rule: too short, too few letters, a mid-word pipe.
const UNUSABLE = ['ab', 'x*y', 'a|b|c'];

describe('managedProfanityEntries', () => {
  it.each([
    [MIN_MANAGED_PROFANITY_ENTRIES - 1, false],
    [MIN_MANAGED_PROFANITY_ENTRIES, true],
    [MIN_MANAGED_PROFANITY_ENTRIES + 1, true],
  ])('%i usable entries: enforced %s', (count, enforced) => {
    expect(managedProfanityEntries(usable(count))).toEqual({ usable: usable(count), enforced });
  });

  it('does not count unusable entries toward the floor, and drops them', () => {
    const entries = [...usable(MIN_MANAGED_PROFANITY_ENTRIES - 1), ...UNUSABLE];
    expect(managedProfanityEntries(entries)).toEqual({
      usable: usable(MIN_MANAGED_PROFANITY_ENTRIES - 1),
      enforced: false,
    });
  });
});

// Pins that a managed copy of today's shipped list matches it (#10081).
describe('a managed copy of the shipped list', () => {
  const managedWords = managedProfanityEntries(blockedWords).usable;

  it('loads the same words as the shipped list', () => {
    const loaded = (words: readonly string[]) => processNsfwWords(words).originalWords;
    // Booleans and counts, not the words: a failure must not print the list.
    const shipped = loaded(blockedWords);
    const managed = loaded(managedWords);
    expect(managed.length).toBe(shipped.length);
    expect(managed.every((word, i) => word === shipped[i])).toBe(true);
    expect(new Set(managedWords.map(cleanWord)).size).toBe(shipped.length);
  });

  it('matches the shipped list on every entry', () => {
    const shipped = createProfanityFilter({ moderatorWhitelist: null, moderatorBlocklist: null });
    const managed = createProfanityFilter({
      moderatorWhitelist: null,
      moderatorBlocklist: managedWords,
    });
    const verdict = (filter: SimpleProfanityFilter, text: string) =>
      JSON.stringify([filter.analyze(text), filter.clean(text), filter.evaluateContent(text)]);
    let differing = 0;
    for (const entry of blockedWords) {
      const core = cleanWord(entry).replace(/\|/g, '');
      for (const text of [
        core,
        `the ${core} is here`,
        `xq${core}zq`,
        `${core}ing`,
        core.toUpperCase(),
        `${core} ${core} ${core}`,
      ]) {
        if (verdict(shipped, text) !== verdict(managed, text)) differing++;
      }
    }
    expect(differing).toBe(0);
  });

  it('keeps an entry usable however it is spelled', () => {
    const variants = (entry: string) => [entry.toUpperCase(), ` ${entry} `, `${entry}?`];
    const unstable = blockedWords.filter((entry) =>
      variants(entry).some((v) => isUsableBlockedEntry(v) !== isUsableBlockedEntry(entry))
    );
    expect(unstable.length).toBe(0);
  });

  it('does not extend to fragments of shipped entries', () => {
    const shipped = new Set(blockedWords.map(cleanWord));
    const fragments = new Set<string>();
    for (const word of shipped) {
      for (let i = 0; i + 3 <= word.length; i++) {
        const fragment = word.slice(i, i + 3);
        if (/^[a-z]{3}$/.test(fragment) && !shipped.has(fragment)) fragments.add(fragment);
      }
    }
    expect(fragments.size).toBeGreaterThan(0);
    const usable = [...fragments].filter((fragment) => isUsableBlockedEntry(fragment));
    expect(usable.length).toBe(0);
  });
});

describe('an entry on no list', () => {
  const ENTRY = 'qzx';

  it('is unusable bare', () => {
    expect(blockedWords.map(cleanWord).includes(ENTRY)).toBe(false);
    expect(isUsableBlockedEntry(ENTRY)).toBe(false);
  });

  it('is usable with a boundary marker', () => {
    expect(isUsableBlockedEntry(`|${ENTRY}`)).toBe(true);
  });
});
