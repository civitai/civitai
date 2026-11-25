import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { KNIGHTS_APP_ROLE } from '../../../test/knights-app-grants';
import { bootLabelStore, createQueueDb } from '../../../test/pglite-kysely';
import { seedImage } from '../../../test/seed';
import { ensureVotePartitions } from '../queue/queue.service';
import { runLabelPass } from './label-pass';
import { verdictLabelConfig } from './verdict-labels';

const NOW = new Date('2026-12-20T12:00:00Z');
const ON = { enabled: true } as const;

let pg: PGlite;
let db: Kysely<DB>;
const log = vi.fn();

/** `null` runs the pass as the tick did before verdict labels existed: no verdict config at all. */
const pass = (verdict: { enabled: boolean; cap?: number } | null = ON) =>
  runLabelPass(db, { now: NOW, log, verdict: verdict ?? undefined });

type Label = {
  sourceRef: string;
  value: string;
  labellerKind: string;
  labellerRef: string;
  question: string;
};
const verdictLabels = async () =>
  (
    await pg.query<Label>(
      `SELECT "sourceRef","value","labellerKind","labellerRef","question" FROM label_store.label
       WHERE "question" = 'image.rating' ORDER BY id`
    )
  ).rows;
const consensus = async (imageId: number) =>
  (
    await pg.query<{ outcome: string | null; trainable: boolean; humanLabels: number }>(
      `SELECT c."outcome", c."trainable", c."humanLabels" FROM label_store.consensus c
       JOIN label_store.subject s ON s."id" = c."subjectId"
       WHERE s."subjectType" = 'image' AND s."subjectId" = $1 AND c."question" = 'image.rating'`,
      [String(imageId)]
    )
  ).rows[0];
const failures = async () =>
  Number(
    (
      await pg.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM label_store.record_failure WHERE "sourceRef" LIKE 'KnightsVerdict:%'`
      )
    ).rows[0].n
  );
/** Moves every recorded failure back past the retry age, as if the time had passed. */
const wait = () =>
  pg.exec(`UPDATE label_store.record_failure SET "createdAt" = "createdAt" - interval '1 hour'`);

let nextItem = 1;
/** A rating queue item for the image, settled on `value` unless another status is given. */
async function item(
  imageId: number,
  value: string | null,
  {
    status = 'Resolved',
    resolvedAt = '2026-12-10 11:00:00',
    hidden = false,
    reason = null,
    questionKey = 'knights.image.nsfwLevel',
  }: {
    status?: string;
    resolvedAt?: string;
    hidden?: boolean;
    reason?: string | null;
    questionKey?: string;
  } = {}
): Promise<number> {
  const id = nextItem++;
  await pg.query(
    `INSERT INTO "KnightsQueueItem" ("id","questionKey","imageId","source","minRank","votesNeeded","status","isHiddenCheck",
       "resolvedValue","resolvedAt","reason","updatedAt")
     VALUES ($1,$2,$3,'test','Knight',5,$4,$5,$6,$7::timestamp,$8,now())`,
    [id, questionKey, imageId, status, hidden, value, value === null ? null : resolvedAt, reason]
  );
  return id;
}

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  await bootLabelStore(pg);
  await ensureVotePartitions(db, { now: NOW, monthsAhead: 1 });
  for (const id of [101, 102, 103, 104, 105, 106, 107])
    await seedImage(pg, id, { userId: id + 1000 });
  await pg.exec(
    `INSERT INTO "KnightsQuestion" ("key","kind","prompt","options") VALUES ('knights.yesno.test','bool','?','[]'::jsonb)
     ON CONFLICT DO NOTHING`
  );
}, 120_000);
afterAll(async () => {
  await pg.close();
});
beforeEach(async () => {
  log.mockReset();
  await pg.exec(
    `TRUNCATE "KnightsVote", "KnightsQueueItem", "CsamReport" RESTART IDENTITY CASCADE;
     TRUNCATE label_store.subject, label_store.erased_subject, label_store.record_failure CASCADE;
     DELETE FROM label_store.rule WHERE "question" = 'image.rating';
     UPDATE "Image" SET "needsReview" = NULL, "blockedFor" = NULL, "postId" = "id";
     UPDATE "Post" SET "publishedAt" = '2020-01-01'`
  );
});

describe('verdict labels', () => {
  it('records one knight label per settled rating verdict, and its consensus is the verdict', async () => {
    const id = await item(101, '8');

    expect(await pass()).toMatchObject({ verdictLabelsWritten: 1, labelFailures: 0 });

    expect(await verdictLabels()).toEqual([
      {
        sourceRef: `KnightsVerdict:${id}:8`,
        value: '8',
        labellerKind: 'knight',
        labellerRef: 'knights:verdict',
        question: 'image.rating',
      },
    ]);
    expect(await consensus(101)).toEqual({ outcome: '8', trainable: true, humanLabels: 1 });
  });

  it('records nothing on a second pass', async () => {
    await item(101, '8');
    await item(102, '2');
    await pass();

    expect(await pass()).toMatchObject({ verdictLabelsWritten: 0, labelFailures: 0 });
    expect(await verdictLabels()).toHaveLength(2);
  });

  it('records nothing again when an item lost its mark but kept its label', async () => {
    await item(101, '8');
    await pass();
    await pg.exec(`UPDATE "KnightsQueueItem" SET "verdictLabelledValue" = NULL`);

    expect(await pass()).toMatchObject({ verdictLabelsWritten: 0, labelFailures: 0 });
    expect(await verdictLabels()).toHaveLength(1);
    expect(await failures()).toBe(0);
    expect(
      (await pg.query(`SELECT 1 FROM "KnightsQueueItem" WHERE "verdictLabelledValue" = '8'`)).rows
    ).toHaveLength(1);
  });

  it('lets a later verdict on the same image supersede the earlier one', async () => {
    await item(101, '4', { resolvedAt: '2026-12-10 11:00:00' });
    await pass();
    expect((await consensus(101)).outcome).toBe('4');

    await item(101, '16', { resolvedAt: '2026-12-12 09:00:00' });
    expect(await pass()).toMatchObject({ verdictLabelsWritten: 1 });

    expect((await verdictLabels()).map((l) => l.value)).toEqual(['4', '16']);
    expect(await consensus(101)).toMatchObject({ outcome: '16', trainable: true });
  });

  it('labels an item again, exactly once, when its settled value changes', async () => {
    const id = await item(101, '4');
    await pass();

    await pg.query(
      `UPDATE "KnightsQueueItem" SET "resolvedValue" = '8', "resolvedAt" = '2026-12-11 10:00:00' WHERE "id" = $1`,
      [id]
    );
    expect(await pass()).toMatchObject({ verdictLabelsWritten: 1 });
    expect(await pass()).toMatchObject({ verdictLabelsWritten: 0 });

    expect((await verdictLabels()).map((l) => l.sourceRef)).toEqual([
      `KnightsVerdict:${id}:4`,
      `KnightsVerdict:${id}:8`,
    ]);
    expect((await consensus(101)).outcome).toBe('8');
  });

  it('gives the image.rating question its rule: one verdict, not unanimous', async () => {
    await item(101, '8');
    await pass();

    expect(
      (
        await pg.query(
          `SELECT "questionVersion","minHuman","requireUnanimous" FROM label_store.rule WHERE "question" = 'image.rating'`
        )
      ).rows
    ).toEqual([{ questionVersion: 1, minHuman: 1, requireUnanimous: false }]);
  });

  describe('labels only an image the image gate calls servable, and does not try another again', () => {
    const cases: [string, () => Promise<unknown>][] = [
      [
        'needsReview csam',
        () => pg.exec(`UPDATE "Image" SET "needsReview" = 'csam' WHERE "id" = 101`),
      ],
      [
        'blockedFor CSAM',
        () => pg.exec(`UPDATE "Image" SET "blockedFor" = 'CSAM' WHERE "id" = 101`),
      ],
      [
        'its owner in a CSAM report',
        () => pg.exec(`INSERT INTO "CsamReport" ("userId") VALUES (1101)`),
      ],
      [
        'listed in a CSAM report',
        () =>
          pg.exec(
            `INSERT INTO "CsamReport" ("userId","images") VALUES (999, '[{"id": 101}]'::jsonb)`
          ),
      ],
      [
        'its owner named as a secondary user in a CSAM report',
        () =>
          pg.exec(
            `INSERT INTO "CsamReport" ("userId","details") VALUES (999, '{"secondaryUserId": 1101}'::jsonb)`
          ),
      ],
      [
        'its post not published',
        () => pg.exec(`UPDATE "Post" SET "publishedAt" = NULL WHERE "id" = 101`),
      ],
      [
        'not on a post, so the gate has no row for it',
        () => pg.exec(`UPDATE "Image" SET "postId" = NULL WHERE "id" = 101`),
      ],
    ];
    it.each(cases)('%s', async (_, exclude) => {
      await exclude();
      await item(101, '8');
      await item(102, '2');

      expect(await pass()).toMatchObject({ verdictLabelsWritten: 1, labelFailures: 0 });
      expect((await verdictLabels()).map((l) => l.value)).toEqual(['2']);
      expect(
        (await pg.query(`SELECT 1 FROM label_store.subject WHERE "subjectId" = '101'`)).rows
      ).toHaveLength(0);
      expect(await pass()).toMatchObject({ verdictLabelsWritten: 0, labelFailures: 0 });
    });
  });

  it('labels only settled rating verdicts', async () => {
    await item(101, null, { status: 'Open' });
    await item(102, null, { status: 'Inquisitor' });
    await item(103, '8', { status: 'Closed', reason: 'moderator-ruled' });
    await item(104, '8', { hidden: true });
    await item(105, 'yes', { questionKey: 'knights.yesno.test' });
    await item(106, '2', { reason: 'no-consensus-rerate' });

    await pass();

    expect((await verdictLabels()).map((l) => l.value)).toEqual(['2']);
  });

  it('only marks an item whose image is gone', async () => {
    await item(999, '8');

    expect(await pass()).toMatchObject({ verdictLabelsWritten: 0, labelFailures: 0 });
    expect(await verdictLabels()).toEqual([]);
    expect(
      (await pg.query(`SELECT 1 FROM "KnightsQueueItem" WHERE "verdictLabelledValue" = '8'`)).rows
    ).toHaveLength(1);
  });

  it('retries a verdict the store refuses, and gives up after a few tries', async () => {
    await item(101, '8');
    await pg.exec(
      `INSERT INTO label_store.erased_subject ("subjectType","subjectId") VALUES ('image','101')`
    );

    for (let i = 0; i < 5; i++) {
      expect(await pass()).toMatchObject({ verdictLabelsWritten: 0, labelFailures: 1 });
      await wait();
    }
    expect(await pass()).toMatchObject({ verdictLabelsWritten: 0, labelFailures: 0 });
    expect(await failures()).toBe(5);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ name: 'knights-label-given-up' }));
  });

  it('writes no verdict label while the switch is off', async () => {
    await item(101, '8');

    expect(await pass(null)).toMatchObject({ verdictLabelsWritten: 0 });
    expect(await pass({ enabled: false })).toMatchObject({ verdictLabelsWritten: 0 });

    expect(await verdictLabels()).toEqual([]);
  });

  it('writes at most the cap in one pass, and the rest on later passes', async () => {
    await item(101, '8', { resolvedAt: '2026-12-10 11:00:00' });
    await item(102, '2', { resolvedAt: '2026-12-10 12:00:00' });
    await item(103, '4', { resolvedAt: '2026-12-10 13:00:00' });

    expect(await pass({ enabled: true, cap: 2 })).toMatchObject({ verdictLabelsWritten: 2 });
    expect((await verdictLabels()).map((l) => l.value)).toEqual(['8', '2']);
    expect(await pass({ enabled: true, cap: 2 })).toMatchObject({ verdictLabelsWritten: 1 });
  });

  it('writes nothing, and marks nothing, when the image gate cannot be read', async () => {
    await item(101, '8');
    await pg.exec(`REVOKE SELECT ON "KnightsImageGate" FROM ${KNIGHTS_APP_ROLE}`);
    try {
      const result = await pass();
      expect(result).toMatchObject({ verdictLabelsWritten: 0 });
      expect(result.labelFailures).toBeGreaterThan(0);
      expect(await verdictLabels()).toEqual([]);
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'knights-verdict-labels-failed' })
      );
      expect(
        (
          await pg.query(
            `SELECT 1 FROM "KnightsQueueItem" WHERE "verdictLabelledValue" IS NOT NULL`
          )
        ).rows
      ).toHaveLength(0);
    } finally {
      await pg.exec(`GRANT SELECT ON "KnightsImageGate" TO ${KNIGHTS_APP_ROLE}`);
    }
    expect(await pass()).toMatchObject({ verdictLabelsWritten: 1, labelFailures: 0 });
  });
});

describe('verdictLabelConfig', () => {
  it('is off unless switched on, and reads a whole positive cap', () => {
    expect(verdictLabelConfig({})).toEqual({ enabled: false });
    expect(verdictLabelConfig({ KNIGHTS_VERDICT_LABELS: 'off' })).toEqual({ enabled: false });
    expect(verdictLabelConfig({ KNIGHTS_VERDICT_LABELS: 'garbage' })).toEqual({ enabled: false });
    expect(verdictLabelConfig({ KNIGHTS_VERDICT_LABELS: ' On ' })).toEqual({ enabled: true });
    expect(
      verdictLabelConfig({ KNIGHTS_VERDICT_LABELS: 'true', KNIGHTS_VERDICT_LABEL_CAP: '500' })
    ).toEqual({ enabled: true, cap: 500 });
    // A cap that does not parse keeps the switch off rather than writing without a limit.
    expect(
      verdictLabelConfig({ KNIGHTS_VERDICT_LABELS: 'true', KNIGHTS_VERDICT_LABEL_CAP: 'lots' })
    ).toEqual({ enabled: false });
    expect(
      verdictLabelConfig({ KNIGHTS_VERDICT_LABELS: 'true', KNIGHTS_VERDICT_LABEL_CAP: '0' })
    ).toEqual({ enabled: false });
  });
});
