import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { removalLowersLevel } from '@civitai/db/knights';
import type { DB } from '@civitai/db-schema/kysely';
import { bootTagReview, createQueueDb } from '../../../test/pglite-kysely';
import { seedImage, seedPlayer } from '../../../test/seed';
import { ensureVotePartitions } from '../queue/queue.service';
import { pickYesNo } from './feed';
import { importYesNo, type YesNoRow } from './import';
import { closeStrandedYesNo } from './sweep';
import { runTagReview } from './tag-review';
import { flagTag, R, resetTagReview, ruleTag, staffPaladin, X } from './tag-review.fixtures';
import { castYesNoVote } from './vote';

const NOW = new Date();
const DAY_AGO = new Date(NOW.getTime() - 86_400_000);
const PALADINS = [1, 2, 3, 4];
const TEMPLAR = 9;

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
    [12, 'also x', 'Moderation', X],
  ]);
  for (const id of PALADINS) await seedPlayer(pg, id, 'Paladin');
  await seedPlayer(pg, TEMPLAR, 'Templar');
  await staffPaladin(pg, 1, DAY_AGO);
  await seedImage(pg, 100, { nsfwLevel: X, userId: 50 });
  await flag(100, 10);
  await enable(100, 11);
});

const flag = (imageId: number, tagId: number) => flagTag(pg, imageId, tagId);
const enable = (imageId: number, tagId: number) => ruleTag(pg, imageId, tagId, false);
const disable = (imageId: number, tagId: number) => ruleTag(pg, imageId, tagId, true);

async function createItem(): Promise<number> {
  await runTagReview(db, { now: NOW, enabled: true, walk: { after: null } });
  const { rows } = await pg.query<{ id: number }>(
    `SELECT id FROM "KnightsQueueItem" WHERE source = 'mod-tag-review'`
  );
  return rows[0].id;
}

const offer = (userId: number, o: { share?: number; tagReview?: boolean; rank?: string } = {}) =>
  pickYesNo(db, {
    userId,
    rank: o.rank ?? 'Paladin',
    secret: 's',
    share: o.share ?? 0,
    tagReview: o.tagReview ?? true,
    stretch: 8,
    force: true,
  });

const vote = (userId: number, itemId: number, answer: 'yes' | 'no') =>
  castYesNoVote(db, { userId, itemId, answer }, { now: () => NOW });

const state = async (id: number) =>
  (
    await pg.query<{ status: string; reason: string | null; resolvedValue: string | null }>(
      `SELECT status, reason, "resolvedValue" FROM "KnightsQueueItem" WHERE id = $1`,
      [id]
    )
  ).rows[0];

describe('serving tag review items', () => {
  it('serves a Paladin the item with the yes/no share at 0 and the switch on', async () => {
    const id = await createItem();
    expect(await offer(1)).toMatchObject({
      itemId: id,
      prompt: 'Should this image have the tag nudity?',
      category: { heading: 'Tag review' },
    });
  });

  it('serves nothing with the switch off, and other axes behave as before', async () => {
    await createItem();
    expect(await offer(1, { tagReview: false })).toBeNull();
    const rows: YesNoRow[] = [
      {
        externalId: 'v1',
        imageId: 100,
        axis: 'violence',
        audience: 'players',
        prompt: 'Is blood shown?',
        yesEffect: null,
        noEffect: null,
        meta: {},
      },
    ];
    await importYesNo(db, rows);
    expect(await offer(1, { tagReview: false, share: 0.5 })).toMatchObject({
      prompt: 'Is blood shown?',
    });
    expect(await offer(1, { tagReview: false, share: 0 })).toBeNull();
  });

  it('serves nothing to a Templar, and refuses a Templar vote', async () => {
    const id = await createItem();
    expect(await offer(TEMPLAR, { rank: 'Templar' })).toBeNull();
    expect(await vote(TEMPLAR, id, 'yes')).toMatchObject({ status: 'rejected' });
    expect(await state(id)).toMatchObject({ status: 'Open' });
  });

  it.each([
    ['flagged for minor review', `UPDATE "Image" SET "needsReview" = 'minor'`],
    ['flagged as a minor', `UPDATE "Image" SET minor = true`],
    ['flagged as a real person', `UPDATE "Image" SET poi = true`],
    ['flagged for CSAM', `UPDATE "Image" SET "needsReview" = 'csam'`],
    ['listed on a CSAM report', `INSERT INTO "CsamReport" (images) VALUES ('[100]')`],
    ['owned by a user named on a CSAM report', `INSERT INTO "CsamReport" ("userId") VALUES (50)`],
    [
      'under an open report',
      `INSERT INTO "Report" (id, status) VALUES (1, 'Pending'); INSERT INTO "ImageReport" ("imageId", "reportId") VALUES (100, 1)`,
    ],
  ])(
    'pulls an item whose image becomes %s: not served, vote refused, swept unplayable',
    async (_, change) => {
      const id = await createItem();
      expect(await vote(1, id, 'yes')).toEqual({ status: 'recorded' });
      await pg.exec(change);
      expect(await offer(2)).toBeNull();
      expect(await vote(2, id, 'yes')).toMatchObject({ status: 'rejected' });
      await closeStrandedYesNo(db, { now: NOW, maxAgeDays: 14 });
      expect(await state(id)).toMatchObject({ status: 'Closed', reason: 'unplayable' });
    }
  );
});

describe('a re-flagged tag is a new question', () => {
  it('a Paladin who answered episode 1 is served episode 2 and can answer it', async () => {
    const first = await createItem();
    expect(await vote(1, first, 'yes')).toEqual({ status: 'recorded' });
    // A moderator rules, the tick ends episode 1, and the tag is flagged again.
    await enable(100, 10);
    await runTagReview(db, { now: NOW, enabled: true, walk: { after: null } });
    await flag(100, 10);
    await runTagReview(db, { now: NOW, enabled: true, walk: { after: null } });
    const { rows } = await pg.query<{ id: number }>(
      `SELECT id FROM "KnightsQueueItem" WHERE "externalId" = 'mod-tag:100:10:2'`
    );
    const second = rows[0].id;
    expect(await offer(1)).toMatchObject({ itemId: second });
    expect(await vote(1, second, 'no')).toEqual({ status: 'recorded' });
  });

  it('keeps the same-words rule for every other source: a reworded copy of an answered question is refused', async () => {
    const question = (externalId: string): YesNoRow => ({
      externalId,
      imageId: 100,
      axis: 'violence',
      audience: 'players',
      prompt: 'Is blood shown?',
      yesEffect: null,
      noEffect: null,
      meta: {},
    });
    await importYesNo(db, [question('v1'), question('v1-copy')]);
    const { rows } = await pg.query<{ id: number; externalId: string }>(
      `SELECT id, "externalId" FROM "KnightsQueueItem" ORDER BY id`
    );
    expect(await vote(1, rows[0].id, 'yes')).toEqual({ status: 'recorded' });
    expect(await offer(1, { tagReview: false, share: 1 })).toBeNull();
    expect(await vote(1, rows[1].id, 'yes')).toMatchObject({
      status: 'rejected',
      reason: 'already-voted',
    });
  });
});

describe('deciding tag review items (Paladin: 2 unanimous, then 75% to 4)', () => {
  it('four split votes close no-consensus, never to the Inquisitors', async () => {
    const id = await createItem();
    await vote(1, id, 'yes');
    await vote(2, id, 'no');
    await vote(3, id, 'yes');
    await vote(4, id, 'no');
    expect(await state(id)).toMatchObject({ status: 'Closed', reason: 'no-consensus' });
  });

  it('a removal that lowers the rating waits past two "no", then settles at 3-0', async () => {
    const id = await createItem();
    await vote(1, id, 'no');
    await vote(2, id, 'no');
    expect(await state(id)).toMatchObject({ status: 'Open' });
    await vote(3, id, 'no');
    expect(await state(id)).toMatchObject({ status: 'Consensus', resolvedValue: 'no' });
  });

  it('a removal that lowers the rating settles at 3-1', async () => {
    const id = await createItem();
    await vote(1, id, 'no');
    await vote(2, id, 'yes');
    await vote(3, id, 'no');
    expect(await state(id)).toMatchObject({ status: 'Open' });
    await vote(4, id, 'no');
    expect(await state(id)).toMatchObject({ status: 'Consensus', resolvedValue: 'no' });
  });

  it.each([
    ['another enabled tag holds the same level', () => enable(100, 12)],
    ['the image is locked', () => pg.exec(`UPDATE "Image" SET "nsfwLevelLocked" = true`)],
  ])('a removal that leaves the rating settles at 2-0 when %s', async (_, setup) => {
    await setup();
    const id = await createItem();
    await vote(1, id, 'no');
    await vote(2, id, 'no');
    expect(await state(id)).toMatchObject({ status: 'Consensus', resolvedValue: 'no' });
  });

  it('a keep settles at 2-0 even on a tag whose removal would lower the rating', async () => {
    const id = await createItem();
    await vote(1, id, 'yes');
    await vote(2, id, 'yes');
    expect(await state(id)).toMatchObject({ status: 'Consensus', resolvedValue: 'yes' });
  });

  it('reads the rule at vote time: a tag made rating-lowering after creation needs 3', async () => {
    await enable(100, 12);
    const id = await createItem();
    await disable(100, 12);
    await vote(1, id, 'no');
    await vote(2, id, 'no');
    expect(await state(id)).toMatchObject({ status: 'Open' });
  });
});

// Pinned to the real `update_nsfw_levels_new`, loaded from its migration by `bootTagReview` (pglite-kysely.ts): a later
// migration that redefines it must be added to that loader's list.
describe('removalLowersLevel against update_nsfw_levels_new', () => {
  /** What the real function does to the level when the tag is disabled, rolled back afterwards. */
  async function functionLowers(imageId: number, tagId: number) {
    await pg.exec('BEGIN');
    try {
      const before = (
        await pg.query<{ l: number }>(`SELECT "nsfwLevel" l FROM "Image" WHERE id = $1`, [imageId])
      ).rows[0].l;
      await disable(imageId, tagId);
      await pg.query(`SELECT update_nsfw_levels_new(ARRAY[$1::int])`, [imageId]);
      const after = (
        await pg.query<{ l: number }>(`SELECT "nsfwLevel" l FROM "Image" WHERE id = $1`, [imageId])
      ).rows[0].l;
      return after < before;
    } finally {
      await pg.exec('ROLLBACK');
    }
  }

  it.each([
    ['the only rated tag above another, lower one', async () => undefined, true],
    ['a locked image', () => pg.exec(`UPDATE "Image" SET "nsfwLevelLocked" = true`), false],
    [
      'a judge rating at the tag level',
      () => pg.exec(`UPDATE "Image" SET metadata = '{"judgeRating":{"nsfwLevel":${X}}}'`),
      false,
    ],
    [
      'a judge rating between the tags',
      () => pg.exec(`UPDATE "Image" SET metadata = '{"judgeRating":{"nsfwLevel":8}}'`),
      true,
    ],
    ['another enabled tag at the same level', () => enable(100, 12), false],
  ])('agrees with the function for %s', async (_, setup, lowers) => {
    await setup();
    expect(await functionLowers(100, 10)).toBe(lowers);
    expect(await removalLowersLevel(db, 100, 10)).toBe(lowers);
  });

  it('is stricter than the function for an image that is not Scanned, and for one with no other enabled tag', async () => {
    await pg.exec(`UPDATE "Image" SET ingestion = 'Pending'`);
    expect(await functionLowers(100, 10)).toBe(false);
    expect(await removalLowersLevel(db, 100, 10)).toBe(true);

    await pg.exec(
      `UPDATE "Image" SET ingestion = 'Scanned'; DELETE FROM "TagsOnImageNew" WHERE "tagId" = 11`
    );
    expect(await functionLowers(100, 10)).toBe(false);
    expect(await removalLowersLevel(db, 100, 10)).toBe(true);
  });

  it('counts a missing image or a missing tag id as lowering', async () => {
    expect(await removalLowersLevel(db, 999, 10)).toBe(true);
    expect(await removalLowersLevel(db, 100, null)).toBe(true);
  });
});
