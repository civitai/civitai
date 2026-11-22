import {
  managedProfanityEntries,
  MIN_MANAGED_PROFANITY_ENTRIES,
} from '@civitai/mod-utils/profanity/word-rules';
import { describe, expect, it } from 'vitest';

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
