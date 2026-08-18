import { describe, expect, it } from 'vitest';
import { setUserSettingsInput, userSettingsSchema } from '~/server/schema/user.schema';

describe('headerEarnedBuzzOnly', () => {
  // The stored shape and the write input are two separate schemas. A key declared only in
  // `userSettingsSchema` reads back fine and silently never persists, because `setSettings`
  // strips it at the tRPC boundary before the handler ever sees it.
  it('is accepted by the write input, not only by the stored shape', () => {
    expect(setUserSettingsInput.parse({ headerEarnedBuzzOnly: true })).toEqual({
      headerEarnedBuzzOnly: true,
    });
  });

  it('round-trips through the stored settings shape', () => {
    expect(userSettingsSchema.parse({ headerEarnedBuzzOnly: false }).headerEarnedBuzzOnly).toBe(
      false
    );
  });

  it('is optional, so a user who never touched it parses clean', () => {
    expect(userSettingsSchema.parse({}).headerEarnedBuzzOnly).toBeUndefined();
  });
});
