import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The comment-spam signature, and specifically the condition that does the work.
 *
 * Measured over 90 days: ≥10 comments in an hour is 76.5% banned on its own, 98.9% from an account
 * under two days old, and **1.2% from an older one**. So the age is not a refinement, it is the rule —
 * a volume-only version points at 249 established accounts having an argument.
 *
 * There is deliberately no distinct-target condition. An earlier version had one; the ClickHouse
 * `comments` table records `entityId` as the comment's own id for every type except `Model`, so it
 * counted the same number twice and the UI stated it as fact.
 */

const query = vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []);
const executeTakeFirst = vi.fn(
  async (): Promise<unknown> => ({
    createdAt: new Date('2026-08-24T05:00:00Z'),
  })
);
vi.mock('../clickhouse', () => ({ getClickhouse: () => ({ $query: query }) }));
vi.mock('../db', () => ({
  dbRead: {
    selectFrom: () => ({
      select: () => ({ where: () => ({ executeTakeFirst }) }),
    }),
  },
  dbWrite: {},
}));

const { getCommentBurst } = await import('../user-signals.service');
const { COMMENT_SPAM } = await import('$lib/comment-spam');

/** A burst of `comments` at 06:00 UTC, from an account created `ageHours` earlier. */
const burst = (comments: number, ageHours = 1) => {
  query.mockResolvedValue([{ comments: String(comments), hour: '2026-08-24 06:00:00' }]);
  executeTakeFirst.mockResolvedValue({
    createdAt: new Date(Date.UTC(2026, 7, 24, 6, 0, 0) - ageHours * 3_600_000),
  });
  return getCommentBurst(1);
};

beforeEach(() => vi.clearAllMocks());

describe('getCommentBurst', () => {
  it('matches a burst from an account signed up an hour earlier', async () => {
    await expect(burst(11)).resolves.toMatchObject({
      comments: 11,
      ageAtBurstHours: 1,
      matchesSignature: true,
    });
  });

  it('does NOT match the same burst from an established account', async () => {
    // The 1.2% case. This is the assertion that stops the rule regressing to a volume check.
    await expect(burst(40, 24 * 30)).resolves.toMatchObject({ matchesSignature: false });
  });

  it('holds on both boundaries', async () => {
    await expect(burst(COMMENT_SPAM.minComments, 47)).resolves.toMatchObject({
      matchesSignature: true,
    });
    await expect(burst(9, 1)).resolves.toMatchObject({ matchesSignature: false });
    await expect(burst(11, 49)).resolves.toMatchObject({ matchesSignature: false });
  });

  it('normalises the ClickHouse timestamp, which carries no zone', async () => {
    // Unnormalised, `2026-08-24 06:00:00` reads as LOCAL — the burst renders hours away from the IP
    // events beside it, and the age it is judged on is wrong by the same offset.
    await expect(burst(11)).resolves.toMatchObject({ hour: '2026-08-24T06:00:00Z' });
  });

  it('asks for that account, and counts comments rather than anything else', async () => {
    await burst(11);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain('userId = 1');
    expect(sql).toContain('count() AS comments');
    expect(sql).toContain('toStartOfHour(time)');
  });

  it('returns null when the account has never commented', async () => {
    query.mockResolvedValue([]);
    await expect(getCommentBurst(1)).resolves.toBeNull();
  });

  it('sits on the thresholds the measurement produced', () => {
    expect(COMMENT_SPAM).toEqual({ minComments: 10, maxAccountAgeDays: 2 });
  });
});
