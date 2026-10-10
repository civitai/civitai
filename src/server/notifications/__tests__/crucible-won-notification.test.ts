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

  // A creator holds one prize, so 4th place can take 2nd prize; naming the position confuses it.
  it('names the prize won, not the position, when the prize place is known', () => {
    const msg = def.prepareMessage({
      details: {
        crucibleId: 7,
        crucibleName: 'Neon',
        position: 4,
        prizePlace: 2,
        prizeAmount: 1000,
      },
    });

    expect(msg!.message).toBe(
      'Congrats! You took 2nd prize in the crucible "Neon" and won 1,000 Buzz.'
    );
  });

  it('says why an entry without enough votes was not placed, instead of "position null"', () => {
    const msg = def.prepareMessage({
      details: { crucibleId: 7, crucibleName: 'Neon', position: null, prizeAmount: 0 },
    });

    expect(msg!.message).not.toContain('null');
    expect(msg!.message).toContain('enough votes');
    expect(msg!.url).toBe('/crucibles/7');
  });

  it('sends a winner to the claim screen for their prize', () => {
    const msg = def.prepareMessage({
      details: {
        crucibleId: 7,
        crucibleName: 'Neon',
        position: 4,
        prizePlace: 2,
        prizeAmount: 1500,
        prizeId: 42,
        prizeCount: 1,
      },
    });

    expect(msg!.url).toBe('/prizes/42');
    expect(msg!.message).toBe(
      'Congrats! You took 2nd prize in the crucible "Neon" and won 1,500 Buzz. Claim your prize!'
    );
  });

  it('sends a winner of several prizes to their prize list', () => {
    const msg = def.prepareMessage({
      details: {
        crucibleId: 7,
        crucibleName: 'Neon',
        position: 1,
        prizeAmount: 1500,
        prizeCount: 2,
      },
    });

    expect(msg!.url).toBe('/prizes');
  });

  it('keeps an already-paid winner, notified before prizes were claimable, on the crucible', () => {
    const msg = def.prepareMessage({
      details: { crucibleId: 7, crucibleName: 'Neon', position: 1, prizeAmount: 1500 },
    });

    expect(msg!.url).toBe('/crucibles/7');
    expect(msg!.message).not.toContain('Claim');
  });
});

describe('crucible notifications without a name', () => {
  it.each([
    ['crucible-ended', { crucibleId: 7, crucibleName: null, totalEntries: 3, prizePool: 900 }],
    ['crucible-won', { crucibleId: 7, crucibleName: null, position: 1, prizeAmount: 1500 }],
    [
      'crucible-won',
      { crucibleId: 7, crucibleName: null, position: 4, prizePlace: 2, prizeAmount: 1500 },
    ],
    ['crucible-won', { crucibleId: 7, crucibleName: null, position: 2, prizeAmount: 0 }],
    ['crucible-won', { crucibleId: 7, crucibleName: null, position: null, prizeAmount: 0 }],
    ['crucible-entry-submitted', { crucibleId: 7, crucibleName: null, entrantUsername: 'kai' }],
    ['crucible-cancelled', { crucibleId: 7, crucibleName: null, refundPending: false }],
    ['crucible-entry-removed', { crucibleId: 7, crucibleName: null, refundedAmount: 0 }],
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

describe('crucible-ended copy', () => {
  const ended = (details: Record<string, unknown>) =>
    crucibleNotifications['crucible-ended'].prepareMessage({
      details: { crucibleId: 7, crucibleName: 'Neon', prizePool: 900, ...details },
    } as never)!.message;

  it('says nobody entered, and that the seed came back', () => {
    expect(ended({ totalEntries: 0, seedRefunded: 500 })).toBe(
      'Your crucible "Neon" has ended with no entries. Your seeded prize pool of 500 Buzz was refunded.'
    );
  });

  it('says no entry could place rather than that none competed', () => {
    expect(ended({ totalEntries: 0, disqualifiedEntries: 4, seedRefunded: 0 })).toBe(
      'Your crucible "Neon" has ended, but none of its entries could place, so no prizes were awarded.'
    );
  });

  it('counts the entries that competed, with separators', () => {
    expect(ended({ totalEntries: 1200, prizePool: 25000 })).toBe(
      'Your crucible "Neon" has ended! 1,200 entries competed for a prize pool of 25,000 Buzz.'
    );
  });
});

describe('crucible-cancelled copy', () => {
  const cancelled = (refundPending: boolean) =>
    crucibleNotifications['crucible-cancelled'].prepareMessage({
      details: { crucibleId: 7, crucibleName: 'Neon', refundPending },
    } as never)!;

  it('tells an entrant their fees were refunded', () => {
    expect(cancelled(false)).toEqual({
      message:
        'The crucible "Neon" you entered was cancelled. Any entry fees you paid have been refunded.',
      url: '/crucibles/7',
    });
  });

  it('tells an entrant whose refund failed that it is being processed', () => {
    expect(cancelled(true).message).toBe(
      'The crucible "Neon" you entered was cancelled. Your entry fee refund is being processed.'
    );
  });
});

describe('crucible-entry-removed copy', () => {
  const removed = (details: Record<string, unknown>) =>
    crucibleNotifications['crucible-entry-removed'].prepareMessage({
      details: { crucibleId: 7, crucibleName: 'Neon', ...details },
    } as never)!.message;

  it('names the refund', () => {
    expect(removed({ refundedAmount: 1500 })).toBe(
      'A moderator removed your entry from the crucible "Neon". Your 1,500 Buzz entry fee was refunded.'
    );
  });

  it('mentions no refund for a free entry', () => {
    expect(removed({ refundedAmount: 0 })).toBe(
      'A moderator removed your entry from the crucible "Neon".'
    );
  });
});
