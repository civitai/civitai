import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('../clickhouse', () => ({ getClickhouse: () => ({ $query: vi.fn() }) }));

const { selectSpamCandidates } = await import('../comment-spam.service');

/**
 * The queue is a list of things to do, so every exclusion here is a moderator's minute.
 *
 * The age condition carries the whole finding: ≥10 comments in an hour is 98.9% banned from an account
 * under two days old and 1.2% from an older one, so age is the rule rather than a refinement.
 */
const HOUR = new Date('2026-08-24T06:00:00Z');
const burst = (userId: number) => ({ userId, comments: 11, hour: HOUR });
const account = (id: number, overrides: Partial<Record<string, unknown>> = {}) => ({
  id,
  username: `u${id}`,
  email: `u${id}@example.com`,
  createdAt: new Date('2026-08-24T05:00:00Z'),
  bannedAt: null,
  deletedAt: null,
  ...overrides,
});

describe('selectSpamCandidates', () => {
  it('keeps a burst from an account that signed up an hour earlier', () => {
    const [row] = selectSpamCandidates([burst(1)], [account(1) as never]);
    // The email is the link into Bulk Ban, so a swapped column would break the queue's main affordance.
    expect(row).toMatchObject({
      userId: 1,
      comments: 11,
      ageAtBurstHours: 1,
      username: 'u1',
      email: 'u1@example.com',
    });
  });

  it('drops a burst from an established account', () => {
    const old = account(1, { createdAt: new Date('2026-01-01T00:00:00Z') });
    expect(selectSpamCandidates([burst(1)], [old as never])).toEqual([]);
  });

  it('holds the day/hour boundary — the units are the easy thing to break', () => {
    // 47h in, 49h out. Reading `maxAccountAgeDays` as hours would keep the first and drop both.
    const at = (h: number) =>
      account(1, { createdAt: new Date(HOUR.getTime() - h * 3_600_000) }) as never;
    expect(selectSpamCandidates([burst(1)], [at(47)])).toHaveLength(1);
    expect(selectSpamCandidates([burst(1)], [at(49)])).toEqual([]);
  });

  it('drops accounts someone has already banned or deleted', () => {
    const banned = account(1, { bannedAt: new Date() });
    const deleted = account(2, { deletedAt: new Date() });
    expect(selectSpamCandidates([burst(1), burst(2)], [banned as never, deleted as never])).toEqual(
      []
    );
  });

  it('drops a burst whose account no longer resolves', () => {
    expect(selectSpamCandidates([burst(99)], [])).toEqual([]);
  });

  it('floors a negative age rather than reporting one', () => {
    // The burst timestamp comes from ClickHouse and the signup from Postgres; a few seconds of skew
    // between them must not render as "-1h old".
    const later = account(1, { createdAt: new Date('2026-08-24T06:00:30Z') });
    expect(selectSpamCandidates([burst(1)], [later as never])[0].ageAtBurstHours).toBe(0);
  });

  it('orders newest burst first', () => {
    const older = { ...burst(2), hour: new Date('2026-08-20T06:00:00Z') };
    const rows = selectSpamCandidates(
      [older, burst(1)],
      [account(1) as never, account(2, { createdAt: new Date('2026-08-20T05:00:00Z') }) as never]
    );
    expect(rows.map((r) => r.userId)).toEqual([1, 2]);
  });
});
