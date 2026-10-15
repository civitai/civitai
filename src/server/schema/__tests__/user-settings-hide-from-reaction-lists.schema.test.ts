import { describe, expect, it } from 'vitest';
import { splitSettingsPatch } from '~/server/services/user.service';
import { setUserSettingsInput, userSettingsSchema } from '~/server/schema/user.schema';
import { HIDE_FROM_REACTION_LISTS_KEY } from '~/shared/constants/reaction-privacy.constants';

// The SQL filters read this key straight out of `User.settings`; a key `setSettings` strips at the tRPC boundary
// would leave the toggle flipping in the UI and nobody hidden.
describe(HIDE_FROM_REACTION_LISTS_KEY, () => {
  it('is accepted by the write input and the stored shape', () => {
    expect(setUserSettingsInput.parse({ [HIDE_FROM_REACTION_LISTS_KEY]: true })).toEqual({
      [HIDE_FROM_REACTION_LISTS_KEY]: true,
    });
    expect(userSettingsSchema.parse({ [HIDE_FROM_REACTION_LISTS_KEY]: true })).toMatchObject({
      [HIDE_FROM_REACTION_LISTS_KEY]: true,
    });
  });

  it('writes false rather than dropping the key, so it can be turned back off', () => {
    expect(splitSettingsPatch({ [HIDE_FROM_REACTION_LISTS_KEY]: false })).toEqual({
      set: { [HIDE_FROM_REACTION_LISTS_KEY]: false },
      remove: [],
    });
  });
});
