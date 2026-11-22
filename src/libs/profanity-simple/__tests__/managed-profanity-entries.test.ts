import { blockedWords } from '@civitai/mod-utils/profanity/lists';
import {
  cleanWord,
  isUsableBlockedEntry,
  managedProfanityEntries,
  MIN_MANAGED_PROFANITY_ENTRIES,
} from '@civitai/mod-utils/profanity/word-rules';
import { describe, expect, it } from 'vitest';
import { createProfanityFilter, type SimpleProfanityFilter } from '~/libs/profanity-simple';

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

// Pins the managed list's alignment with the shipped list (#10081): this goes red if they drift.
describe('a managed copy of the shipped list', () => {
  it('matches the shipped list on every entry', () => {
    const shipped = createProfanityFilter({ moderatorWhitelist: null, moderatorBlocklist: null });
    const managed = createProfanityFilter({
      moderatorWhitelist: null,
      moderatorBlocklist: managedProfanityEntries(blockedWords).usable,
    });
    const verdict = (filter: SimpleProfanityFilter, text: string) =>
      `${filter.analyze(text).isProfane}|${filter.clean(text)}`;
    let differing = 0;
    for (const entry of blockedWords) {
      const core = cleanWord(entry).replace(/\|/g, '');
      for (const text of [
        core,
        `the ${core} is here`,
        `xq${core}zq`,
        `${core}ing`,
        core.toUpperCase(),
      ]) {
        if (verdict(shipped, text) !== verdict(managed, text)) differing++;
      }
    }
    // A count, not the texts: a failure must not print the list.
    expect(differing).toBe(0);
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
