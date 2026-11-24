import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { bootTagReview, createQueueDb } from '../../../test/pglite-kysely';
import { seedImage, seedPlayer } from '../../../test/seed';
import { ensureVotePartitions, escalateExpired } from '../queue/queue.service';
import { runTagReview, type TagReviewWalk } from './tag-review';
import {
  BLOCKED,
  flagTag,
  R,
  resetTagReview,
  ruleTag,
  staffPaladin,
  X,
} from './tag-review.fixtures';

// The items' createdAt is the database clock.
const NOW = new Date();
const DAY_AGO = new Date(NOW.getTime() - 86_400_000);
const PALADIN = 1;

let pg: PGlite;
let db: Kysely<DB>;

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  await bootTagReview(pg);
  await ensureVotePartitions(db, { now: NOW, monthsAhead: 1 });
});
afterAll(() => pg.close());

beforeEach(async () => {
  await resetTagReview(pg, [
    [10, 'nudity', 'Moderation', X],
    [11, 'swimwear', 'Moderation', R],
    [12, 'blocked thing', 'Moderation', BLOCKED],
    [13, 'cat', 'Label', 1],
  ]);
  await seedPlayer(pg, PALADIN, 'Paladin');
  await staffPaladin(pg, PALADIN, DAY_AGO);
  await seedImage(pg, 100, { nsfwLevel: X, userId: 5 });
  await flag(100, 10);
});

const flag = (imageId: number, tagId: number) => flagTag(pg, imageId, tagId);
const rule = (imageId: number, tagId: number, disabled: boolean) =>
  ruleTag(pg, imageId, tagId, disabled);

const run = (
  o: { enabled?: boolean; walk?: TagReviewWalk; pageSize?: number; pagesPerRun?: number } = {}
) =>
  runTagReview(db, {
    now: NOW,
    enabled: o.enabled ?? true,
    walk: o.walk ?? { after: null },
    pageSize: o.pageSize,
    pagesPerRun: o.pagesPerRun,
  });

type Item = {
  id: number;
  externalId: string;
  imageId: number;
  status: string;
  reason: string | null;
  source: string;
  minRank: string;
  audience: string;
  prompt: string;
  expiresAt: Date | null;
  meta: Record<string, unknown>;
  questionKey: string;
};
const items = async () =>
  (await pg.query<Item>(`SELECT * FROM "KnightsQueueItem" ORDER BY id`)).rows;

describe('creating tag review items', () => {
  it('asks Paladins about each flagged Moderation tag, with no deadline', async () => {
    await flag(100, 11);
    expect(await run()).toMatchObject({ created: 2 });
    const created = await items();
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({
      externalId: 'mod-tag:100:10:1',
      imageId: 100,
      status: 'Open',
      source: 'mod-tag-review',
      minRank: 'Paladin',
      audience: 'players',
      questionKey: 'knights.yesno.tag_review',
      prompt: 'Should this image have the tag nudity?',
      expiresAt: null,
      meta: { tagId: 10, episode: 1 },
    });
    expect(created[1]).toMatchObject({
      externalId: 'mod-tag:100:11:1',
      meta: { tagId: 11, episode: 1 },
    });
  });

  it('a rerun inserts nothing', async () => {
    await run();
    const before = await items();
    expect(await run()).toMatchObject({ created: 0 });
    expect(await items()).toEqual(before);
  });

  it('two concurrent runs create one item', async () => {
    await Promise.all([run(), run()]);
    expect(await items()).toHaveLength(1);
  });

  it('creates nothing with the switch off', async () => {
    expect(await run({ enabled: false })).toMatchObject({ created: 0 });
    expect(await items()).toEqual([]);
  });

  it('with the switch off and no items, reads no tag table, so it runs without access to them', async () => {
    // Stands in for a database role that cannot read the tag tables: a query naming the table fails before any row.
    await pg.exec('ALTER TABLE "TagsOnImageNew" RENAME TO "TagsOnImageNew_hidden"');
    try {
      await expect(run({ enabled: false })).resolves.toMatchObject({ created: 0, ended: 0 });
    } finally {
      await pg.exec('ALTER TABLE "TagsOnImageNew_hidden" RENAME TO "TagsOnImageNew"');
    }
  });

  it('creates nothing when no Paladin is active', async () => {
    await pg.exec(`TRUNCATE "KnightsVote"`);
    expect(await run()).toMatchObject({ created: 0 });
    expect(await items()).toEqual([]);
  });

  it.each([
    [
      'a tag that is not flagged',
      `SELECT upsert_tag_on_image(100, 10, NULL, NULL, false, false, false)`,
    ],
    [
      'a flagged tag that is disabled',
      `SELECT upsert_tag_on_image(100, 10, NULL, NULL, false, true, true)`,
    ],
    [
      'a Blocked-level tag',
      `DELETE FROM "TagsOnImageNew"; SELECT upsert_tag_on_image(100, 12, NULL, NULL, NULL, NULL, true)`,
    ],
    [
      'a tag that is not a Moderation tag',
      `DELETE FROM "TagsOnImageNew"; SELECT upsert_tag_on_image(100, 13, NULL, NULL, NULL, NULL, true)`,
    ],
    ['an unpublished post', `UPDATE "Post" SET "publishedAt" = NULL`],
    ['an image flagged for minor review', `UPDATE "Image" SET "needsReview" = 'minor'`],
    ['an image flagged as a real person', `UPDATE "Image" SET poi = true`],
    ['an image flagged for CSAM', `UPDATE "Image" SET "needsReview" = 'csam'`],
    ['an image on a CSAM report', `INSERT INTO "CsamReport" (images) VALUES ('[100]')`],
    ['an image whose owner is under a legal hold', `INSERT INTO "EvidenceHeldUser" VALUES (5)`],
    [
      'an image with an open report',
      `INSERT INTO "Report" (id, status) VALUES (1, 'Processing'); INSERT INTO "ImageReport" ("imageId", "reportId") VALUES (100, 1)`,
    ],
  ])('creates nothing for %s', async (_, change) => {
    await pg.exec(change);
    expect(await run()).toMatchObject({ created: 0 });
    expect(await items()).toEqual([]);
  });

  it('reaches every flagged row over successive runs when one run reads one page', async () => {
    for (const id of [101, 102]) {
      await seedImage(pg, id, { nsfwLevel: X });
      await flag(id, 10);
      await flag(id, 11);
    }
    await flag(100, 11);
    const walk: TagReviewWalk = { after: null };
    const seen: number[] = [];
    for (let i = 0; i < 3; i++) {
      await run({ walk, pageSize: 2, pagesPerRun: 1 });
      seen.push((await items()).length);
    }
    expect(seen).toEqual([2, 4, 6]);
    // The walk wrapped back to the start; the next pass finds nothing new.
    await run({ walk, pageSize: 2, pagesPerRun: 1 });
    expect(await items()).toHaveLength(6);
  });

  it('leaves the item Open at Paladin however long after creation the escalation runs', async () => {
    await run();
    await escalateExpired(db, { now: new Date(NOW.getTime() + 365 * 86_400_000) });
    expect((await items())[0]).toMatchObject({ status: 'Open', minRank: 'Paladin' });
  });
});

describe('a moderator ruling ends the episode', () => {
  it('reconciles an item of any age: an old one ends when moderators rule, and a re-flag opens episode 2', async () => {
    await run();
    await pg.exec(`UPDATE "KnightsQueueItem" SET "createdAt" = now() - interval '90 days'`);
    await rule(100, 10, false);
    expect(await run()).toMatchObject({ ruled: 1 });
    await flag(100, 10);
    await run();
    expect((await items()).map((i) => [i.externalId, i.status])).toEqual([
      ['mod-tag:100:10:1', 'Closed'],
      ['mod-tag:100:10:2', 'Open'],
    ]);
  });

  it.each([
    ['cleared', () => rule(100, 10, false)],
    ['disabled', () => rule(100, 10, true)],
    ['deleted', () => pg.exec(`DELETE FROM "TagsOnImageNew"`)],
  ])(
    'an Open item whose tag was %s closes moderator-ruled, its votes inconclusive',
    async (_, ruled) => {
      await run();
      const [{ id }] = await items();
      await pg.query(
        `INSERT INTO "KnightsVote" ("itemId","playerId","createdAt","questionKey","imageId","stage","answer","weight","verdict")
       VALUES ($1, 2, $2::timestamp, 'knights.yesno.tag_review', 100, 'Paladin', 'yes', 1, 'pending')`,
        [id, DAY_AGO.toISOString()]
      );
      await ruled();
      expect(await run()).toMatchObject({ ruled: 1, created: 0 });
      expect((await items())[0]).toMatchObject({
        status: 'Closed',
        reason: 'moderator-ruled',
        meta: { tagId: 10, episode: 1, episodeEnded: true },
      });
      const { rows } = await pg.query<{ verdict: string }>(
        `SELECT verdict FROM "KnightsVote" WHERE "itemId" = $1`,
        [id]
      );
      expect(rows).toEqual([{ verdict: 'inconclusive' }]);
    }
  );

  it('a re-flag after a moderator ruling opens episode 2 and leaves episode 1 as it was', async () => {
    await run();
    await rule(100, 10, false);
    await run();
    const [first] = await items();
    await flag(100, 10);
    expect(await run()).toMatchObject({ created: 1 });
    const after = await items();
    expect(after[0]).toEqual(first);
    expect(after[1]).toMatchObject({
      externalId: 'mod-tag:100:10:2',
      status: 'Open',
      meta: { tagId: 10, episode: 2 },
    });
  });

  it('a re-flag after an applied consensus opens the next episode too', async () => {
    await run();
    await pg.exec(
      `UPDATE "KnightsQueueItem" SET status = 'Consensus', "resolvedValue" = 'no', "appliedAt" = '2026-12-21 11:00:00'`
    );
    await rule(100, 10, true);
    expect(await run()).toMatchObject({ ended: 1 });
    const [first] = await items();
    expect(first.meta).toEqual({ tagId: 10, episode: 1, episodeEnded: true });
    await flag(100, 10);
    await run();
    expect((await items()).map((i) => i.externalId)).toEqual([
      'mod-tag:100:10:1',
      'mod-tag:100:10:2',
    ]);
    expect((await items())[0]).toEqual(first);
  });

  it.each([
    ['Open', `UPDATE "KnightsQueueItem" SET "voteCount" = 1`],
    [
      'a consensus awaiting write-back',
      `UPDATE "KnightsQueueItem" SET status = 'Consensus', "resolvedValue" = 'yes'`,
    ],
    [
      'closed without consensus',
      `UPDATE "KnightsQueueItem" SET status = 'Closed', reason = 'no-consensus'`,
    ],
  ])(
    'creates no second item while the latest one is %s and the tag is still flagged',
    async (_, state) => {
      await run();
      await pg.exec(state);
      expect(await run()).toMatchObject({ created: 0, ruled: 0, ended: 0 });
      expect(await items()).toHaveLength(1);
    }
  );

  it('after no consensus, a moderator ruling then a re-flag opens the next episode', async () => {
    await run();
    await pg.exec(`UPDATE "KnightsQueueItem" SET status = 'Closed', reason = 'no-consensus'`);
    await rule(100, 10, false);
    await run();
    await flag(100, 10);
    await run();
    expect((await items()).map((i) => [i.externalId, i.status])).toEqual([
      ['mod-tag:100:10:1', 'Closed'],
      ['mod-tag:100:10:2', 'Open'],
    ]);
  });
});
