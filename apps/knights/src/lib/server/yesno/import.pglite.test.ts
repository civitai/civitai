import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { REWORD_OF_META_KEY } from '@civitai/db/knights';
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
    `TRUNCATE "KnightsQueueItem","KnightsVote","Image","Post","NewOrderPlayer","NewOrderSmite","KnightsPlayerDay" RESTART IDENTITY CASCADE; DELETE FROM "KnightsQuestion" WHERE key LIKE 'knights.yesno.%'`
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

  it('records the original question of a reworded row, and nothing for a row without one', () => {
    const csv = [
      `${HEADER},reword_of`,
      `${line({ id: 'q1:r1', question: 'Is a hat clearly worn?' })},q1`,
      `${line({ id: 'q2' })},`,
    ].join('\n');
    const [reworded, plain] = toYesNoRows(parseCsv(csv)).rows;
    expect(reworded.meta).toMatchObject({ [REWORD_OF_META_KEY]: 'q1' });
    expect(plain.meta).not.toHaveProperty(REWORD_OF_META_KEY);
  });

  it('rejects an id over 200 characters instead of cutting it, so two long ids never collide', () => {
    const base = 'x'.repeat(200);
    const { rows, skipped, retire } = toYesNoRows(
      records(
        line({ id: `${base}1` }),
        line({ id: `${base}2` }),
        line({ id: base }),
        line({ id: `${base}3`, active: 'false' })
      )
    );
    expect(rows.map((r) => r.externalId)).toEqual([base]);
    expect(skipped).toEqual({ 'bad-id': 2, inactive: 1 });
    expect(retire).toEqual([]);
  });
});

const MIGRATION = fileURLToPath(
  new URL(
    '../../../../../../packages/civitai-db-schema/prisma/migrations/20261210120000_knights_v2_tables/migration.sql',
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
      moderated: 0,
      retired: 0,
      revived: 0,
      axes: 2,
    });

    const questions = (
      await pg.query<{ key: string; kind: string; prompt: string }>(
        `SELECT key, kind, prompt FROM "KnightsQuestion" WHERE key LIKE 'knights.yesno.%' ORDER BY key`
      )
    ).rows;
    expect(questions).toEqual([
      {
        key: 'knights.yesno.language',
        kind: 'bool',
        prompt: 'Does text in this image contain strong profanity?',
      },
      {
        key: 'knights.yesno.violence',
        kind: 'bool',
        prompt: 'Does this image show graphic injury, blood or gore?',
      },
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
      moderated: 0,
      retired: 0,
      revived: 0,
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

  it('reopens a withdrawn question that is listed again and has no answers, and leaves an answered one closed', async () => {
    await importYesNo(db, load(line({ id: 'a' }), line({ id: 'b' })));
    await seedImage(pg, 10);
    await seedPlayer(pg, 1);
    await ensureVotePartitions(db, { now: new Date(), monthsAhead: 1 });
    const b = (await items())[1].id as number;
    await castYesNoVote(db, { userId: 1, itemId: b, answer: 'yes' }, { now: () => new Date() });
    await importYesNo(db, [], { retire: ['a', 'b'] });
    expect((await items()).map((i) => i.status)).toEqual(['Closed', 'Closed']);

    const again = await importYesNo(db, load(line({ id: 'a' }), line({ id: 'b' })));

    expect(again).toMatchObject({ updated: 1 });
    expect((await items()).map((i) => [i.externalId, i.status, i.reason, i.resolvedAt])).toEqual([
      ['a', 'Open', null, null],
      ['b', 'Closed', 'retired', expect.anything()],
    ]);
  });

  describe('respects moderator actions', () => {
    const mark = (id: string, patch: string, sets = '') =>
      pg.exec(
        `UPDATE "KnightsQueueItem" SET "meta" = COALESCE("meta",'{}'::jsonb) || '${patch}'::jsonb ${sets} WHERE "externalId" = '${id}'`
      );

    it('never reopens a question a moderator retired, whether or not the file still lists it', async () => {
      await importYesNo(db, load(line({ id: 'a' }), line({ id: 'b' })));
      await mark(
        'a',
        '{"moderation":{"action":"retired"}}',
        `, "status"='Closed', "reason"='moderator-retired'`
      );
      await pg.exec(
        `UPDATE "KnightsQueueItem" SET "status"='Closed', "reason"='moderator-retired' WHERE "externalId" = 'b'`
      );

      await importYesNo(db, load(line({ id: 'a' }), line({ id: 'b', question: 'Changed?' })));

      expect((await items()).map((i) => [i.externalId, i.status, i.reason, i.prompt])).toEqual([
        ['a', 'Closed', 'moderator-retired', 'Is a hat worn?'],
        ['b', 'Closed', 'moderator-retired', 'Is a hat worn?'],
      ]);
    });

    it('leaves a restored question as the moderator left it, counts it as moderated, and still updates one nobody touched', async () => {
      await importYesNo(db, load(line({ id: 'a' }), line({ id: 'b' })));
      await mark('a', '{"moderation":{"action":"restored","by":4,"note":""}}');

      const again = await importYesNo(
        db,
        load(
          line({ id: 'a', question: 'Is a cap worn?' }),
          line({ id: 'b', question: 'Is a cap worn?' })
        )
      );

      expect(again).toMatchObject({ updated: 1, unchanged: 0, moderated: 1 });
      const [a, b] = await items();
      expect(a).toMatchObject({ status: 'Open', prompt: 'Is a hat worn?' });
      expect(a.meta).toMatchObject({ moderation: { action: 'restored', by: 4 } });
      expect(b.prompt).toBe('Is a cap worn?');
    });

    it('reopens its own close of a moderated item when the file lists it again, keeping the moderation record', async () => {
      await importYesNo(db, load(line({ id: 'a' })));
      await mark('a', '{"moderation":{"action":"restored","by":4,"note":""}}');
      await importYesNo(db, [], { retire: ['a'] });
      expect((await items())[0]).toMatchObject({ status: 'Closed', reason: 'retired' });

      const again = await importYesNo(db, load(line({ id: 'a' })));

      expect(again).toMatchObject({ updated: 1, moderated: 0 });
      expect((await items())[0]).toMatchObject({
        status: 'Open',
        reason: null,
        resolvedAt: null,
        meta: { moderation: { action: 'restored', by: 4 }, caseId: 'c1' },
      });
    });

    it('keeps a moderator-retired question closed and counts it as moderated, not unchanged', async () => {
      await importYesNo(db, load(line({ id: 'a' })));
      await pg.exec(
        `UPDATE "KnightsQueueItem" SET "status"='Closed', "reason"='moderator-retired' WHERE "externalId" = 'a'`
      );

      const again = await importYesNo(db, load(line({ id: 'a' })));

      expect(again).toMatchObject({ updated: 0, unchanged: 0, moderated: 1 });
      expect((await items())[0]).toMatchObject({ status: 'Closed', reason: 'moderator-retired' });
    });

    it('counts an answered question a moderator retired as unchanged when the file row is the same, and as refused only when it differs', async () => {
      await importYesNo(db, load(line({ id: 'a' })));
      await mark(
        'a',
        '{"moderation":{"action":"retired","by":4,"note":""}}',
        `, "status"='Closed', "reason"='moderator-retired', "voteCount"=3`
      );

      expect(await importYesNo(db, load(line({ id: 'a' })))).toMatchObject({
        unchanged: 1,
        refused: 0,
      });
      expect(
        await importYesNo(db, load(line({ id: 'a', question: 'Is a cap worn?' })))
      ).toMatchObject({ unchanged: 0, refused: 1 });
    });

    it('closes the open reworded copies of a question the producer withdrew, and only those', async () => {
      await importYesNo(db, load(line({ id: 'a' }), line({ id: 'b' })));
      await pg.exec(
        `UPDATE "KnightsQueueItem" SET "status"='Closed', "reason"='moderator-retired' WHERE "externalId" = 'a'`
      );
      const copy = (id: string, of: string, status = 'Open') =>
        pg.exec(
          `INSERT INTO "KnightsQueueItem" ("externalId","questionKey","imageId","source","minRank","votesNeeded","audience","prompt","status","meta","updatedAt")
           SELECT '${id}',"questionKey","imageId","source","minRank","votesNeeded","audience",'Reworded?','${status}','{"rewordOf":"${of}"}'::jsonb, now()
           FROM "KnightsQueueItem" WHERE "externalId" = '${of}'`
        );
      await copy('a:r1', 'a', 'Closed');
      await copy('a:r2', 'a');
      await copy('b:r1', 'b');

      const result = await importYesNo(db, [], { retire: ['a'] });

      expect(result).toMatchObject({ retired: 1 });
      expect((await items()).map((i) => [i.externalId, i.status, i.reason])).toEqual([
        ['a', 'Closed', 'moderator-retired'],
        ['a:r1', 'Closed', null],
        ['a:r2', 'Closed', 'retired'],
        ['b', 'Open', null],
        ['b:r1', 'Open', null],
      ]);
    });

    describe('relisting a moderator-retired question', () => {
      const retireByModerator = (id: string) =>
        pg.exec(
          `UPDATE "KnightsQueueItem" SET "status"='Closed', "reason"='moderator-retired' WHERE "externalId" = '${id}'`
        );
      const copy = (id: string, of: string, status: string, reason: string | null, votes = 0) =>
        pg.exec(
          `INSERT INTO "KnightsQueueItem" ("externalId","questionKey","imageId","source","minRank","votesNeeded","audience","prompt","status","reason","voteCount","meta","updatedAt")
         SELECT '${id}',"questionKey","imageId","source","minRank","votesNeeded","audience",'Reworded?','${status}',${
            reason ? `'${reason}'` : 'NULL'
          },${votes},'{"rewordOf":"${of}"}'::jsonb, now()
         FROM "KnightsQueueItem" WHERE "externalId" = '${of}'`
        );
      const states = async () =>
        (await items()).map((i) => [i.externalId, i.status, i.reason] as const);

      it('brings back the copy the withdrawal closed, leaving the original retired', async () => {
        await importYesNo(db, load(line({ id: 'a' })));
        await retireByModerator('a');
        await copy('a:r1', 'a', 'Open', null);
        await importYesNo(db, [], { retire: ['a'] });
        expect(await states()).toEqual([
          ['a', 'Closed', 'moderator-retired'],
          ['a:r1', 'Closed', 'retired'],
        ]);

        const again = await importYesNo(db, load(line({ id: 'a' })));

        expect(again).toMatchObject({ revived: 1, moderated: 1 });
        expect(await states()).toEqual([
          ['a', 'Closed', 'moderator-retired'],
          ['a:r1', 'Open', null],
        ]);
        expect((await items())[1].resolvedAt).toBeNull();
        expect(await importYesNo(db, load(line({ id: 'a' })))).toMatchObject({ revived: 0 });
      });

      it('reopens the latest import-closed copy by number, not one a moderator retired', async () => {
        await importYesNo(db, load(line({ id: 'a' })));
        await retireByModerator('a');
        await copy('a:r1', 'a', 'Closed', 'moderator-retired');
        await copy('a:r2', 'a', 'Closed', 'retired');
        await copy('a:r10', 'a', 'Closed', 'retired');
        await copy('a:r11', 'a', 'Closed', 'moderator-retired');

        await importYesNo(db, load(line({ id: 'a' })));

        expect((await states()).filter(([, status]) => status === 'Open')).toEqual([
          ['a:r10', 'Open', null],
        ]);
      });

      it('leaves a copy with answers closed, and does not add a second open version', async () => {
        await importYesNo(db, load(line({ id: 'a' }), line({ id: 'b' })));
        await retireByModerator('a');
        await retireByModerator('b');
        await copy('a:r1', 'a', 'Closed', 'retired', 2);
        await copy('b:r1', 'b', 'Closed', 'retired');
        await copy('b:r2', 'b', 'Open', null);

        const again = await importYesNo(db, load(line({ id: 'a' }), line({ id: 'b' })));

        expect(again).toMatchObject({ revived: 0 });
        expect(await states()).toEqual([
          ['a', 'Closed', 'moderator-retired'],
          ['a:r1', 'Closed', 'retired'],
          ['b', 'Closed', 'moderator-retired'],
          ['b:r1', 'Closed', 'retired'],
          ['b:r2', 'Open', null],
        ]);
      });
    });
  });
});
