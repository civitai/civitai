import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { seedImage, seedPlayer } from '../../../test/seed';
import { ensureVotePartitions } from '../queue/queue.service';
import { castYesNoVote } from './vote';
import { parseCsv } from './csv';
import { importYesNo, toYesNoRows } from './import';

const HEADER =
  'question_id,case_id,image_id,axis,kind,question,yes_effect,no_effect,active_candidate,source_batch_id,source_purpose,promotion_status,policy_sha256';
const line = (o: Partial<Record<string, string>> & { id: string }) =>
  [
    o.id,
    o.case ?? 'c1',
    o.image ?? '10',
    o.axis ?? 'violence',
    o.kind ?? 'observable',
    o.question ?? 'Is a hat worn?',
    o.yes ?? 'R4',
    o.no ?? 'R3',
    o.active ?? 'true',
    'b1',
    'audit',
    'unadjudicated',
    'abc',
  ]
    .map((v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v))
    .join(',');
const records = (...lines: string[]) => parseCsv([HEADER, ...lines].join('\n'));
const load = (...lines: string[]) => toYesNoRows(records(...lines)).rows;

let pg: PGlite;
let db: Kysely<DB>;

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
});
afterAll(async () => {
  await pg.close();
});
beforeEach(async () => {
  await pg.exec(
    `TRUNCATE "KnightsQueueItem" RESTART IDENTITY; DELETE FROM "KnightsQuestion" WHERE key LIKE 'knights.yesno.%'`
  );
});

const items = async () =>
  (
    await pg.query<Record<string, unknown>>(
      `SELECT * FROM "KnightsQueueItem" ORDER BY "externalId"`
    )
  ).rows;

describe('toYesNoRows', () => {
  it('keeps active candidates, sends policy questions to moderators, and counts what it skips', () => {
    const { rows, skipped } = toYesNoRows(
      records(
        line({ id: 'a' }),
        line({ id: 'b', kind: 'policy_preference' }),
        line({ id: 'c', active: 'false' }),
        line({ id: 'a' }),
        line({ id: 'd', image: 'x' }),
        line({ id: 'e', axis: 'Bad Axis!' }),
        line({ id: 'f', kind: 'other' }),
        line({ id: 'g', question: '  ' })
      )
    );
    expect(rows.map((r) => [r.externalId, r.audience])).toEqual([
      ['a', 'players'],
      ['b', 'moderators'],
    ]);
    expect(skipped).toEqual({
      inactive: 1,
      duplicate: 1,
      'bad-image': 1,
      'bad-axis': 1,
      'bad-kind': 1,
      'bad-question': 1,
    });
  });
});

const MIGRATION = fileURLToPath(
  new URL(
    '../../../../../../packages/civitai-db-schema/prisma/migrations/20261221120000_knights_v2_yesno/migration.sql',
    import.meta.url
  )
);

describe('importYesNo', () => {
  it('rests on a migration that can be applied twice', async () => {
    await pg.exec(readFileSync(MIGRATION, 'utf8'));
    await pg.exec(readFileSync(MIGRATION, 'utf8'));
  });

  it('creates one bool question per axis and an open item per question id, with the effects kept apart', async () => {
    const result = await importYesNo(
      db,
      load(line({ id: 'a' }), line({ id: 'b', axis: 'language' }), line({ id: 'c', image: '10' }))
    );
    expect(result).toEqual({
      inserted: 3,
      updated: 0,
      unchanged: 0,
      refused: 0,
      retired: 0,
      axes: 2,
    });

    const questions = (
      await pg.query<{ key: string; kind: string }>(
        `SELECT key, kind FROM "KnightsQuestion" WHERE key LIKE 'knights.yesno.%' ORDER BY key`
      )
    ).rows;
    expect(questions).toEqual([
      { key: 'knights.yesno.language', kind: 'bool' },
      { key: 'knights.yesno.violence', kind: 'bool' },
    ]);

    const [a, , c] = await items();
    expect(a).toMatchObject({
      externalId: 'a',
      questionKey: 'knights.yesno.violence',
      imageId: 10,
      status: 'Open',
      audience: 'players',
      prompt: 'Is a hat worn?',
      yesEffect: 'R4',
      noEffect: 'R3',
      voteCount: 0,
      minRank: 'Knight',
      votesNeeded: 5,
    });
    // Two questions on the same image and axis are two items.
    expect(c).toMatchObject({ externalId: 'c', imageId: 10 });
  });

  it('is idempotent and updates only what changed on a question nobody has answered', async () => {
    const first = load(line({ id: 'a' }), line({ id: 'b' }));
    await importYesNo(db, first);
    expect(await importYesNo(db, first)).toMatchObject({
      inserted: 0,
      updated: 0,
      unchanged: 2,
    });

    const again = await importYesNo(
      db,
      load(line({ id: 'a', question: 'Is it daytime?' }), line({ id: 'b' }))
    );
    expect(again).toMatchObject({ inserted: 0, updated: 1, unchanged: 1 });
    expect((await items())[0]).toMatchObject({ prompt: 'Is it daytime?' });
    expect((await pg.query(`SELECT 1 FROM "KnightsQueueItem"`)).rows).toHaveLength(2);
  });

  it('never rewrites a question that has been answered', async () => {
    await importYesNo(db, load(line({ id: 'a' })));
    await pg.exec(`UPDATE "KnightsQueueItem" SET "voteCount" = 1`);
    const result = await importYesNo(db, load(line({ id: 'a', question: 'Something else?' })), {});
    expect(result).toMatchObject({ updated: 0, unchanged: 0, refused: 1 });
    expect((await items())[0]).toMatchObject({ prompt: 'Is a hat worn?' });
    // The same file again is not a change.
    expect(await importYesNo(db, load(line({ id: 'a' })))).toMatchObject({
      refused: 0,
      unchanged: 1,
    });
  });

  it('leaves a tuned axis question alone, writes in batches, and marks policy questions for moderators', async () => {
    await importYesNo(db, load(line({ id: 'a' })));
    await pg.exec(
      `UPDATE "KnightsQuestion" SET "votesToResolve" = 7 WHERE key = 'knights.yesno.violence'`
    );
    const result = await importYesNo(
      db,
      load(line({ id: 'a' }), line({ id: 'b' }), line({ id: 'c', kind: 'policy_preference' })),
      { batchSize: 2 }
    );
    expect(result).toMatchObject({ inserted: 2, unchanged: 1 });
    const q = await pg.query<{ votesToResolve: number }>(
      `SELECT "votesToResolve" FROM "KnightsQuestion" WHERE key = 'knights.yesno.violence'`
    );
    expect(q.rows[0].votesToResolve).toBe(7);
    expect((await items()).map((i) => i.audience)).toEqual(['players', 'players', 'moderators']);
  });

  it('lets several questions about one image share an axis, while rating items still get one open item per image', async () => {
    const sources = fileURLToPath(
      new URL(
        '../../../../../../packages/civitai-db-schema/prisma/migrations/20261211120000_knights_v2_sources/migration.sql',
        import.meta.url
      )
    );
    await pg.exec(readFileSync(sources, 'utf8'));
    await pg.exec(readFileSync(MIGRATION, 'utf8'));
    try {
      const result = await importYesNo(
        db,
        load(line({ id: 'a' }), line({ id: 'b', question: 'Is it night?' }))
      );
      expect(result.inserted).toBe(2);

      await pg.exec(
        `INSERT INTO "KnightsQuestion" ("key","kind","prompt","options") VALUES ('knights.t.r','choice','R?','[]') ON CONFLICT DO NOTHING`
      );
      const rating = `INSERT INTO "KnightsQueueItem" ("questionKey","imageId","source","minRank","votesNeeded","updatedAt") VALUES ('knights.t.r',10,'t','Knight',5,now())`;
      await pg.exec(rating);
      await expect(pg.exec(rating)).rejects.toThrow(/open_question_image_key/);
    } finally {
      await pg.exec(`DROP INDEX IF EXISTS "KnightsQueueItem_open_question_image_key"`);
    }
  });

  it('imports a file of the real size in default batches, and a second run changes nothing', async () => {
    const many = Array.from({ length: 2500 }, (_, i) => ({
      externalId: `q-${i}`,
      imageId: 1000 + (i % 700),
      axis: i % 2 ? 'language' : 'violence',
      audience: 'players',
      prompt: `Question ${i}?`,
      yesEffect: 'R4',
      noEffect: 'R3',
      meta: {},
    }));
    expect(await importYesNo(db, many)).toEqual({
      inserted: 2500,
      updated: 0,
      unchanged: 0,
      refused: 0,
      retired: 0,
      axes: 2,
    });
    expect(await importYesNo(db, many)).toMatchObject({ inserted: 0, updated: 0, unchanged: 2500 });
  });

  it('retires an open question the file no longer marks active, dropping the gold of its answers, and never serves it again', async () => {
    await importYesNo(db, load(line({ id: 'a' }), line({ id: 'b' }), line({ id: 'c' })));
    await seedImage(pg, 10);
    await seedPlayer(pg, 1);
    await ensureVotePartitions(db, { now: new Date(), monthsAhead: 1 });
    const a = (await items())[0].id as number;
    await castYesNoVote(db, { userId: 1, itemId: a, answer: 'yes' }, { now: () => new Date() });

    const { rows, retire } = toYesNoRows(
      records(
        line({ id: 'a', active: 'false' }),
        line({ id: 'b', active: 'false' }),
        line({ id: 'c' })
      )
    );
    expect(retire).toEqual(['a', 'b']);
    const result = await importYesNo(db, rows, { retire });

    expect(result).toMatchObject({ retired: 2, unchanged: 1, inserted: 0 });
    expect((await items()).map((i) => [i.externalId, i.status, i.reason])).toEqual([
      ['a', 'Closed', 'retired'],
      ['b', 'Closed', 'retired'],
      ['c', 'Open', null],
    ]);
    const vote = await pg.query(
      `SELECT verdict, gold, "settledAt" IS NOT NULL AS settled FROM "KnightsVote"`
    );
    expect(vote.rows).toEqual([{ verdict: 'inconclusive', gold: 0, settled: true }]);
    expect(
      (await pg.query(`SELECT "goldPending" FROM "NewOrderPlayer" WHERE "userId"=1`)).rows[0]
    ).toEqual({ goldPending: 0 });
    // A repeat finds nothing open to retire.
    expect(await importYesNo(db, rows, { retire })).toMatchObject({ retired: 0 });
  });
});
