import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The comment-spam signature, and specifically the two conditions that are NOT "lots of comments".
 *
 * Measured 2026-08-24 against the wave: accounts posting 20-39 comments an hour are 98% legitimate,
 * while the wave sat at 11 comments on 11 distinct targets in two minutes. So a rule that trips on
 * volume alone points at the wrong accounts — the spread across targets is what separates a script
 * from a conversation, and either condition failing must mean no signature.
 */

const query = vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []);
vi.mock('../clickhouse', () => ({ getClickhouse: () => ({ $query: query }) }));
vi.mock('../db', () => ({ dbRead: {}, dbWrite: {} }));

const { getCommentBurst, COMMENT_SPAM } = await import('../user-signals.service');

const hour = (comments: number, targets: number) => {
  query.mockResolvedValue([
    { comments: String(comments), targets: String(targets), hour: '2026-08-24 06:00:00' },
  ]);
  return getCommentBurst(1);
};

beforeEach(() => vi.clearAllMocks());

describe('getCommentBurst', () => {
  it('matches the wave: one comment each on many targets in one hour', async () => {
    await expect(hour(11, 11)).resolves.toMatchObject({
      comments: 11,
      targets: 11,
      matchesSignature: true,
    });
  });

  it('does NOT match a busy hour concentrated on a few threads', async () => {
    // 40 comments across 3 threads is an argument, not a script.
    await expect(hour(40, 3)).resolves.toMatchObject({ matchesSignature: false });
  });

  it('does NOT match a handful of comments, however spread out', async () => {
    await expect(hour(4, 4)).resolves.toMatchObject({ matchesSignature: false });
  });

  it('reports the busiest hour even when it clears nothing, so the number is still readable', async () => {
    await expect(hour(4, 4)).resolves.toMatchObject({ comments: 4, targets: 4 });
  });

  it('returns null when the account has never commented', async () => {
    query.mockResolvedValue([]);
    await expect(getCommentBurst(1)).resolves.toBeNull();
  });

  it('sits exactly on the thresholds the mod team confirmed', () => {
    expect(COMMENT_SPAM).toEqual({ minComments: 10, minTargets: 10, maxAccountAgeDays: 2 });
  });
});
