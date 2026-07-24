import { describe, expect, it } from 'vitest';
import { challengeNotifications } from '~/server/notifications/challenge.notifications';

/**
 * Definition coverage for the four discovery notifications (pure — no DB / client).
 * The two SQL types are asserted on their generated query string: these gates are the
 * difference between a useful notification and one that announces a hidden, blocked,
 * unscanned or cancelled challenge.
 */

type Def = {
  displayName: string;
  category: string;
  toggleable?: boolean;
  prepareMessage: (n: { details: Record<string, unknown> }) => { message: string; url?: string };
  prepareQuery?: (args: { lastSent: string }) => string;
};
const defs = challengeNotifications as unknown as Record<string, Def>;

const NEW_TYPES = [
  'challenge-starting',
  'new-challenge-from-following',
  'challenge-ending-soon',
  'challenge-results',
] as const;

describe('challenge discovery notifications — registration shape', () => {
  it('all four are toggleable Update notifications', () => {
    for (const type of NEW_TYPES) {
      const def = defs[type];
      expect(def, type).toBeTruthy();
      expect(def.toggleable, type).toBe(true);
      expect(def.category, type).toBe('Update');
    }
  });

  it('the pre-existing outcome notifications stay non-toggleable', () => {
    for (const type of ['challenge-winner', 'challenge-participation', 'challenge-cancelled']) {
      expect(defs[type].toggleable, type).toBe(false);
    }
  });

  it('inline types have no prepareQuery; scanned types do', () => {
    expect(defs['challenge-starting'].prepareQuery).toBeUndefined();
    expect(defs['challenge-results'].prepareQuery).toBeUndefined();
    expect(typeof defs['new-challenge-from-following'].prepareQuery).toBe('function');
    expect(typeof defs['challenge-ending-soon'].prepareQuery).toBe('function');
  });
});

describe('prepareMessage', () => {
  it('challenge-starting names the challenge and links to it', () => {
    const m = defs['challenge-starting'].prepareMessage({
      details: { challengeId: 12, challengeTitle: 'Neon Dreams' },
    });
    expect(m.message).toContain('Neon Dreams');
    expect(m.message.toLowerCase()).toMatch(/live|started/);
    expect(m.url).toBe('/challenges/12');
  });

  it('new-challenge-from-following names the creator and the challenge', () => {
    const m = defs['new-challenge-from-following'].prepareMessage({
      details: { challengeId: 12, challengeTitle: 'Neon Dreams', username: 'ada' },
    });
    expect(m.message).toContain('ada');
    expect(m.message).toContain('Neon Dreams');
    expect(m.url).toBe('/challenges/12');
  });

  it('challenge-ending-soon states the 24 hour window', () => {
    const m = defs['challenge-ending-soon'].prepareMessage({
      details: { challengeId: 12, challengeTitle: 'Neon Dreams' },
    });
    expect(m.message).toContain('Neon Dreams');
    expect(m.message).toContain('24 hours');
    expect(m.url).toBe('/challenges/12');
  });

  it('challenge-results points at the challenge', () => {
    const m = defs['challenge-results'].prepareMessage({
      details: { challengeId: 12, challengeTitle: 'Neon Dreams' },
    });
    expect(m.message).toContain('Neon Dreams');
    expect(m.url).toBe('/challenges/12');
  });
});

describe('new-challenge-from-following — SQL gates', () => {
  const sql = () =>
    defs['new-challenge-from-following'].prepareQuery!({ lastSent: '2026-01-01 00:00:00' });

  it('restricts to user-created challenges', () => {
    expect(sql()).toContain(`c.source = 'User'`);
  });

  it('requires the moderation scan to have passed', () => {
    expect(sql()).toContain(`c.ingestion = 'Scanned'`);
  });

  it('excludes cancelled and completed challenges', () => {
    expect(sql()).toContain(`c.status IN ('Scheduled', 'Active')`);
  });

  it('only announces challenges made visible after the follow', () => {
    expect(sql()).toContain(`c."visibleAt" >= ue."createdAt"`);
  });

  it('bounds the scan window with the 30-minute wall-clock floor', () => {
    expect(sql()).toContain(`INTERVAL '30 minutes'`);
  });

  it('keeps the 59-second cursor-race lookback', () => {
    expect(sql()).toContain(`interval '59 second'`);
  });

  it('drops recipients who blocked the creator or are blocked by them', () => {
    const q = sql();
    expect(q).toContain('"UserEngagement" blk');
    expect(q).toMatch(/blk\.type IN \('Block', ?'Hide'\)/);
  });

  it('gates on the cover image level against the recipient browsing level', () => {
    expect(sql()).toContain(`(cover."nsfwLevel" & ru."browsingLevel") <> 0`);
  });

  it('respects the per-type opt-out', () => {
    expect(sql()).toContain(`type = 'new-challenge-from-following'`);
  });
});

describe('challenge-ending-soon — SQL gates', () => {
  const sql = () => defs['challenge-ending-soon'].prepareQuery!({ lastSent: '2026-01-01 00:00:00' });

  it('fires on the crossing into the 24 hour window, not on every run inside it', () => {
    const q = sql();
    expect(q).toContain(`now() BETWEEN c."endsAt" - interval '24 hours' AND c."endsAt"`);
    expect(q).toContain(`< c."endsAt" - interval '24 hours'`);
  });

  it('only reminds about challenges still accepting entries', () => {
    expect(sql()).toContain(`c.status = 'Active'`);
  });

  it('targets trackers and entrants', () => {
    const q = sql();
    expect(q).toContain('"ChallengeEngagement"');
    expect(q).toContain('"CollectionItem"');
  });

  it('respects the per-type opt-out', () => {
    expect(sql()).toContain(`type = 'challenge-ending-soon'`);
  });
});
