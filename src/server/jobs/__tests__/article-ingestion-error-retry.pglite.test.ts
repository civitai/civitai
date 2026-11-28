import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteKysely } from '~/__tests__/pglite-kysely';
import { TEXT_MODERATION_RETRY_LIMIT } from '~/server/jobs/text-moderation-retry.constants';
import { retryErrorArticles, type ErrorRetryDeps } from '~/server/jobs/article-ingestion-reconcile';
import type { ArticleIngestionErrorState } from '~/server/services/article-ingestion.helpers';

/**
 * The reconcile job's Error retry pass over real `Article` rows: what each tick sends and what it
 * writes to the episode. The recompute leaves each article at Error, and the scanner and the text
 * check are the boundaries the job is given. Ids are invented.
 */

const DAY = 24 * 60 * 60 * 1000;
const TICK = 10 * 60 * 1000;
const ENTERED = Date.UTC(2026, 10, 1);
const OWNER = 7;

let pg: PGlite;
const db = pgliteKysely(() => pg);

/** Failing images per article; the fake scanner keeps `retryArticleErrorImages`' budget contract. */
let failing: Record<number, number>;
/** Images per article the fake retry finds gone and sets NotFound. */
let goneImages: Record<number, number>;
const retryImages = vi.fn<ErrorRetryDeps['retryImages']>(
  async ({ article, budget, fullBudget }) => {
    const n = failing[article.id] ?? 0;
    if (n > budget && !fullBudget) return { sent: 0, deferred: true, gone: 0 };
    return { sent: Math.min(n, budget), deferred: false, gone: goneImages[article.id] ?? 0 };
  }
);
const resendText = vi.fn<ErrorRetryDeps['resendText']>(async () => undefined);

const deps: ErrorRetryDeps = {
  db,
  candidates: async (limit) =>
    (
      await pg.query<{ id: number; ingestionError: unknown }>(
        `SELECT id, metadata->'ingestionError' AS "ingestionError" FROM "Article"
         WHERE ingestion = 'Error'
         ORDER BY COALESCE((metadata->'ingestionError'->>'checkedAt')::bigint, 0), id LIMIT $1`,
        [limit]
      )
    ).rows,
  recomputeAndRead: vi.fn(
    async (id: number) =>
      (await pg.query<never>(`SELECT * FROM "Article" WHERE id = $1`, [id])).rows[0] ?? null
  ),
  readTextCheck: async (id) =>
    (
      await pg.query<never>(
        `SELECT status, "retryCount" FROM "EntityModeration" WHERE "entityId" = $1`,
        [id]
      )
    ).rows[0] ?? null,
  retryImages,
  resendText,
};

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE "Article" (
      id int PRIMARY KEY, "userId" int NOT NULL, title text NOT NULL, content text NOT NULL,
      "coverId" int, "bannerId" int, ingestion text NOT NULL, metadata jsonb
    );
    CREATE TABLE "EntityModeration" ("entityId" int PRIMARY KEY, status text NOT NULL, "retryCount" int NOT NULL);
  `);
});
afterAll(() => pg.close());

beforeEach(async () => {
  vi.clearAllMocks();
  failing = {};
  goneImages = {};
  await pg.exec(`TRUNCATE "Article", "EntityModeration"`);
});

const seed = async (
  id: number,
  episode: ArticleIngestionErrorState,
  { text = '', check }: { text?: string; check?: { status: string; retryCount: number } } = {}
) => {
  await pg.query(
    `INSERT INTO "Article" (id, "userId", title, content, ingestion, metadata) VALUES ($1, $2, $3, '', 'Error', $4)`,
    [id, OWNER, text, JSON.stringify({ ingestionError: episode })]
  );
  if (check)
    await pg.query(`INSERT INTO "EntityModeration" VALUES ($1, $2, $3)`, [
      id,
      check.status,
      check.retryCount,
    ]);
};

const episodeOf = async (id: number) =>
  (
    await pg.query<{ e: ArticleIngestionErrorState }>(
      `SELECT metadata->'ingestionError' AS e FROM "Article" WHERE id = $1`,
      [id]
    )
  ).rows[0].e;

const sentFor = (id: number) =>
  retryImages.mock.calls.filter(([{ article }]) => article.id === id).length;

describe('the Error retry pass', () => {
  it('runs a due round once, and nothing more on the next tick', async () => {
    await seed(1, { enteredAt: ENTERED, rounds: 0 });
    failing[1] = 3;
    const now = ENTERED + DAY;

    await retryErrorArticles(new Date(now), deps);
    await retryErrorArticles(new Date(now + TICK), deps);

    expect(sentFor(1)).toBe(1);
    expect(retryImages).toHaveBeenCalledWith(expect.objectContaining({ includeNotFound: true }));
    expect(await episodeOf(1)).toEqual({
      enteredAt: ENTERED,
      rounds: 1,
      lastRoundAt: now,
      checkedAt: now,
    });
  });

  // Kills: leaving an article hidden for a day after its last problem image is set NotFound.
  it('recomputes an article at once when its round set an image NotFound', async () => {
    await seed(1, { enteredAt: ENTERED, rounds: 0 });
    await seed(2, { enteredAt: ENTERED, rounds: 0 });
    goneImages[1] = 2;
    failing[2] = 1;

    await retryErrorArticles(new Date(ENTERED + DAY), deps);

    const recomputes = (id: number) =>
      vi.mocked(deps.recomputeAndRead).mock.calls.filter(([x]) => x === id).length;
    expect(recomputes(1)).toBe(2);
    expect(recomputes(2)).toBe(1);
  });

  // Kills: charging only the images sent, which lets one tick probe 200 images per article.
  it('charges images set NotFound to the tick budget', async () => {
    await seed(1, { enteredAt: ENTERED, rounds: 0 });
    await seed(2, { enteredAt: ENTERED, rounds: 0 });
    goneImages[1] = 150;
    failing[2] = 100;

    await retryErrorArticles(new Date(ENTERED + DAY), deps);

    expect(retryImages).toHaveBeenLastCalledWith(
      expect.objectContaining({ article: expect.objectContaining({ id: 2 }), budget: 50 })
    );
  });

  it('shares one image budget across a tick, deferring an article that does not fit', async () => {
    await seed(1, { enteredAt: ENTERED, rounds: 0 });
    await seed(2, { enteredAt: ENTERED, rounds: 0 });
    failing[1] = 150;
    failing[2] = 150;
    const now = ENTERED + DAY;

    const first = await retryErrorArticles(new Date(now), deps);
    expect(first).toMatchObject({ rounds: 1, images: 150, deferred: 1 });
    expect(await episodeOf(2)).toEqual({ enteredAt: ENTERED, rounds: 0 });

    const next = await retryErrorArticles(new Date(now + TICK), deps);
    expect(next).toMatchObject({ rounds: 1, images: 150, deferred: 0 });
    expect(sentFor(1)).toBe(1);
    expect(await episodeOf(2)).toMatchObject({ rounds: 1 });
  });

  it('resends only a text check that spent its retries, never one that succeeded', async () => {
    await seed(
      1,
      { enteredAt: ENTERED, rounds: 1 },
      { text: 'Words', check: { status: 'Failed', retryCount: TEXT_MODERATION_RETRY_LIMIT } }
    );
    await seed(
      2,
      { enteredAt: ENTERED, rounds: 1 },
      { text: 'Words', check: { status: 'Succeeded', retryCount: TEXT_MODERATION_RETRY_LIMIT } }
    );

    await retryErrorArticles(new Date(ENTERED + 3 * DAY), deps);

    expect(resendText.mock.calls.map(([{ id }]) => id)).toEqual([1]);
    expect(retryImages).toHaveBeenCalledWith(expect.objectContaining({ includeNotFound: false }));
  });

  it('marks a spent episode exhausted once, sending nothing', async () => {
    const lastRoundAt = ENTERED + 7 * DAY;
    await seed(1, { enteredAt: ENTERED, rounds: 3, lastRoundAt, checkedAt: lastRoundAt });
    const now = ENTERED + 8 * DAY;

    const first = await retryErrorArticles(new Date(now), deps);
    const next = await retryErrorArticles(new Date(now + TICK), deps);

    expect(first).toMatchObject({ exhausted: 1 });
    expect(next).toMatchObject({ candidates: 0 });
    expect(retryImages).not.toHaveBeenCalled();
    expect(await episodeOf(1)).toMatchObject({ exhaustedAt: now, checkedAt: now });
  });

  it('only checks an article between rounds', async () => {
    await seed(1, {
      enteredAt: ENTERED,
      rounds: 1,
      lastRoundAt: ENTERED + DAY,
      checkedAt: ENTERED + DAY,
    });
    const now = ENTERED + 2 * DAY;

    await retryErrorArticles(new Date(now), deps);

    expect(retryImages).not.toHaveBeenCalled();
    expect(await episodeOf(1)).toMatchObject({ rounds: 1, checkedAt: now });
  });
});
