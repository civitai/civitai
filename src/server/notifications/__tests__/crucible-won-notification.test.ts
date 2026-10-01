import { describe, expect, it } from 'vitest';
import { crucibleNotifications } from '~/server/notifications/crucible.notifications';
import { notificationProcessors } from '~/server/notifications/utils.notifications';

// The drawer, settings and push all look a type up in `notificationProcessors`, and an
// unregistered type still counts as unread while the drawer drops it.
describe('crucible notification registration', () => {
  it.each(Object.keys(crucibleNotifications))('registers %s', (type) => {
    expect((notificationProcessors as Record<string, unknown>)[type]).toBe(
      (crucibleNotifications as Record<string, unknown>)[type]
    );
  });
});

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

describe('crucible notifications without a name', () => {
  it.each([
    ['crucible-ended', { crucibleId: 7, crucibleName: null, totalEntries: 3, prizePool: 900 }],
    ['crucible-won', { crucibleId: 7, crucibleName: null, position: 1, prizeAmount: 1500 }],
    ['crucible-won', { crucibleId: 7, crucibleName: null, position: 2, prizeAmount: 0 }],
    ['crucible-won', { crucibleId: 7, crucibleName: null, position: null, prizeAmount: 0 }],
    ['crucible-entry-submitted', { crucibleId: 7, crucibleName: null, entrantUsername: 'kai' }],
  ] as const)('%s reads cleanly with the name withheld', (type, details) => {
    const def = crucibleNotifications[type];
    const msg = def.prepareMessage({ details } as Parameters<typeof def.prepareMessage>[0]);

    expect(msg!.message).not.toMatch(/null|undefined|""/);
    expect(msg!.message).toMatch(/crucible\b/);
    expect(msg!.url).toBe('/crucibles/7');
  });

  it('quotes the name when there is one', () => {
    const msg = crucibleNotifications['crucible-ended'].prepareMessage({
      details: { crucibleId: 7, crucibleName: 'Neon', totalEntries: 3, prizePool: 900 },
    });
    expect(msg!.message).toBe(
      'Your crucible "Neon" has ended! 3 entries competed for a prize pool of 900 Buzz.'
    );
  });
});
