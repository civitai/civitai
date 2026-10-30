import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NsfwLevel } from '@civitai/shared';

/**
 * `FrontPageTimers` has no media column, so the image and video sweeps are kept apart by namespacing
 * the rating into its free-text `nsfw` key. Drop that and the two share a resume point again: marking
 * a 20-row video sweep would advance the point the 200-row image sweep resumes from, and every image
 * created in the same span is then treated as swept by a sweep that never showed it. Nothing surfaces
 * that — the queue just returns fewer rows.
 *
 * So the assertions are on the KEY each query actually used. `dbRead` is real Kysely on a driver that
 * never connects, because a chain fake cannot see a value that only exists in compiled SQL.
 */

const captured = vi.hoisted(() => [] as { sql: string; parameters: readonly unknown[] }[]);

vi.mock('$lib/server/moderator-db', async () => {
  const { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } =
    await import('kysely');
  const db = new Kysely<never>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (i) => new PostgresIntrospector(i),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log: (e) => {
      if (e.level === 'query') captured.push({ sql: e.query.sql, parameters: e.query.parameters });
    },
  });
  return { getModeratorDb: () => db };
});

const { getSweepCheckpoints, markSweepChecked } = await import('../front-page-timers');

beforeEach(() => {
  captured.length = 0;
});

/** Every parameter the run bound, flattened — the key is whichever of them is a string. */
const boundKeys = () =>
  captured.flatMap((q) => q.parameters.filter((p): p is string => typeof p === 'string'));

describe('the sweep resume point is keyed by media, not by rating alone', () => {
  it('reads the bare rating for images, so existing rows and Retool still match', async () => {
    await getSweepCheckpoints([NsfwLevel.PG], 'image');
    expect(boundKeys()).toContain(String(NsfwLevel.PG));
    expect(boundKeys()).not.toContain(`video:${NsfwLevel.PG}`);
  });

  it('reads a namespaced key for video', async () => {
    await getSweepCheckpoints([NsfwLevel.PG], 'video');
    expect(boundKeys()).toContain(`video:${NsfwLevel.PG}`);
    // The bare key is the IMAGE stream. Matching it here is the bug this guards.
    expect(boundKeys()).not.toContain(String(NsfwLevel.PG));
  });

  it('keeps several ratings apart within one media type', async () => {
    await getSweepCheckpoints([NsfwLevel.PG, NsfwLevel.PG13], 'video');
    expect(boundKeys()).toEqual(
      expect.arrayContaining([`video:${NsfwLevel.PG}`, `video:${NsfwLevel.PG13}`])
    );
  });

  it('writes the same key it reads, or a mark would never be found again', async () => {
    const lastCheckedAt = new Date('2026-08-21T00:00:00.000Z');
    await markSweepChecked({
      nsfwLevel: NsfwLevel.PG,
      media: 'video',
      lastCheckedAt,
      username: 'x',
    });
    expect(boundKeys()).toContain(`video:${NsfwLevel.PG}`);

    captured.length = 0;
    await markSweepChecked({
      nsfwLevel: NsfwLevel.PG,
      media: 'image',
      lastCheckedAt,
      username: 'x',
    });
    expect(boundKeys()).toContain(String(NsfwLevel.PG));
  });
});
