import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { runLabelPass } from '../conversion/label-pass';
import { bootLabelStore, createQueueDb } from '../../../test/pglite-kysely';
import { seedImage, seedPlayer } from '../../../test/seed';
import { ensureVotePartitions } from '../queue/queue.service';
import { importYesNo, type YesNoRow } from './import';
import { castYesNoVote } from './vote';

const NOW = new Date('2026-12-21T12:00:00Z');
const ID = 'q-0123abcd';

let pg: PGlite;
let db: Kysely<DB>;
let clock = NOW;

const row = (id: string, imageId: number, o: Partial<YesNoRow> = {}): YesNoRow => ({
  externalId: id,
  imageId,
  axis: 'violence',
  audience: 'players',
  prompt: 'Is a hat worn?',
  yesEffect: 'R4',
  noEffect: 'R3',
  meta: {},
  ...o,
});
const itemOf = async (externalId: string) =>
  (
    await pg.query<{ id: number }>(`SELECT id FROM "KnightsQueueItem" WHERE "externalId"=$1`, [
      externalId,
    ])
  ).rows[0].id;
const answer = async (playerId: number, externalId: string, value: string) => {
  clock = new Date(clock.getTime() + 1000);
  const result = await castYesNoVote(
    db,
    { userId: playerId, itemId: await itemOf(externalId), answer: value },
    { now: () => clock }
  );
  expect(result).toEqual({ status: 'recorded' });
};
const pass = () => runLabelPass(db, { now: new Date('2026-12-30T00:00:00Z') });
const labels = async () =>
  (
    await pg.query<{
      sourceRef: string;
      value: string;
      question: string;
      labellerKind: string;
      family: string;
      subjectId: string;
    }>(
      `SELECT l."sourceRef", l."value", l."question", l."labellerKind", l."family", s."subjectId"
       FROM label_store.label l JOIN label_store.subject s ON s."id" = l."subjectId" ORDER BY l."id"`
    )
  ).rows;
const labelledFlags = async () =>
  (
    await pg.query<{ labelled: boolean }>(`SELECT labelled FROM "KnightsVote" ORDER BY "playerId"`)
  ).rows.map((r) => r.labelled);

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  await bootLabelStore(pg);
  await ensureVotePartitions(db, { now: NOW, monthsAhead: 1 });
}, 120_000);
afterAll(() => pg.close());
beforeEach(async () => {
  clock = NOW;
  await pg.exec(
    `TRUNCATE "KnightsVote","KnightsQueueItem","KnightsPlayerDay","NewOrderPlayer","Image","Post","User" RESTART IDENTITY CASCADE;
     DELETE FROM "KnightsQuestion" WHERE key LIKE 'knights.yesno.%';
     TRUNCATE label_store.subject, label_store.erased_subject, label_store.record_failure CASCADE;
     DELETE FROM label_store.rule WHERE "question" LIKE 'knights.yesno.%'`
  );
  await seedImage(pg, 10);
  await seedImage(pg, 11);
});

describe('labels for yes/no answers', () => {
  it('writes one knight label per answer under the producer question id, on the tick, and never again', async () => {
    await importYesNo(db, [row(ID, 10)]);
    for (const p of [1, 2]) await seedPlayer(pg, p);
    await answer(1, ID, 'yes');
    await answer(2, ID, 'no');

    expect(await pass()).toMatchObject({ done: true, labelsWritten: 2, labelFailures: 0 });

    const written = await labels();
    expect(written).toHaveLength(2);
    expect(
      written.map((l) => [l.value, l.question, l.labellerKind, l.family, l.subjectId])
    ).toEqual([
      ['yes', `knights.yesno.${ID}`, 'knight', 'knights', '10'],
      ['no', `knights.yesno.${ID}`, 'knight', 'knights', '10'],
    ]);
    expect(new Set(written.map((l) => l.sourceRef)).size).toBe(2);
    for (const l of written) {
      expect(l.sourceRef).toMatch(new RegExp(`^KnightsYesNoVote:${ID}:`));
      expect(l.sourceRef).not.toMatch(/:[12]$/); // the player is only the store's own hash
    }
    expect(await labelledFlags()).toEqual([true, true]);

    expect(await pass()).toMatchObject({ labelsWritten: 0 });
    expect(await labels()).toHaveLength(2);
  });

  it('writes the label before the question has a consensus', async () => {
    await importYesNo(db, [row(ID, 10)]);
    for (const p of [1, 2]) await seedPlayer(pg, p);
    await answer(1, ID, 'yes');

    await pass();
    expect((await labels()).map((l) => l.value)).toEqual(['yes']);

    await answer(2, ID, 'yes');
    await pass();
    expect(await labels()).toHaveLength(2);
  });

  it('lets the label store compute the majority once the question has enough answers', async () => {
    await importYesNo(db, [row(ID, 10)]);
    for (let p = 1; p <= 5; p++) await seedPlayer(pg, p);
    for (const [p, a] of [
      [1, 'yes'],
      [2, 'yes'],
      [3, 'no'],
      [4, 'yes'],
      [5, 'no'],
    ] as const) {
      await answer(p, ID, a);
    }

    await pass();

    const consensus = await pg.query(
      `SELECT "question","outcome","humanLabels","agreeing","rule","trainable" FROM label_store.consensus WHERE "question" LIKE 'knights.yesno.%'`
    );
    expect(consensus.rows).toEqual([
      {
        question: `knights.yesno.${ID}`,
        outcome: 'yes',
        humanLabels: 5,
        agreeing: 3,
        rule: 'min5-majority',
        trainable: true,
      },
    ]);
  });

  it('keeps overlapping questions apart: each id is its own question, with its own rule and consensus', async () => {
    await importYesNo(db, [row('q-a', 10), row('q-b', 10)]);
    for (const p of [1, 2]) await seedPlayer(pg, p);
    await answer(1, 'q-a', 'yes');
    await answer(2, 'q-b', 'no');

    await pass();

    expect((await labels()).map((l) => [l.question, l.value])).toEqual([
      ['knights.yesno.q-a', 'yes'],
      ['knights.yesno.q-b', 'no'],
    ]);
    const consensus = await pg.query(
      `SELECT "question","humanLabels","trainable" FROM label_store.consensus WHERE "question" LIKE 'knights.yesno.%' ORDER BY "question"`
    );
    expect(consensus.rows).toEqual([
      { question: 'knights.yesno.q-a', humanLabels: 1, trainable: false },
      { question: 'knights.yesno.q-b', humanLabels: 1, trainable: false },
    ]);
  });

  it('skips a held player and labels their answers once they are released', async () => {
    await importYesNo(db, [row(ID, 10)]);
    for (const p of [1, 2]) await seedPlayer(pg, p);
    await answer(1, ID, 'yes');
    await answer(2, ID, 'no');
    await pg.exec(`UPDATE "NewOrderPlayer" SET "payoutBlockedAt"='2026-12-21' WHERE "userId"=1`);

    await pass();
    expect((await labels()).map((l) => l.value)).toEqual(['no']);

    await pg.exec(`UPDATE "NewOrderPlayer" SET "payoutBlockedAt"=NULL WHERE "userId"=1`);
    await pass();
    expect((await labels()).map((l) => l.value).sort()).toEqual(['no', 'yes']);
  });

  it('writes no labels for a rating vote through this path and no yes/no rule for a question nobody answered', async () => {
    await importYesNo(db, [row(ID, 10), row('q-unanswered', 11)]);
    await seedPlayer(pg, 1);
    await answer(1, ID, 'yes');
    await pass();

    const rules = await pg.query<{ question: string; minHuman: number; requireUnanimous: boolean }>(
      `SELECT "question","minHuman","requireUnanimous" FROM label_store.rule WHERE "question" LIKE 'knights.yesno.%'`
    );
    expect(rules.rows).toEqual([
      { question: `knights.yesno.${ID}`, minHuman: 5, requireUnanimous: false },
    ]);
  });

  it('writes the other answers of a batch when the store raises for one, and records the failure', async () => {
    const personHash = (guard: string) => `
      CREATE OR REPLACE FUNCTION label_store.person_hash(p_kind TEXT, p_user_id INTEGER)
      RETURNS TEXT LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = label_store, pg_temp AS $$
      BEGIN
        ${guard}
        RETURN (SELECT encode(sha256(convert_to(s."key" || ':' || p_kind || ':' || p_user_id, 'UTF8')), 'hex')
                FROM label_store.secret s);
      END $$`;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await importYesNo(db, [row(ID, 10)]);
    for (const p of [1, 2, 3]) await seedPlayer(pg, p);
    for (const p of [1, 2, 3]) await answer(p, ID, 'yes');
    await pg.exec(personHash(`IF p_user_id = 2 THEN RAISE EXCEPTION 'boom'; END IF;`));
    try {
      expect(await pass()).toMatchObject({ done: true, labelsWritten: 2, labelFailures: 1 });
      expect(await labelledFlags()).toEqual([true, false, true]);
    } finally {
      await pg.exec(personHash(''));
    }
  });
});
