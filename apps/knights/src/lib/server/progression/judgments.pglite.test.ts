import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { seedImage } from '../../../test/seed';
import {
  castVote,
  enqueueItem,
  ensureVotePartitions,
  type QueueDeps,
} from '../queue/queue.service';
import { PROGRESSION } from './config';
import { JUDGMENT_FILTERS, listJudgments, type JudgmentFilter } from './judgments';

const NOW = new Date('2026-12-15T12:00:00Z');
let pg: PGlite;
let db: Kysely<DB>;
const applyConsensus = vi.fn<QueueDeps['applyConsensus']>(async () => ({ outcome: 'applied' }));
const depsAt = (now: Date): QueueDeps => ({ applyConsensus, now: () => now });

async function judge(imageId: number, at: Date, userId = 1) {
  await seedImage(pg, imageId);
  const id = await enqueueItem(
    db,
    { questionKey: 'knights.image.nsfwLevel', imageId, source: 'test', expiresAt: null },
    NOW
  );
  await castVote(db, { userId, itemId: id, answer: '4' }, depsAt(at));
  return id;
}

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  await ensureVotePartitions(db, { now: NOW, monthsAhead: 1 });
});
afterAll(async () => {
  await pg.close();
});
beforeEach(async () => {
  await pg.exec(
    `TRUNCATE "KnightsVote","KnightsQueueItem","NewOrderPlayer","NewOrderSmite","Image","Post","KnightsApprenticeAnswer","KnightsYesNoReference","KnightsReferenceImage" RESTART IDENTITY`
  );
  await pg.exec(
    `INSERT INTO "NewOrderPlayer" ("userId","rankType") VALUES (1,'Knight'),(2,'Knight')`
  );
});

describe('listJudgments', () => {
  it('lists only my votes, newest first, with the answer label and what each paid', async () => {
    const older = await judge(10, new Date('2026-12-15T10:00:00Z'));
    const newer = await judge(11, new Date('2026-12-15T11:00:00Z'));
    await judge(12, new Date('2026-12-15T11:30:00Z'), 2);

    const { judgments, hasMore } = await listJudgments(db, 1, { page: 1 });

    expect(hasMore).toBe(false);
    expect(judgments.map((j) => j.itemId)).toEqual([newer, older]);
    expect(judgments[0]).toMatchObject({
      imageKey: 'key-11',
      status: 'pending',
      xp: PROGRESSION.voteXp,
      gold: PROGRESSION.baseGold,
    });
    expect(judgments[0].answerLabel).not.toBe('4');
  });

  it('pages and reports whether older votes remain', async () => {
    for (let i = 0; i < 3; i++) await judge(10 + i, new Date(`2026-12-15T1${i}:00:00Z`));

    const first = await listJudgments(db, 1, { page: 1, pageSize: 2 });
    const second = await listJudgments(db, 1, { page: 2, pageSize: 2 });

    expect(first.judgments).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(second.judgments).toHaveLength(1);
    expect(second.hasMore).toBe(false);
  });

  it('hides the thumbnail of an image that is no longer servable and maps the verdicts', async () => {
    const id = await judge(10, NOW);
    await pg.exec(`UPDATE "Image" SET "blockedFor"='x'`);
    await pg.exec(
      `UPDATE "KnightsVote" SET verdict='failed', "settledAt"=now() WHERE "itemId"=${id}`
    );

    const [row] = (await listJudgments(db, 1, { page: 1 })).judgments;

    expect(row.imageKey).toBeNull();
    expect(row.status).toBe('wrong');
  });

  it('shows a vote as pending until it is settled, even once graded', async () => {
    const id = await judge(10, NOW);
    await pg.exec(`UPDATE "KnightsVote" SET verdict='correct' WHERE "itemId"=${id}`);
    expect((await listJudgments(db, 1, { page: 1 })).judgments[0].status).toBe('pending');

    await pg.exec(`UPDATE "KnightsVote" SET "settledAt"=now() WHERE "itemId"=${id}`);
    expect((await listJudgments(db, 1, { page: 1 })).judgments[0].status).toBe('correct');
  });

  describe('after a career reset', () => {
    it('shows a vote cast before the reset as forfeited, with no gold promised, and later ones as usual', async () => {
      const before = await judge(10, new Date('2026-12-15T09:00:00Z'));
      const after = await judge(11, new Date('2026-12-15T11:00:00Z'));
      await pg.exec(
        `UPDATE "NewOrderPlayer" SET "startAt"='2026-12-15T10:00:00Z' WHERE "userId"=1`
      );

      const byItem = new Map(
        (await listJudgments(db, 1, { page: 1 })).judgments.map((j) => [j.itemId, j])
      );

      expect(byItem.get(before)).toMatchObject({ status: 'forfeited', gold: 0 });
      expect(byItem.get(after)).toMatchObject({ status: 'pending', gold: PROGRESSION.baseGold });
    });

    it('keeps a settled pre-reset vote forfeited when it was graded right, but not when it was wrong', async () => {
      const right = await judge(10, new Date('2026-12-15T08:00:00Z'));
      const wrong = await judge(11, new Date('2026-12-15T09:00:00Z'));
      await pg.exec(
        `UPDATE "KnightsVote" SET verdict='correct', "settledAt"=now(), gold=0 WHERE "itemId"=${right}`
      );
      await pg.exec(
        `UPDATE "KnightsVote" SET verdict='failed', "settledAt"=now(), gold=0 WHERE "itemId"=${wrong}`
      );
      await pg.exec(
        `UPDATE "NewOrderPlayer" SET "startAt"='2026-12-15T10:00:00Z' WHERE "userId"=1`
      );

      const byItem = new Map(
        (await listJudgments(db, 1, { page: 1 })).judgments.map((j) => [j.itemId, j.status])
      );

      expect(byItem.get(right)).toBe('forfeited');
      expect(byItem.get(wrong)).toBe('wrong');
    });
  });

  describe('status filter', () => {
    it('filters in the query and pages within the filter', async () => {
      const ids: number[] = [];
      for (let i = 0; i < 5; i++)
        ids.push(await judge(10 + i, new Date(`2026-12-15T0${i}:00:00Z`)));
      await pg.exec(
        `UPDATE "KnightsVote" SET verdict='correct', "settledAt"=now() WHERE "itemId" IN (${ids[0]},${ids[1]},${ids[2]})`
      );
      await pg.exec(
        `UPDATE "KnightsVote" SET verdict='failed', "settledAt"=now() WHERE "itemId"=${ids[3]}`
      );

      const ofFilter = async (filter: JudgmentFilter, pageSize = 20, page = 1) =>
        (await listJudgments(db, 1, { page, pageSize, filter })).judgments.map((j) => j.itemId);

      expect(await ofFilter('all')).toHaveLength(5);
      expect(await ofFilter('correct')).toEqual([ids[2], ids[1], ids[0]]);
      expect(await ofFilter('correct', 2, 2)).toEqual([ids[0]]);
      expect(await ofFilter('wrong')).toEqual([ids[3]]);
      expect(await ofFilter('pending')).toEqual([ids[4]]);
      expect(await ofFilter('inconclusive')).toEqual([]);
      expect(await ofFilter('forfeited')).toEqual([]);
    });

    it('keeps SQL and display in step: every row a filter returns shows that status', async () => {
      const at = (h: number) => new Date(`2026-12-15T${String(h).padStart(2, '0')}:00:00Z`);
      const ids: number[] = [];
      for (let i = 0; i < 8; i++) ids.push(await judge(10 + i, at(i)));
      const set = (verdict: string, settled: boolean, ...items: number[]) =>
        pg.exec(
          `UPDATE "KnightsVote" SET verdict='${verdict}', "settledAt"=${
            settled ? 'now()' : 'NULL'
          } WHERE "itemId" IN (${items.join(',')})`
        );
      // 0-3 are cast before the reset at 04:00, 4-7 after it.
      await set('correct', true, ids[0], ids[4]);
      await set('failed', true, ids[1], ids[5]);
      await set('inconclusive', true, ids[2], ids[6]);
      await set('correct', false, ids[3]); // graded but unsettled, still pending
      await pg.exec(
        `UPDATE "NewOrderPlayer" SET "startAt"='2026-12-15T03:30:00Z' WHERE "userId"=1`
      );

      const all = (await listJudgments(db, 1, { page: 1 })).judgments;
      expect(new Set(all.map((j) => j.status))).toEqual(
        new Set(['forfeited', 'correct', 'wrong', 'inconclusive', 'pending'])
      );

      for (const filter of JUDGMENT_FILTERS) {
        const rows = (await listJudgments(db, 1, { page: 1, filter })).judgments;
        const expected = all.filter((j) => filter === 'all' || j.status === filter);
        expect(rows.map((j) => j.itemId)).toEqual(expected.map((j) => j.itemId));
        for (const row of rows) if (filter !== 'all') expect(row.status).toBe(filter);
      }
    });

    it('excludes a correct vote cast before the reset from correct and returns it as forfeited', async () => {
      const before = await judge(10, new Date('2026-12-15T09:00:00Z'));
      const after = await judge(11, new Date('2026-12-15T11:00:00Z'));
      await pg.exec(
        `UPDATE "KnightsVote" SET verdict='correct', "settledAt"=now() WHERE "itemId" IN (${before},${after})`
      );
      await pg.exec(
        `UPDATE "NewOrderPlayer" SET "startAt"='2026-12-15T10:00:00Z' WHERE "userId"=1`
      );

      const ids = async (filter: JudgmentFilter) =>
        (await listJudgments(db, 1, { page: 1, filter })).judgments.map((j) => j.itemId);

      expect(await ids('correct')).toEqual([after]);
      expect(await ids('forfeited')).toEqual([before]);
    });

    it('moves a pre-reset vote from pending to forfeited', async () => {
      const id = await judge(10, new Date('2026-12-15T09:00:00Z'));
      await pg.exec(
        `UPDATE "NewOrderPlayer" SET "startAt"='2026-12-15T10:00:00Z' WHERE "userId"=1`
      );

      const ids = async (filter: JudgmentFilter) =>
        (await listJudgments(db, 1, { page: 1, filter })).judgments.map((j) => j.itemId);

      expect(await ids('pending')).toEqual([]);
      expect(await ids('forfeited')).toEqual([id]);
    });
  });

  describe('the verdict', () => {
    const settle = async (id: number, verdict: string, resolved: string | null) => {
      await pg.exec(
        `UPDATE "KnightsVote" SET verdict='${verdict}', "settledAt"=now() WHERE "itemId"=${id}`
      );
      await pg.exec(
        `UPDATE "KnightsQueueItem" SET status='Resolved', "appliedAt"=now(), "resolvedValue"=${
          resolved ? `'${resolved}'` : 'NULL'
        } WHERE id=${id}`
      );
    };

    it('names the settled answer on a wrong vote only', async () => {
      const wrong = await judge(10, new Date('2026-12-15T09:00:00Z'));
      const right = await judge(11, new Date('2026-12-15T10:00:00Z'));
      const open = await judge(12, new Date('2026-12-15T11:00:00Z'));
      await pg.exec(`UPDATE "KnightsQueueItem" SET "resolvedValue"='2' WHERE id=${open}`);
      await settle(wrong, 'failed', '2');
      await settle(right, 'correct', '4');

      const byItem = new Map(
        (await listJudgments(db, 1, { page: 1 })).judgments.map((j) => [j.itemId, j])
      );

      expect(byItem.get(wrong)?.verdictLabel).toBeTruthy();
      expect(byItem.get(wrong)?.verdictLabel).not.toBe(byItem.get(wrong)?.answerLabel);
      expect(byItem.get(right)?.verdictLabel).toBeNull();
      expect(byItem.get(open)?.verdictLabel).toBeNull();
    });

    it('says nothing about a hidden check, which has no queue item', async () => {
      await seedImage(pg, 40);
      await pg.exec(
        `INSERT INTO "KnightsVote" ("itemId","playerId","createdAt","questionKey","imageId","stage","answer","weight","gold","xp","verdict","settledAt")
         VALUES (-7,1,now(),'knights.image.nsfwLevel',40,'Knight','4',1,100,10,'failed',now())`
      );

      const [row] = (await listJudgments(db, 1, { page: 1 })).judgments;

      expect(row).toMatchObject({ status: 'wrong', verdictLabel: null });
    });
  });

  describe('apprenticeship answers', () => {
    it('lists rating and yes/no practice answers with their XP and the right answer', async () => {
      await seedImage(pg, 60);
      await seedImage(pg, 61);
      await pg.exec(
        `INSERT INTO "KnightsQuestion" ("key","kind","prompt","options") VALUES ('knights.yesno.practice','bool','Does this show violence?','[]') ON CONFLICT DO NOTHING`
      );
      const rating = await pg.query<{ id: number }>(
        `INSERT INTO "KnightsReferenceImage" ("imageId","pool","answer","source") VALUES (60,'trials','2','harvested') RETURNING id`
      );
      const yesNo = await pg.query<{ id: number }>(
        `INSERT INTO "KnightsYesNoReference" ("imageId","questionKey","answer","createdBy") VALUES (61,'knights.yesno.practice',true,1) RETURNING id`
      );
      await pg.query(
        `INSERT INTO "KnightsApprenticeAnswer" ("playerId","referenceId","answer","correctAnswer","correct","xp","createdAt") VALUES (1,$1,'4','2',false,0,'2026-12-15T08:00:00Z')`,
        [rating.rows[0].id]
      );
      await pg.query(
        `INSERT INTO "KnightsApprenticeAnswer" ("playerId","yesNoReferenceId","answer","correctAnswer","correct","xp","createdAt") VALUES (1,$1,'yes','yes',true,100,'2026-12-15T09:00:00Z')`,
        [yesNo.rows[0].id]
      );

      const { judgments } = await listJudgments(db, 1, { page: 1 });

      expect(judgments.map((j) => [j.kind, j.status, j.xp, j.answerLabel])).toEqual([
        ['practice', 'correct', 100, 'Yes'],
        ['practice', 'wrong', 0, 'R'],
      ]);
      expect(judgments[0].prompt).toBe('Does this show violence?');
      expect(judgments[1].verdictLabel).toBe('PG-13');
      expect(judgments[0].imageKey).toBe('key-61');
    });

    it("shows the pair's own question in an Acolyte's history, and the axis question when it has none or a blank one", async () => {
      await pg.exec(
        `INSERT INTO "KnightsQuestion" ("key","kind","prompt","options") VALUES ('knights.yesno.practice','bool','Does this show violence?','[]') ON CONFLICT DO NOTHING`
      );
      const prompts = ['Is a knife held in the hand?', null, '   '];
      for (const [index, prompt] of prompts.entries()) {
        const imageId = 80 + index;
        await seedImage(pg, imageId);
        const pair = await pg.query<{ id: number }>(
          `INSERT INTO "KnightsYesNoReference" ("imageId","questionKey","answer","createdBy","prompt") VALUES ($1,'knights.yesno.practice',true,1,$2) RETURNING id`,
          [imageId, prompt]
        );
        await pg.query(
          `INSERT INTO "KnightsApprenticeAnswer" ("playerId","yesNoReferenceId","answer","correctAnswer","correct","xp","createdAt") VALUES (1,$1,'yes','yes',true,100,$2)`,
          [pair.rows[0].id, new Date(Date.UTC(2026, 11, 15, 9, index))]
        );
      }

      const { judgments } = await listJudgments(db, 1, { page: 1 });

      expect(judgments.map((j) => j.prompt)).toEqual([
        'Does this show violence?',
        'Does this show violence?',
        'Is a knife held in the hand?',
      ]);
    });

    it('keeps listing an answer after its reference is deleted', async () => {
      await seedImage(pg, 70);
      await pg.exec(
        `INSERT INTO "KnightsQuestion" ("key","kind","prompt","options") VALUES ('knights.yesno.practice','bool','Does this show violence?','[]') ON CONFLICT DO NOTHING`
      );
      const yesNo = await pg.query<{ id: number }>(
        `INSERT INTO "KnightsYesNoReference" ("imageId","questionKey","answer","createdBy") VALUES (70,'knights.yesno.practice',true,1) RETURNING id`
      );
      await pg.query(
        `INSERT INTO "KnightsApprenticeAnswer" ("playerId","yesNoReferenceId","imageId","questionKey","answer","correctAnswer","correct","xp","createdAt") VALUES (1,$1,70,'knights.yesno.practice','yes','yes',true,100,'2026-12-15T09:00:00Z')`,
        [yesNo.rows[0].id]
      );
      await pg.query(`DELETE FROM "KnightsYesNoReference" WHERE "id"=$1`, [yesNo.rows[0].id]);

      const { judgments } = await listJudgments(db, 1, { page: 1 });

      expect(judgments).toHaveLength(1);
      expect(judgments[0]).toMatchObject({
        kind: 'practice',
        status: 'correct',
        answerLabel: 'Yes',
        imageKey: 'key-70',
      });
    });
  });

  describe('yes/no answers', () => {
    const NOW2 = new Date('2026-12-15T12:00:00Z');
    async function answered(externalId: string, prompt: string) {
      await seedImage(pg, 30);
      await pg.exec(
        `INSERT INTO "KnightsQuestion" ("key","kind","prompt","options") VALUES ('knights.yesno.violence','bool','Generic words','[{"value":"yes","label":"Yes"},{"value":"no","label":"No"}]') ON CONFLICT DO NOTHING`
      );
      const item = await pg.query<{ id: number }>(
        `INSERT INTO "KnightsQueueItem" ("questionKey","imageId","source","minRank","votesNeeded","externalId","audience","prompt","yesEffect","noEffect","updatedAt")
         VALUES ('knights.yesno.violence',30,'t','Knight',5,$1,'players',$2,'R4','R3',now()) RETURNING id`,
        [externalId, prompt]
      );
      await pg.query(
        `INSERT INTO "KnightsVote" ("itemId","playerId","createdAt","questionKey","imageId","stage","answer","weight","gold","xp")
         VALUES ($1,1,$2,'knights.yesno.violence',30,'Knight','yes',1,100,10)`,
        [item.rows[0].id, NOW2]
      );
      return item.rows[0].id;
    }

    it('shows the words of the question, waits for the consensus, then shows it as right or wrong like a rating', async () => {
      const id = await answered('q-secret', 'Is a hat worn?');

      const pending = (await listJudgments(db, 1, { page: 1 })).judgments[0];
      expect(pending).toMatchObject({
        prompt: 'Is a hat worn?',
        answerLabel: 'Yes',
        status: 'pending',
        gold: 100,
      });

      await pg.exec(
        `UPDATE "KnightsVote" SET verdict='correct', "settledAt"=now() WHERE "itemId"=${id}`
      );
      expect((await listJudgments(db, 1, { page: 1 })).judgments[0].status).toBe('correct');

      await pg.exec(`UPDATE "KnightsVote" SET verdict='failed', gold=0 WHERE "itemId"=${id}`);
      expect((await listJudgments(db, 1, { page: 1 })).judgments[0]).toMatchObject({
        status: 'wrong',
        gold: 0,
      });
    });

    it('carries nothing of the question that a player must not see', async () => {
      await answered('q-secret', 'Is a hat worn?');
      const text = JSON.stringify((await listJudgments(db, 1, { page: 1 })).judgments);
      for (const secret of ['q-secret', 'R4', 'R3', 'Effect', 'externalId']) {
        expect(text).not.toContain(secret);
      }
    });
  });
});
