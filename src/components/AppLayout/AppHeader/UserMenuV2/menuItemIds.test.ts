import { describe, expect, it } from 'vitest';
import { trackActionInputSchema } from '~/server/schema/track.schema';
import { userMenuSettingsSchema } from '~/server/schema/user.schema';

/** The server drops what these schemas reject: a pin or an open of a new item would vanish silently. */
describe('user menu ids reach the server schemas', () => {
  it.each(['crucibles', 'browse-challenges'] as const)(
    'accepts %s as a pin and as an open',
    (id) => {
      expect(userMenuSettingsSchema.safeParse({ pinned: [id] }).success).toBe(true);
      expect(
        trackActionInputSchema.safeParse({
          type: 'UserMenu_Click',
          details: { item: id, group: 'rewards', pinned: false, surface: 'desktop' },
        }).success
      ).toBe(true);
    }
  );
});
