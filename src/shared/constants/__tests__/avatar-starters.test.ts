import { describe, expect, it } from 'vitest';

import { avatarStarterCharacters, avatarStartersFor } from '~/shared/constants/avatar-starters';
import { avatarStyles } from '~/shared/constants/avatar-styles.constants';

// The pages and pickers show any style with any character, with no fallback for a missing one.
describe('avatar starters', () => {
  it.each(avatarStyles.map((style) => style.key))('%s has every starter character', (key) => {
    expect(avatarStartersFor(key).map((starter) => starter.character)).toEqual([
      ...avatarStarterCharacters,
    ]);
  });
});
