import { describe, expect, it } from 'vitest';
import { crucibleNotifications } from '~/server/notifications/crucible.notifications';

describe('crucible-won notification message', () => {
  const def = crucibleNotifications['crucible-won'];

  it('names the place and the prize', () => {
    const msg = def.prepareMessage({
      details: { crucibleId: 7, crucibleName: 'Neon', position: 1, prizeAmount: 1500 },
    });

    expect(msg!.message).toContain('1st');
    expect(msg!.message).toContain('1,500 Buzz');
  });

  it('says why an entry without enough votes was not placed, instead of "position null"', () => {
    const msg = def.prepareMessage({
      details: { crucibleId: 7, crucibleName: 'Neon', position: null, prizeAmount: 0 },
    });

    expect(msg!.message).not.toContain('null');
    expect(msg!.message).toContain('enough votes');
    expect(msg!.url).toBe('/crucibles/7');
  });
});
