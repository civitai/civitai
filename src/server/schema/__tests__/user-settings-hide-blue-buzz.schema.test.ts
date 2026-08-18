import { describe, expect, it } from 'vitest';
import { splitSettingsPatch } from '~/server/services/user.service';
import { setUserSettingsInput, userSettingsSchema } from '~/server/schema/user.schema';

describe('hideBlueBuzzInHeader', () => {
  // The stored shape and the write input are hand-maintained separately. A key present only in
  // `userSettingsSchema` type-checks on read and silently never persists, because `setSettings`
  // strips it at the tRPC boundary before the handler runs. Typecheck catches this too; the test
  // exists because a stripped-key failure reads as "the toggle does nothing" in production.
  it('is accepted by the write input, not only by the stored shape', () => {
    expect(setUserSettingsInput.parse({ hideBlueBuzzInHeader: true })).toEqual({
      hideBlueBuzzInHeader: true,
    });
  });

  it('is declared on the stored shape as an optional boolean', () => {
    expect(userSettingsSchema.parse({ hideBlueBuzzInHeader: false }).hideBlueBuzzInHeader).toBe(
      false
    );
    expect(userSettingsSchema.parse({}).hideBlueBuzzInHeader).toBeUndefined();
  });

  // Turning a toggle back OFF writes `false`, it does not delete the key. If `false` were treated
  // as empty it would land in neither the set nor the remove half of the patch, the mutation would
  // be a green no-op, and the optimistic cache update would show the switch flipping anyway — so
  // the setting would look un-turn-off-able only after a refresh.
  it('writes false rather than dropping the key, so the toggle can be turned back off', () => {
    const patch = splitSettingsPatch({ hideBlueBuzzInHeader: false });

    expect(patch.set).toEqual({ hideBlueBuzzInHeader: false });
    expect(patch.remove).toEqual([]);
  });
});
