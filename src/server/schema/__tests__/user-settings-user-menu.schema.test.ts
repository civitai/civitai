import { describe, expect, it } from 'vitest';
import { setUserSettingsInput, userSettingsSchema } from '~/server/schema/user.schema';

describe('userMenu settings', () => {
  it('keeps the muted counts through the write input, not only the stored shape', () => {
    expect(
      setUserSettingsInput.parse({
        userMenu: { pinned: ['vault'], mutedBadges: ['collections', 'prizes'] },
      }).userMenu
    ).toEqual({ pinned: ['vault'], mutedBadges: ['collections', 'prizes'] });
  });

  it('accepts a write with only muted counts, for someone still on the default pins', () => {
    expect(
      setUserSettingsInput.parse({ userMenu: { mutedBadges: ['inventory'] } }).userMenu
    ).toEqual({ mutedBadges: ['inventory'] });
  });

  it('still accepts the shape saved before counts could be muted', () => {
    expect(userSettingsSchema.parse({ userMenu: { pinned: ['vault'] } }).userMenu).toEqual({
      pinned: ['vault'],
    });
  });

  it.each([
    ['an item that has no count', { mutedBadges: ['vault'] }],
    ['the same count twice', { mutedBadges: ['prizes', 'prizes'] }],
  ])('rejects %s', (_name, userMenu) => {
    expect(setUserSettingsInput.safeParse({ userMenu }).success).toBe(false);
  });
});
