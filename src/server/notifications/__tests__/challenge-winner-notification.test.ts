import { describe, expect, it } from 'vitest';
import { challengeNotifications } from '~/server/notifications/challenge.notifications';

// A user challenge whose pool was never funded still picks winners, so the prize can legitimately
// be 0 (challenge 413). The notification must not congratulate the winner on 0 Buzz.
describe('challenge-winner notification message', () => {
  const def = challengeNotifications['challenge-winner'];

  it('names the prize when there is one', () => {
    const msg = def.prepareMessage({
      details: { challengeId: 7, challengeName: 'Neon Dreams', position: 1, prize: 1500 },
    });

    expect(msg!.message).toContain('1st');
    expect(msg!.message).toContain('1,500 Buzz');
    expect(msg!.url).toBe('/challenges/7');
  });

  it('drops the Buzz claim entirely when the prize is 0', () => {
    const msg = def.prepareMessage({
      details: { challengeId: 413, challengeName: 'Cute Cats with Silly Hats', position: 2, prize: 0 },
    });

    expect(msg!.message).toContain('2nd');
    expect(msg!.message).toContain('Cute Cats with Silly Hats');
    expect(msg!.message).not.toMatch(/Buzz/);
    expect(msg!.message).not.toMatch(/won/);
  });
});
