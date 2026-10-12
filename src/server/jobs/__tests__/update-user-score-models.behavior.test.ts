import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getModelScore } from '~/server/jobs/update-user-score';
import { recordStatusAtDelete } from '~/server/services/model-status-at-delete';

// Booting PGlite (WASM Postgres) can exceed the default hook timeout on a contended runner.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * Runs the `models` score query unmodified against an in-process Postgres. Every owner has a
 * Published anchor model worth ANCHOR points plus one subject model worth SUBJECT points, so an
 * owner's score is ANCHOR + SUBJECT when the subject counts and ANCHOR when it does not.
 */

const holder = { db: null as unknown as PGlite };
const pg = {
  cancellableQuery: async (sql: string, params?: unknown[]) => ({
    result: async () => (await holder.db.query(sql, params)).rows,
    cancel: async () => undefined,
  }),
} as never;
const q = (sql: string, params?: unknown[]) => holder.db.query(sql, params);

const MODERATOR = 9001;
const ANCHOR = 1; // one download
const SUBJECT = 100 + 2 * 10 + 3; // 100 downloads, 2 reviews, 3 generations
const CHECKPOINT = new Date('2020-06-01T00:00:00Z');
const BEFORE = '2020-01-01T00:00:00Z';
const AFTER = '2020-07-01T00:00:00Z';

let nextModelId = 1;
type ModelRow = {
  status: string;
  meta?: Record<string, unknown>;
  deletedBy?: number | null;
  /** When the Model row last changed; defaults to after the checkpoint. */
  updatedAt?: string;
  deletedAt?: string | null;
  /** When the ModelMetric row last changed; defaults to before the checkpoint. */
  metricUpdatedAt?: string;
  /**
   * The status mirrored onto the ModelMetric row; defaults to Published whatever the model's own
   * status, so a rule that read the mirror instead of `Model.status` would count every model.
   */
  metricStatus?: string;
};

async function addModel(
  userId: number,
  row: ModelRow,
  metrics: { downloads: number; reviews: number; generations: number }
) {
  const id = nextModelId++;
  await q(
    `INSERT INTO "Model" (id, "userId", status, meta, "deletedBy", "updatedAt", "deletedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      userId,
      row.status,
      JSON.stringify(row.meta ?? {}),
      row.deletedBy ?? null,
      row.updatedAt ?? AFTER,
      row.deletedAt ?? null,
    ]
  );
  await q(
    `INSERT INTO "ModelMetric" ("modelId", "userId", status, "downloadCount", "thumbsUpCount", "generationCount", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      userId,
      row.metricStatus ?? 'Published',
      metrics.downloads,
      metrics.reviews,
      metrics.generations,
      row.metricUpdatedAt ?? BEFORE,
    ]
  );
  return id;
}

/** An owner with a Published anchor and one subject model described by `row`. */
async function owner(userId: number, row: ModelRow) {
  await addModel(
    userId,
    { status: 'Published', updatedAt: BEFORE },
    { downloads: 1, reviews: 0, generations: 0 }
  );
  return addModel(userId, row, { downloads: 100, reviews: 2, generations: 3 });
}

async function scores() {
  const result = new Map<number, number>();
  await getModelScore({
    pg,
    jobContext: { on: () => undefined } as never,
    scoreMultipliers: {
      models: { reviews: 10, downloads: 1, generations: 1 },
    } as never,
    lastUpdate: CHECKPOINT,
    setScore: (id, _category, score) => result.set(id, Number(score)),
  });
  return result;
}

/** Whether the subject model counted; any score other than exactly with or without it fails. */
const counts = (userId: number, all: Map<number, number>) => {
  expect([ANCHOR, ANCHOR + SUBJECT]).toContain(all.get(userId));
  return all.get(userId) === ANCHOR + SUBJECT;
};

beforeAll(async () => {
  holder.db = new PGlite();
  await q(`CREATE TYPE "ModelStatus" AS ENUM ('Draft', 'Training', 'Published', 'Scheduled',
    'Unpublished', 'UnpublishedViolation', 'GatherInterest', 'Deleted')`);
  await q(`CREATE TABLE "Model" (
    id int PRIMARY KEY,
    "userId" int NOT NULL,
    status "ModelStatus" NOT NULL,
    meta jsonb NOT NULL DEFAULT '{}',
    "deletedBy" int,
    "updatedAt" timestamp(3) NOT NULL,
    "deletedAt" timestamp(3)
  )`);
  await q(`CREATE TABLE "ModelMetric" (
    "modelId" int PRIMARY KEY,
    "userId" int NOT NULL,
    status "ModelStatus" NOT NULL,
    "downloadCount" int NOT NULL DEFAULT 0,
    "thumbsUpCount" int NOT NULL DEFAULT 0,
    "generationCount" int NOT NULL DEFAULT 0,
    "updatedAt" timestamp(3) NOT NULL
  )`);
});

beforeEach(async () => {
  await q(`TRUNCATE "Model", "ModelMetric"`);
});

describe('which statuses count', () => {
  it.each([
    ['Published', true],
    ['Scheduled', true],
    ['UnpublishedViolation', false],
    ['Draft', false],
    ['Training', false],
    ['GatherInterest', false],
  ])('%s counts: %s', async (status, expected) => {
    await owner(1, { status });
    expect(counts(1, await scores())).toBe(expected);
  });

  it('reads the model status, not the copy on the metric row', async () => {
    await owner(1, { status: 'Published', metricStatus: 'UnpublishedViolation' });
    expect(counts(1, await scores())).toBe(true);
  });

  it('counts a live model whose meta still carries an old takedown', async () => {
    await owner(1, {
      status: 'Published',
      meta: { unpublishedBy: MODERATOR, unpublishedReason: 'other' },
    });
    expect(counts(1, await scores())).toBe(true);
  });
});

describe('unpublished', () => {
  it('keeps the points when the owner unpublished it', async () => {
    await owner(1, { status: 'Unpublished', meta: { unpublishedBy: 1 } });
    expect(counts(1, await scores())).toBe(true);
  });

  it('drops the points when someone else unpublished it', async () => {
    await owner(1, { status: 'Unpublished', meta: { unpublishedBy: MODERATOR } });
    expect(counts(1, await scores())).toBe(false);
  });

  it('keeps the points when no actor was recorded', async () => {
    await owner(1, { status: 'Unpublished' });
    expect(counts(1, await scores())).toBe(true);
  });
});

describe('deleted', () => {
  it('keeps the points when the owner deleted a live model', async () => {
    await owner(1, { status: 'Deleted', deletedBy: 1 });
    expect(counts(1, await scores())).toBe(true);
  });

  it('drops the points when someone else deleted it', async () => {
    await owner(1, { status: 'Deleted', deletedBy: MODERATOR });
    expect(counts(1, await scores())).toBe(false);
  });

  it('keeps the points when no actor was recorded', async () => {
    await owner(1, { status: 'Deleted', deletedBy: null });
    expect(counts(1, await scores())).toBe(true);
  });

  describe('owner delete of a model a moderator had taken down, before statusAtDelete', () => {
    it('drops the points when meta carries a takedown reason', async () => {
      await owner(1, { status: 'Deleted', deletedBy: 1, meta: { unpublishedReason: 'other' } });
      expect(counts(1, await scores())).toBe(false);
    });

    it('drops the points when meta says someone else unpublished it', async () => {
      await owner(1, { status: 'Deleted', deletedBy: 1, meta: { unpublishedBy: MODERATOR } });
      expect(counts(1, await scores())).toBe(false);
    });
  });

  describe('owner delete with statusAtDelete', () => {
    it('keeps the points of a model deleted while Published, over a stale takedown in meta', async () => {
      await owner(1, {
        status: 'Deleted',
        deletedBy: 1,
        meta: { statusAtDelete: 'Published', unpublishedReason: 'other', unpublishedBy: MODERATOR },
      });
      expect(counts(1, await scores())).toBe(true);
    });

    it('drops the points of a model deleted while UnpublishedViolation, with nothing else in meta', async () => {
      await owner(1, {
        status: 'Deleted',
        deletedBy: 1,
        meta: { statusAtDelete: 'UnpublishedViolation' },
      });
      expect(counts(1, await scores())).toBe(false);
    });

    it('keeps the points of a model the owner had unpublished', async () => {
      await owner(1, {
        status: 'Deleted',
        deletedBy: 1,
        meta: { statusAtDelete: 'Unpublished', unpublishedBy: 1 },
      });
      expect(counts(1, await scores())).toBe(true);
    });

    it('drops the points of a model someone else had unpublished', async () => {
      await owner(1, {
        status: 'Deleted',
        deletedBy: 1,
        meta: { statusAtDelete: 'Unpublished', unpublishedBy: MODERATOR },
      });
      expect(counts(1, await scores())).toBe(false);
    });
  });
});

describe('who is re-scored', () => {
  it('re-scores an owner whose only change is a takedown written to Model', async () => {
    await owner(1, { status: 'UnpublishedViolation', updatedAt: AFTER });
    expect((await scores()).get(1)).toBe(ANCHOR);
  });

  it('re-scores an owner whose model was deleted without bumping updatedAt', async () => {
    await owner(1, {
      status: 'Deleted',
      deletedBy: MODERATOR,
      updatedAt: BEFORE,
      deletedAt: AFTER,
    });
    expect((await scores()).get(1)).toBe(ANCHOR);
  });

  it('re-scores an owner whose metrics changed', async () => {
    await owner(1, { status: 'Published', updatedAt: BEFORE, metricUpdatedAt: AFTER });
    expect((await scores()).get(1)).toBe(ANCHOR + SUBJECT);
  });

  it('leaves out an owner with nothing changed since the checkpoint', async () => {
    await owner(1, { status: 'UnpublishedViolation', updatedAt: BEFORE });
    expect((await scores()).has(1)).toBe(false);
  });

  it('scores 0, not absent, for an owner none of whose models count', async () => {
    await addModel(
      1,
      { status: 'UnpublishedViolation' },
      { downloads: 100, reviews: 2, generations: 3 }
    );
    await addModel(1, { status: 'Draft' }, { downloads: 5, reviews: 0, generations: 0 });
    const all = await scores();
    expect(all.has(1)).toBe(true);
    expect(all.get(1)).toBe(0);
  });
});

describe('recordStatusAtDelete', () => {
  const tx = {
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = Prisma.sql(strings, ...(values as never[]));
      return (await q(sql.text, sql.values as unknown[])).affectedRows ?? 0;
    },
  } as never;

  /** What deleteModelById does: record, then flip to Deleted as the owner. */
  async function ownerDeletes(modelId: number, userId: number) {
    await recordStatusAtDelete(tx, modelId);
    await q(`UPDATE "Model" SET status = 'Deleted', "deletedBy" = $2 WHERE id = $1`, [
      modelId,
      userId,
    ]);
  }

  it('records the status the model had, and the score honours it', async () => {
    const modelId = await owner(1, {
      status: 'UnpublishedViolation',
      meta: { customMessage: 'kept' },
    });
    await ownerDeletes(modelId, 1);

    const { rows } = await q(`SELECT meta FROM "Model" WHERE id = $1`, [modelId]);
    expect(rows[0]).toEqual({
      meta: { customMessage: 'kept', statusAtDelete: 'UnpublishedViolation' },
    });
    expect(counts(1, await scores())).toBe(false);
  });

  it('keeps the first value when an already-deleted model is deleted again', async () => {
    const modelId = await owner(1, { status: 'Published' });
    await ownerDeletes(modelId, 1);
    await ownerDeletes(modelId, 1);

    const { rows } = await q(`SELECT meta->>'statusAtDelete' AS s FROM "Model" WHERE id = $1`, [
      modelId,
    ]);
    expect(rows[0]).toEqual({ s: 'Published' });
    expect(counts(1, await scores())).toBe(true);
  });
});
