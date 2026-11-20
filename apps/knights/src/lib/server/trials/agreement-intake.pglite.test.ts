import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { ensureVotePartitions } from '../queue/queue.service';
import { AGREEMENT_INTAKE, takeAgreementIntake } from './agreement-intake.service';
import { runHarvestJob } from './harvest.service';

const Q = 'knights.image.nsfwLevel';
const NOW = new Date('2026-12-15T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

let pg: PGlite;
let db: Kysely<DB>;

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  await ensureVotePartitions(db, { now: NOW, monthsAhead: 1 });
});
afterAll(() => pg.close());
beforeEach(async () => {
  await pg.exec(
    `TRUNCATE "KnightsReferenceImage","KnightsVote","KnightsQueueItem","KnightsHarvestCursor","ModActivity","Image","Post" RESTART IDENTITY CASCADE`
  );
});

type Verdict = {
  level?: number;
  answers?: string[];
  /** Votes stored at weight 0 (a held player's). */
  heldAnswers?: string[];
  minRank?: string;
  applied?: boolean;
  resolvedHoursAgo?: number;
  imageLevel?: number;
  locked?: boolean;
  published?: boolean;
};

let nextPlayer = 100;
/** A rating item settled at the Knight stage, its votes, and its image as the write-back left it. */
async function verdict(imageId: number, v: Verdict = {}) {
  const level = v.level ?? 4;
  await pg.query(`INSERT INTO "Post" ("id","publishedAt") VALUES ($1,$2)`, [
    imageId,
    v.published === false ? null : '2020-01-01',
  ]);
  await pg.query(
    `INSERT INTO "Image" ("id","url","nsfwLevel","nsfwLevelLocked","postId") VALUES ($1,$2,$3,$4,$1)`,
    [imageId, `key-${imageId}`, v.imageLevel ?? level, v.locked ?? true]
  );
  const resolvedAt = hoursAgo(v.resolvedHoursAgo ?? 2);
  const { rows } = await pg.query<{ id: number }>(
    `INSERT INTO "KnightsQueueItem" ("questionKey","imageId","source","minRank","votesNeeded","status","resolvedValue","resolvedAt","appliedAt")
     VALUES ($1,$2,'test',$3,4,'Resolved',$4,$5,$6) RETURNING id`,
    [
      Q,
      imageId,
      v.minRank ?? 'Knight',
      String(level),
      resolvedAt,
      v.applied === false ? null : resolvedAt,
    ]
  );
  const itemId = rows[0].id;
  const cast = async (answer: string, weight: number) =>
    pg.query(
      `INSERT INTO "KnightsVote" ("itemId","playerId","createdAt","questionKey","imageId","stage","answer","weight")
       VALUES ($1,$2,$3,$4,$5,'Knight',$6,$7)`,
      [itemId, nextPlayer++, hoursAgo(3), Q, imageId, answer, weight]
    );
  for (const answer of v.answers ?? Array(4).fill(String(level))) await cast(answer, 1);
  for (const answer of v.heldAnswers ?? []) await cast(answer, 0);
  return itemId;
}

const ruling = (imageId: number, hours: number, activity = 'setNsfwLevel') =>
  pg.query(
    `INSERT INTO "ModActivity" ("userId","activity","entityType","entityId","createdAt") VALUES (7,$3,'image',$1,$2)`,
    [imageId, hoursAgo(hours), activity]
  );

const references = async () =>
  (
    await pg.query<{
      imageId: number;
      answer: string;
      status: string;
      source: string;
      pool: string;
    }>(`SELECT "imageId",answer,status,source,pool FROM "KnightsReferenceImage" ORDER BY "imageId"`)
  ).rows;

describe('takeAgreementIntake', () => {
  it('never overwrites a mod-confirmed skill check on the same image: the mod-confirmed row wins', async () => {
    await verdict(1, { level: 4, answers: ['4', '4', '4'] });
    await pg.query(
      `INSERT INTO "KnightsReferenceImage" ("imageId","pool","answer","source","questionKey") VALUES (1,'skillCheck','4','inquisitor',$1)`,
      [Q]
    );
    expect(await takeAgreementIntake(db, { now: NOW })).toEqual({ added: 0 });
    expect(await references()).toEqual([
      { imageId: 1, answer: '4', status: 'active', source: 'inquisitor', pool: 'skillCheck' },
    ]);
  });

  it('takes a unanimous Knight verdict of 3+ players in as a probation agreement check', async () => {
    await verdict(1, { level: 4, answers: ['4', '4', '4'] });
    expect(await takeAgreementIntake(db, { now: NOW })).toEqual({ added: 1 });
    expect(await references()).toEqual([
      { imageId: 1, answer: '4', status: 'probation', source: 'agreement', pool: 'hiddenCheck' },
    ]);
  });

  it('skips verdicts that are not unanimous, too thin, overruled, unwritten, moved or already referenced', async () => {
    await verdict(1, { answers: ['4', '4'] });
    await verdict(2, { answers: ['4', '4', '4', '8'] });
    await verdict(3, { heldAnswers: ['8'] });
    await verdict(4);
    await ruling(4, 1);
    await verdict(5, { applied: false });
    await verdict(6, { imageLevel: 8 });
    await verdict(7, { locked: false });
    await verdict(8, { published: false });
    await verdict(9, { minRank: 'Templar' });
    await verdict(10, { resolvedHoursAgo: 24 * (AGREEMENT_INTAKE.maxAgeDays + 1) });
    await verdict(11);
    await pg.query(
      `INSERT INTO "KnightsReferenceImage" ("imageId","pool","answer","source","questionKey") VALUES (11,'trials','4','harvested',$1)`,
      [Q]
    );
    // Held votes count toward unanimity but not toward the players it needs.
    await verdict(13, { answers: ['4', '4'], heldAnswers: ['4'] });
    // A ruling from before the verdict does not overrule it.
    await verdict(12);
    await ruling(12, 5);
    // Knights' own write-back logs setNsfwLevelKono after the verdict; that is not an overrule.
    await verdict(14);
    await ruling(14, 1, 'setNsfwLevelKono');

    await takeAgreementIntake(db, { now: NOW });
    expect(
      (await references()).filter((r) => r.source === 'agreement').map((r) => r.imageId)
    ).toEqual([12, 14]);
  });

  it('fills each level up to the quota of live agreement checks, newest first, and leaves a thin level short', async () => {
    const config = { ...AGREEMENT_INTAKE, probationPerLevel: 2 };
    await verdict(1, { level: 4, resolvedHoursAgo: 3 });
    await verdict(2, { level: 4, resolvedHoursAgo: 1 });
    await verdict(3, { level: 4, resolvedHoursAgo: 2 });
    await verdict(4, { level: 1 });
    await verdict(5, { level: 2, resolvedHoursAgo: 1 });
    await verdict(6, { level: 2, resolvedHoursAgo: 2 });
    // The newest level-4 verdict's image already has a reference: it must not take a slot.
    await verdict(7, { level: 4, resolvedHoursAgo: 0.5 });
    await pg.query(
      `INSERT INTO "KnightsReferenceImage" ("imageId","pool","answer","source","questionKey") VALUES (7,'trials','4','harvested',$1)`,
      [Q]
    );
    // One live and one retired agreement check at PG-13 already: only the live one counts.
    for (const [imageId, status] of [
      [90, 'active'],
      [91, 'retired'],
    ] as const) {
      await pg.query(`INSERT INTO "Post" ("id","publishedAt") VALUES ($1,'2020-01-01')`, [imageId]);
      await pg.query(`INSERT INTO "Image" ("id","url","nsfwLevel","postId") VALUES ($1,'k',2,$1)`, [
        imageId,
      ]);
      await pg.query(
        `INSERT INTO "KnightsReferenceImage" ("imageId","pool","answer","source","questionKey","status") VALUES ($1,'hiddenCheck','2','agreement',$2,$3)`,
        [imageId, Q, status]
      );
    }

    expect(await takeAgreementIntake(db, { now: NOW, config })).toEqual({ added: 4 });
    const taken = (await references())
      .filter((r) => r.status === 'probation')
      .map((r) => r.imageId);
    expect(taken).toEqual([2, 3, 4, 5]);
  });
});

/** One more vote on an item, by `playerId`, at `stage`. */
const extraVote = (
  itemId: number,
  imageId: number,
  playerId: number,
  answer: string,
  stage = 'Knight'
) =>
  pg.query(
    `INSERT INTO "KnightsVote" ("itemId","playerId","createdAt","questionKey","imageId","stage","answer","weight")
     VALUES ($1,$2,$3,$4,$5,$6,$7,1)`,
    [itemId, playerId, hoursAgo(2.5), Q, imageId, stage, answer]
  );
const firstVoter = async (itemId: number) =>
  (
    await pg.query<{ playerId: number }>(
      `SELECT "playerId" FROM "KnightsVote" WHERE "itemId"=$1 ORDER BY "playerId" LIMIT 1`,
      [itemId]
    )
  ).rows[0].playerId;

describe('levels taken in', () => {
  it('takes PG, PG-13 and R verdicts, never X or XXX', async () => {
    for (const [imageId, level] of [
      [1, 1],
      [2, 2],
      [3, 4],
      [4, 8],
      [5, 16],
    ]) {
      await verdict(imageId, { level });
    }
    await takeAgreementIntake(db, { now: NOW });
    expect((await references()).map((r) => r.imageId)).toEqual([1, 2, 3]);
  });
});

describe('what counts toward a unanimous verdict', () => {
  it('counts distinct players at the Knight stage, and only on a resolved item', async () => {
    // 2 players, one of them voting twice: too few.
    const twice = await verdict(1, { answers: ['4', '4'] });
    await extraVote(twice, 1, await firstVoter(twice), '4');
    // A dissent from another stage does not break a Knight verdict.
    const otherStage = await verdict(2);
    await extraVote(otherStage, 2, 900, '8', 'Templar');
    // Votes from another stage do not make up the Knight players.
    const padded = await verdict(3, { answers: ['4', '4'] });
    await extraVote(padded, 3, 901, '4', 'Templar');
    await extraVote(padded, 3, 902, '4', 'Templar');
    // Written back but no longer resolved.
    const reopened = await verdict(4);
    await pg.query(`UPDATE "KnightsQueueItem" SET status='Inquisitor' WHERE id=$1`, [reopened]);

    await takeAgreementIntake(db, { now: NOW });
    expect((await references()).map((r) => r.imageId)).toEqual([2]);
  });
});

describe('the harvest job', () => {
  it('takes agreement verdicts and reviews probation while running, and only reviews while paused', async () => {
    await verdict(1);
    // A probation check whose image has since moved level is retired like any other fresh reference.
    await pg.query(`INSERT INTO "Post" ("id","publishedAt") VALUES (60,'2020-01-01')`);
    await pg.query(
      `INSERT INTO "Image" ("id","url","nsfwLevel","nsfwLevelLocked","postId") VALUES (60,'k',8,true,60)`
    );
    await pg.query(
      `INSERT INTO "KnightsReferenceImage" ("imageId","pool","answer","source","questionKey","status","harvestedAt") VALUES (60,'hiddenCheck','4','agreement',$1,'probation',$2)`,
      [Q, NOW.toISOString()]
    );
    const paused = await runHarvestJob(db, {
      now: NOW,
      settings: { paused: true, hiddenCheckShare: 0 },
      probationShare: 0.5,
    });
    expect(paused).toEqual({ paused: true, retired: 1, probation: { promoted: 0, retired: 0 } });
    expect((await references()).map((r) => [r.imageId, r.status])).toEqual([[60, 'retired']]);

    // A probation check 5 players answered exactly is promoted even while paused.
    await pg.query(`INSERT INTO "Post" ("id","publishedAt") VALUES (50,'2020-01-01')`);
    await pg.query(
      `INSERT INTO "Image" ("id","url","nsfwLevel","nsfwLevelLocked","postId") VALUES (50,'k',4,true,50)`
    );
    const { rows } = await pg.query<{ id: number }>(
      `INSERT INTO "KnightsReferenceImage" ("imageId","pool","answer","source","questionKey","status","harvestedAt") VALUES (50,'hiddenCheck','4','agreement',$1,'probation',$2) RETURNING id`,
      [Q, NOW.toISOString()]
    );
    for (let p = 500; p < 505; p++) {
      await pg.query(
        `INSERT INTO "KnightsVote" ("itemId","playerId","createdAt","questionKey","imageId","stage","answer","weight") VALUES ($1,$2,$3,$4,50,'Knight','4',1)`,
        [-rows[0].id, p, NOW.toISOString(), Q]
      );
    }
    expect(
      await runHarvestJob(db, { now: NOW, settings: { paused: true, hiddenCheckShare: 0 } })
    ).toMatchObject({ paused: true, probation: { promoted: 1, retired: 0 } });

    // Running with no probation share: no agreement verdict is taken in.
    expect(
      await runHarvestJob(db, { now: NOW, settings: { paused: false, hiddenCheckShare: 0 } })
    ).toMatchObject({ agreementAdded: 0 });
    expect((await references()).some((r) => r.imageId === 1)).toBe(false);

    expect(
      await runHarvestJob(db, {
        now: NOW,
        settings: { paused: false, hiddenCheckShare: 0 },
        probationShare: 0.5,
      })
    ).toMatchObject({ agreementAdded: 1 });
    expect((await references()).map((r) => [r.imageId, r.status])).toEqual([
      [1, 'probation'],
      [50, 'active'],
      [60, 'retired'],
    ]);
  });
});
