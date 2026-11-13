import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { bootLabelStore } from '~/server/services/__tests__/label-store.fixture';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const mocks = vi.hoisted(() => ({
  unpublishModelById: vi.fn(),
  publishModelHandler: vi.fn(),
  createStrike: vi.fn(),
  loadSubjects: vi.fn(),
  refreshModelData: vi.fn(),
  bustPublicModelResponseCache: vi.fn(),
}));

// Hand-listed: the real modules build search-index and cache clients at load.
vi.mock('~/server/services/model.service', () => ({
  unpublishModelById: mocks.unpublishModelById,
}));
vi.mock('~/server/services/model-version.service', () => ({
  bustPublicModelResponseCache: mocks.bustPublicModelResponseCache,
}));
vi.mock('~/server/controllers/model.controller', () => ({
  publishModelHandler: mocks.publishModelHandler,
}));
vi.mock('~/server/services/strike.service', () => ({ createStrike: mocks.createStrike }));
vi.mock('~/server/redis/caches', () => ({
  dataForModelsCache: { refresh: mocks.refreshModelData },
}));
vi.mock('~/server/services/text-scan/profiles/model.profile', () => ({
  loadModelScanSubjects: mocks.loadSubjects,
}));

const {
  decideModelRulesHold,
  decideModelRulesHoldBatch,
  isModelRulesHoldRefusal,
  resolveModelRulesHoldInput,
} = await import('~/server/services/text-scan/model-rules-hold-decision');
const { MODEL_RULES_UNPUBLISH_MESSAGE } = await import(
  '~/server/services/text-scan/actions/model-rules'
);
const { textScanTextHash } = await import('~/server/services/text-scan/prompt');

const db = { pg: null as unknown as PGlite };
const migration = (name: string) =>
  readFileSync(
    path.resolve(
      __dirname,
      `../../../../../packages/civitai-db-schema/prisma/migrations/${name}/migration.sql`
    ),
    'utf8'
  );
const asRawSql = (strings: TemplateStringsArray, values: unknown[]) =>
  strings.reduce((acc, part, i) => acc + part + (i < values.length ? `$${i + 1}` : ''), '');

// Only the columns the decision reads and writes.
const MODEL_TABLE = `CREATE TABLE "Model" (
  "id" INT PRIMARY KEY, "status" TEXT NOT NULL, "availability" TEXT NOT NULL DEFAULT 'Public',
  "deletedAt" TIMESTAMP(3), "nsfw" BOOLEAN NOT NULL DEFAULT false, "meta" JSONB)`;

// Only the columns the one-pending migration reads to pick a survivor.
const ENTITY_MODERATION_STUB = `CREATE TABLE "EntityModeration" (
  "id" SERIAL PRIMARY KEY, "entityType" TEXT NOT NULL, "entityId" INT NOT NULL,
  "result" JSONB, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT now())`;

beforeAll(async () => {
  db.pg = await PGlite.create();
  await bootLabelStore(db.pg);
  await db.pg.exec(MODEL_TABLE);
  await db.pg.exec(ENTITY_MODERATION_STUB);
  await db.pg.exec(migration('20261016150000_text_scan_hold'));
  await db.pg.exec(migration('20261112120000_text_scan_hold_one_pending'));
});
afterAll(async () => {
  await db.pg.close();
});

const subject = {
  userId: 5,
  declared: { nsfwLevel: 1, poi: false, minor: false },
  fields: [{ heading: 'Name', text: 'Hero One LoRA' }],
};
const HASH = textScanTextHash(subject as never);
const RULES = [
  { id: 3, subject: 'Example Franchise', description: 'd', aliases: ['Hero One'] },
  { id: 4, subject: 'Other Franchise', description: 'd', aliases: ['Hero Two'] },
];

const tracker = { modelEvent: vi.fn() };
const actor = { id: 7, isModerator: true };

type Seed = {
  mode?: 'shadow' | 'active';
  status?: string;
  modelMeta?: Record<string, unknown>;
  hold?: Record<string, unknown>;
  userId?: number | null;
  holdStatus?: string;
  holdMeta?: Record<string, unknown>;
};
async function seed({
  mode = 'shadow',
  status = mode === 'shadow' ? 'Published' : 'UnpublishedViolation',
  modelMeta = mode === 'active'
    ? { needsReview: true, modelRules: { ruleIds: [3, 4], textHash: HASH, workflowId: 'w' } }
    : {},
  userId = 5,
  holdStatus = 'Pending',
  holdMeta = {},
}: Seed = {}) {
  await db.pg.query(`INSERT INTO "Model" ("id","status","meta") VALUES (9, $1, $2::jsonb)`, [
    status,
    JSON.stringify(modelMeta),
  ]);
  await db.pg.query(
    `INSERT INTO "TextScanHold"
       ("id","entityType","entityId","label","textHash","userId","text","reason","status","hiddenAt","meta","updatedAt")
     VALUES (12,'Model',9,'modelRules',$1,$2,'Name\nHero One LoRA','Example Franchise',$3::"TextScanHoldStatus",
       ${mode === 'active' ? 'now()' : 'NULL'}, $4::jsonb, now())`,
    [
      HASH,
      userId,
      holdStatus,
      JSON.stringify({
        mode,
        fields: [{ heading: 'Name', text: 'Hero One LoRA' }],
        matches: [
          { ruleId: 3, term: 'Hero One', field: 'Name', fieldIndex: 0, start: 0, end: 8 },
          { ruleId: 4, term: 'Hero Two', field: 'Name', fieldIndex: 0, start: 0, end: 8 },
        ],
        rules: RULES,
        ...(mode === 'active' ? { applied: true } : {}),
        ...holdMeta,
      }),
    ]
  );
}

const decide = (
  decision: Parameters<typeof decideModelRulesHold>[0]['decision'],
  over: Partial<Parameters<typeof decideModelRulesHold>[0]> = {}
) =>
  decideModelRulesHold({
    holdId: 12,
    textHash: HASH,
    decision,
    actor,
    tracker: tracker as never,
    ...over,
  });

const hold = async () =>
  (await db.pg.query<Record<string, unknown>>(`SELECT * FROM "TextScanHold" WHERE "id" = 12`))
    .rows[0];
const modelRow = async () =>
  (await db.pg.query<Record<string, unknown>>(`SELECT * FROM "Model" WHERE "id" = 9`)).rows[0];
const labels = async () =>
  (
    await db.pg.query<Record<string, unknown>>(
      `SELECT l."value", l."reason", s."subjectType", s."subjectId", l."sourceRef"
       FROM label_store.label l JOIN label_store.subject s ON s."id" = l."subjectId" ORDER BY l."sourceRef"`
    )
  ).rows;

beforeEach(async () => {
  vi.clearAllMocks();
  await db.pg.exec(`TRUNCATE label_store.label, label_store.subject RESTART IDENTITY CASCADE`);
  await db.pg.exec(`TRUNCATE "TextScanHold", "Model" RESTART IDENTITY`);
  mocks.loadSubjects.mockResolvedValue(new Map([[9, subject]]));
  mocks.createStrike.mockResolvedValue({ id: 31 });
  dbMock.dbWrite.model.findUnique.mockImplementation(
    (async ({ where }: { where: { id: number } }) =>
      (await db.pg.query(`SELECT * FROM "Model" WHERE "id" = $1`, [where.id])).rows[0] ??
      null) as never
  );
  dbMock.dbWrite.modelVersion.findMany.mockResolvedValue([]);
  dbMock.dbWrite.textScanHold.findFirst.mockImplementation(
    (async ({ where }: { where: { id: number } }) =>
      (
        await db.pg.query(
          `SELECT "id","status"::text AS "status","entityType","entityId","userId","text","textHash","hiddenAt","meta"
         FROM "TextScanHold" WHERE "id" = $1 AND "label" = 'modelRules'`,
          [where.id]
        )
      ).rows[0] ?? null) as never
  );
  dbMock.dbWrite.$queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values) => {
    const params = values.map((v) => (v instanceof Date ? v.toISOString() : v));
    return (await db.pg.query(asRawSql(strings, values), params)).rows;
  });
  dbMock.dbWrite.$executeRaw.mockImplementation(
    async (strings: TemplateStringsArray, ...values) =>
      (await db.pg.query(asRawSql(strings, values), values)).affectedRows ?? 0
  );
  // The ruling's own update, run against the real table.
  dbMock.dbWrite.textScanHold.updateMany.mockImplementation((async ({
    where,
    data,
  }: {
    where: { id: number; status: string; textHash: string };
    data: Record<string, unknown>;
  }) => {
    const result = await db.pg.query(
      `UPDATE "TextScanHold" SET "status" = $1::"TextScanHoldStatus", "decidedAt" = $2,
         "decidedById" = $3, "decisionNote" = $4, "meta" = $5::jsonb,
         "restoredAt" = $6
       WHERE "id" = $7 AND "status" = 'Pending' AND "textHash" = $8`,
      [
        data.status,
        data.decidedAt,
        data.decidedById,
        data.decisionNote,
        JSON.stringify(data.meta),
        data.restoredAt ?? null,
        where.id,
        where.textHash,
      ]
    );
    return { count: result.affectedRows ?? 0 };
  }) as never);
});

describe('confirming a hold', () => {
  it('unpublishes a live model as a violation without naming the rule or re-queuing it', async () => {
    await seed({ mode: 'shadow' });
    await decide('confirm');

    expect(mocks.unpublishModelById).toHaveBeenCalledWith({
      id: 9,
      userId: 7,
      isModerator: true,
      reason: 'other',
      customMessage: MODEL_RULES_UNPUBLISH_MESSAGE,
      metaPatch: { modelRules: expect.objectContaining({ ruleIds: [3, 4], textHash: HASH }) },
      metaUnset: ['needsReview'],
    });
    expect(tracker.modelEvent).toHaveBeenCalledWith({
      type: 'Unpublish',
      modelId: 9,
      nsfw: false,
    });
    expect(await hold()).toMatchObject({ status: 'Confirmed', decidedById: 7 });
    expect((await hold()).meta).toMatchObject({ decision: 'confirm', mode: 'shadow' });
    expect(mocks.createStrike).not.toHaveBeenCalled();
  });

  it('keeps an already taken-down model down and drops it from the needs-review list', async () => {
    await seed({ mode: 'active' });
    await decide('confirm');

    expect(mocks.unpublishModelById).not.toHaveBeenCalled();
    expect(await modelRow()).toMatchObject({ status: 'UnpublishedViolation' });
    expect((await modelRow()).meta).not.toHaveProperty('needsReview');
    expect((await modelRow()).meta).toHaveProperty('modelRules');
    expect(await hold()).toMatchObject({ status: 'Confirmed' });
  });

  it('takes the model down again when a held model went live before the ruling', async () => {
    await seed({ mode: 'active', status: 'Published' });
    await decide('confirm');
    expect(mocks.unpublishModelById).toHaveBeenCalledTimes(1);
  });

  it('strikes the owner once for confirm_strike, and for no other decision', async () => {
    await seed({ mode: 'shadow' });
    await decide('confirm_strike');
    expect(mocks.createStrike).toHaveBeenCalledTimes(1);
    expect(mocks.createStrike).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 5,
        entityType: 'Model',
        entityId: 9,
        issuedBy: 7,
        points: 1,
      })
    );
    expect(mocks.unpublishModelById).toHaveBeenCalledTimes(1);
    expect((await hold()).meta).toMatchObject({ decision: 'confirm_strike' });
  });

  it.each(['confirm', 'dismiss_not_subject', 'dismiss_allowed'] as const)(
    '%s strikes nobody',
    async (decision) => {
      await seed({ mode: 'shadow' });
      await decide(decision);
      expect(mocks.createStrike).not.toHaveBeenCalled();
    }
  );

  it('refuses a strike for a hold with no recorded owner, running no effect', async () => {
    await seed({ mode: 'shadow', userId: null });
    await expect(decide('confirm_strike')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.unpublishModelById).not.toHaveBeenCalled();
    expect((await hold()).status).toBe('Pending');
  });
});

describe('dismissing a hold', () => {
  it('applies nothing to a model that was never taken down', async () => {
    await seed({ mode: 'shadow' });
    await decide('dismiss_not_subject', { note: 'too broad' });

    expect(mocks.unpublishModelById).not.toHaveBeenCalled();
    expect(mocks.publishModelHandler).not.toHaveBeenCalled();
    expect(await modelRow()).toMatchObject({ status: 'Published' });
    expect(await hold()).toMatchObject({
      status: 'Dismissed',
      decidedById: 7,
      decisionNote: 'too broad',
      restoredAt: null,
    });
    expect((await hold()).meta).toMatchObject({ decision: 'dismiss_not_subject' });
    expect((await modelRow()).meta).not.toHaveProperty('modelRulesCleared');
  });

  describe('a training hold on a model that is not live', () => {
    const draft = (over: Seed = {}) =>
      seed({
        mode: 'active',
        status: 'Draft',
        modelMeta: {},
        holdMeta: { source: 'training' },
        ...over,
      });

    it.each(['dismiss_not_subject', 'dismiss_allowed'] as const)(
      'clears the matched rules for that text instead of republishing, on %s',
      async (decision) => {
        await draft();
        await decide(decision);

        expect(mocks.publishModelHandler).not.toHaveBeenCalled();
        expect((await modelRow()).meta).toEqual({
          modelRulesCleared: { textHash: HASH, ruleIds: [3, 4] },
        });
        expect(await hold()).toMatchObject({ status: 'Dismissed', decidedById: 7 });
        expect(await labels()).toHaveLength(2);
      }
    );

    it('keeps the rules a moderator cleared for the same text before', async () => {
      await draft({ modelMeta: { modelRulesCleared: { textHash: HASH, ruleIds: [9] } } });
      await decide('dismiss_allowed');
      expect((await modelRow()).meta).toEqual({
        modelRulesCleared: { textHash: HASH, ruleIds: [9, 3, 4] },
      });
    });

    it('replaces a clearance made for other text', async () => {
      await draft({ modelMeta: { modelRulesCleared: { textHash: 'older', ruleIds: [9] } } });
      await decide('dismiss_allowed');
      expect((await modelRow()).meta).toEqual({
        modelRulesCleared: { textHash: HASH, ruleIds: [3, 4] },
      });
    });

    it.each([
      ['a draft', 'Draft'],
      ['an owner-unpublished model', 'Unpublished'],
    ])(
      'clears the rules of a publish or edit hold on %s without republishing',
      async (_n, status) => {
        await seed({ mode: 'active', status, modelMeta: {} });
        await decide('dismiss_allowed');

        expect(mocks.publishModelHandler).not.toHaveBeenCalled();
        expect((await modelRow()).meta).toEqual({
          modelRulesCleared: { textHash: HASH, ruleIds: [3, 4] },
        });
        expect((await hold()).status).toBe('Dismissed');
      }
    );

    it('clears nothing on a confirm', async () => {
      await draft();
      await decide('confirm');
      expect((await modelRow()).meta).not.toHaveProperty('modelRulesCleared');
    });

    it('still refuses a deleted model', async () => {
      await draft({ status: 'Deleted' });
      await expect(decide('dismiss_allowed')).rejects.toMatchObject({ code: 'CONFLICT' });
      expect((await hold()).status).toBe('Pending');
    });
  });

  it('republishes a taken-down model, with its pre-publish versions and the ones the takedown stamped', async () => {
    await seed({ mode: 'active', holdMeta: { versionIds: [101, 999] } });
    await db.pg.query(
      `UPDATE "Model" SET "meta" = "meta" || '{"unpublishedAt":"2026-10-22T10:00:00Z"}'::jsonb`
    );
    dbMock.dbWrite.modelVersion.findMany.mockResolvedValue([
      { id: 101, status: 'Draft', meta: {} },
      { id: 102, status: 'UnpublishedViolation', meta: { unpublishedAt: '2026-10-22T10:00:00Z' } },
      { id: 103, status: 'UnpublishedViolation', meta: { unpublishedAt: '2026-01-01T00:00:00Z' } },
    ]);

    await decide('dismiss_allowed');

    expect(mocks.publishModelHandler).toHaveBeenCalledWith({
      input: { id: 9, versionIds: [101, 102] },
      ctx: { user: actor, track: tracker },
    });
    const ruled = await hold();
    expect(ruled).toMatchObject({ status: 'Dismissed' });
    expect(ruled.restoredAt).toBeInstanceOf(Date);
    expect(ruled.meta).toMatchObject({ decision: 'dismiss_allowed' });
  });

  it('leaves down a version taken down for something else, and refuses when the hold cannot name its own', async () => {
    await seed({ mode: 'active', holdMeta: { versionIds: [101] } });
    dbMock.dbWrite.modelVersion.findMany.mockResolvedValue([
      { id: 101, status: 'Draft', meta: {} },
      { id: 103, status: 'UnpublishedViolation', meta: { unpublishedAt: '2026-01-01T00:00:00Z' } },
    ]);
    await decide('dismiss_allowed');
    expect(mocks.publishModelHandler).toHaveBeenCalledWith(
      expect.objectContaining({ input: { id: 9, versionIds: [101] } })
    );
  });

  it('refuses to republish by guessing when the hold recorded no versions and the takedown left no stamp', async () => {
    await seed({ mode: 'active' });
    dbMock.dbWrite.modelVersion.findMany.mockResolvedValue([
      { id: 103, status: 'UnpublishedViolation', meta: {} },
    ]);
    await expect(decide('dismiss_allowed')).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('versions'),
    });
    expect(mocks.publishModelHandler).not.toHaveBeenCalled();
    const left = await hold();
    expect(left.status).toBe('Pending');
    expect(left.meta).not.toHaveProperty('decisionClaim');
  });

  it.each([
    ['the model was republished since', { status: 'Published' }],
    [
      'the model is held for a different text',
      { modelMeta: { modelRules: { ruleIds: [3], textHash: 'other', workflowId: 'w' } } },
    ],
    ['the model was deleted', { status: 'Deleted' }],
  ])('refuses to republish when %s, leaving the hold pending and unclaimed', async (_n, over) => {
    await seed({ mode: 'active', ...(over as Seed) });
    await expect(decide('dismiss_allowed')).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('no longer'),
    });
    expect(mocks.publishModelHandler).not.toHaveBeenCalled();
    const left = await hold();
    expect(left.status).toBe('Pending');
    expect(left.meta).not.toHaveProperty('decisionClaim');
  });
});

describe('retrying after an effect already ran', () => {
  it('does not strike twice when the ruling failed after the strike', async () => {
    await seed({ mode: 'shadow' });
    const spy = vi.spyOn(dbMock.dbWrite.textScanHold, 'updateMany');
    spy.mockRejectedValueOnce(new Error('db down'));
    await expect(decide('confirm_strike')).rejects.toThrow('db down');
    expect(mocks.createStrike).toHaveBeenCalledTimes(1);

    await decide('confirm_strike');
    expect(mocks.createStrike).toHaveBeenCalledTimes(1);
    expect(await hold()).toMatchObject({ status: 'Confirmed' });
  });

  it('completes a dismissal whose republish already ran, without a moved-on conflict', async () => {
    await seed({ mode: 'active', holdMeta: { versionIds: [101] } });
    dbMock.dbWrite.modelVersion.findMany.mockResolvedValue([
      { id: 101, status: 'Draft', meta: {} },
    ]);
    mocks.publishModelHandler.mockImplementationOnce(async () => {
      await db.pg.query(`UPDATE "Model" SET "status" = 'Published', "meta" = '{}'::jsonb`);
    });
    const spy = vi.spyOn(dbMock.dbWrite.textScanHold, 'updateMany');
    spy.mockRejectedValueOnce(new Error('db down'));
    await expect(decide('dismiss_allowed')).rejects.toThrow('db down');

    await decide('dismiss_allowed');
    expect(mocks.publishModelHandler).toHaveBeenCalledTimes(1);
    const ruled = await hold();
    expect(ruled).toMatchObject({ status: 'Dismissed' });
    expect(ruled.restoredAt).toBeInstanceOf(Date);
  });

  it('aborts loudly when the effect marker cannot be recorded, leaving the new claim holder alone', async () => {
    await seed({ mode: 'shadow' });
    // The claim is taken over while the strike runs, so the marker write matches no row.
    mocks.createStrike.mockImplementationOnce(async () => {
      await db.pg.query(
        `UPDATE "TextScanHold" SET meta = meta || jsonb_build_object('decisionClaim', jsonb_build_object('by', 8, 'at', now() + interval '1 second'))`
      );
      return { id: 31 };
    });
    const failure = await decide('confirm_strike').catch((e) => e);
    expect(failure).toMatchObject({ code: 'CONFLICT' });
    // The effect ran unrecorded: this is a fault to investigate, never a benign refusal.
    expect(isModelRulesHoldRefusal(failure)).toBe(false);
    const left = await hold();
    expect(left.status).toBe('Pending');
    expect(left.meta).toMatchObject({ decisionClaim: { by: 8 } });
    expect(left.meta).not.toHaveProperty('effects');
  });

  it('reports a lost claim in a batch as a fault, not a refusal, and logs it', async () => {
    await seed({ mode: 'shadow' });
    mocks.createStrike.mockImplementationOnce(async () => {
      await db.pg.query(
        `UPDATE "TextScanHold" SET meta = meta || jsonb_build_object('decisionClaim', jsonb_build_object('by', 8, 'at', now() + interval '1 second'))`
      );
      return { id: 31 };
    });
    // A batch cannot strike, so the strike path is driven through the real decide with a strike decision.
    const results = await decideModelRulesHoldBatch({
      holds: [{ holdId: 12, textHash: HASH }],
      decision: 'confirm_strike' as never,
      actor,
      tracker: tracker as never,
    });
    expect(results[0]).toMatchObject({ ok: false, refused: false, stale: false });
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', holdId: 12 })
    );
  });
});

describe('what a hold means', () => {
  it('follows the mode it was detected in, not the model it finds now', async () => {
    // Detected in Review, but the model has since been taken down by someone else.
    await seed({ mode: 'shadow', status: 'UnpublishedViolation' });
    await decide('dismiss_not_subject');
    expect(mocks.publishModelHandler).not.toHaveBeenCalled();
  });
});

describe('refusals', () => {
  it('refuses a hash the moderator did not review', async () => {
    await seed();
    await expect(decide('confirm', { textHash: 'old' })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('Reload'),
    });
    expect(mocks.unpublishModelById).not.toHaveBeenCalled();
  });

  it('refuses a live model whose text changed since detection, leaving no claim', async () => {
    await seed();
    mocks.loadSubjects.mockResolvedValue(
      new Map([[9, { ...subject, fields: [{ heading: 'Name', text: 'Renamed' }] }]])
    );
    await expect(decide('confirm')).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('Reload'),
    });
    expect(mocks.unpublishModelById).not.toHaveBeenCalled();
    expect((await hold()).meta).not.toHaveProperty('decisionClaim');
  });

  it('refuses a hold decided already', async () => {
    await seed();
    await decide('dismiss_allowed');
    await expect(decide('confirm')).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mocks.unpublishModelById).not.toHaveBeenCalled();
  });

  it('refuses a hold a newer detection superseded', async () => {
    await seed({ holdStatus: 'Dismissed', holdMeta: { decision: 'superseded' } });
    await expect(decide('confirm')).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('newer scan'),
    });
    expect(mocks.unpublishModelById).not.toHaveBeenCalled();
  });

  it('refuses a hold of another label', async () => {
    await seed();
    await db.pg.query(`UPDATE "TextScanHold" SET "label" = 'csam'`);
    await expect(decide('confirm')).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('refuses a second decision while a live claim exists', async () => {
    await seed();
    await db.pg.query(
      `UPDATE "TextScanHold" SET meta = meta || jsonb_build_object('decisionClaim', jsonb_build_object('by', 8, 'at', now()))`
    );
    await expect(decide('confirm')).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mocks.unpublishModelById).not.toHaveBeenCalled();
  });

  it('releases its claim when an effect fails, so the call can be repeated', async () => {
    await seed();
    mocks.unpublishModelById.mockRejectedValueOnce(new Error('db down'));
    await expect(decide('confirm')).rejects.toThrow('db down');
    expect((await hold()).meta).not.toHaveProperty('decisionClaim');
    await decide('confirm');
    expect((await hold()).status).toBe('Confirmed');
  });
});

describe('which failures are refusals', () => {
  it('counts only the expected refusals, not other TRPC errors', async () => {
    const { TRPCError } = await import('@trpc/server');
    expect(isModelRulesHoldRefusal(new TRPCError({ code: 'CONFLICT', message: 'x' }))).toBe(false);
    expect(
      isModelRulesHoldRefusal(new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'x' }))
    ).toBe(false);
    expect(isModelRulesHoldRefusal(new Error('db down'))).toBe(false);

    await seed();
    await decide('dismiss_allowed');
    expect(isModelRulesHoldRefusal(await decide('confirm').catch((e) => e))).toBe(true);
    expect(
      isModelRulesHoldRefusal(await decide('confirm', { textHash: 'old' }).catch((e) => e))
    ).toBe(true);
  });

  it('counts a strike with no recorded owner as a refusal', async () => {
    await seed({ userId: null });
    expect(isModelRulesHoldRefusal(await decide('confirm_strike').catch((e) => e))).toBe(true);
  });
});

describe('the label-store record', () => {
  it('writes one label per matched rule in the ruling, with what was asked and answered', async () => {
    await seed();
    await decide('dismiss_not_subject');

    expect(await labels()).toEqual([
      expect.objectContaining({
        value: 'not_this_subject',
        reason: 'dismiss_not_subject',
        subjectType: 'model_text',
        subjectId: '9',
        sourceRef: 'TextScanHold:12:rule:3',
      }),
      expect.objectContaining({
        value: 'not_this_subject',
        subjectType: 'model_text',
        sourceRef: 'TextScanHold:12:rule:4',
      }),
    ]);
    expect((await db.pg.query('SELECT * FROM label_store.record_failure')).rows).toEqual([]);
  });

  it.each([
    ['confirm', 'violation'],
    ['confirm_strike', 'violation'],
    ['dismiss_allowed', 'allowed_use'],
  ] as const)('%s records %s', async (decision, value) => {
    await seed();
    await decide(decision);
    expect((await labels()).map((l) => l.value)).toEqual([value, value]);
  });

  it('marks a batched ruling apart from a reviewed one', async () => {
    await seed();
    await decide('confirm', { batched: true });
    expect((await labels()).map((l) => l.reason)).toEqual(['batch_apply', 'batch_apply']);
  });

  it('snapshots the scanned text and every matched rule on the subject', async () => {
    await seed();
    await decide('confirm');
    const { rows } = await db.pg.query<{ snapshot: Record<string, unknown> }>(
      `SELECT "snapshot" FROM label_store.subject`
    );
    expect(rows).toEqual([{ snapshot: { text: 'Name\nHero One LoRA', ruleIds: [3, 4] } }]);
  });
});

describe('deciding holds in a batch', () => {
  it('never carries a strike', () => {
    const base = { holds: [{ holdId: 1, textHash: 'a' }] };
    expect(
      resolveModelRulesHoldInput.safeParse({ ...base, decision: 'confirm_strike' }).success
    ).toBe(false);
    expect(resolveModelRulesHoldInput.safeParse({ ...base, decision: 'confirm' }).success).toBe(
      true
    );
  });

  it('decides each hold on its own, reporting a stale one without stopping the rest', async () => {
    const decideOne = vi
      .fn()
      .mockResolvedValueOnce({ status: 'Confirmed', entityId: 9, userId: 5 })
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ status: 'Confirmed', entityId: 10, userId: 5 });

    const results = await decideModelRulesHoldBatch({
      holds: [
        { holdId: 1, textHash: 'a' },
        { holdId: 2, textHash: 'b' },
        { holdId: 3, textHash: 'c' },
      ],
      decision: 'confirm',
      actor,
      tracker: tracker as never,
      decide: decideOne,
    });

    expect(results.map((r) => [r.holdId, r.ok])).toEqual([
      [1, true],
      [2, false],
      [3, true],
    ]);
    expect(results[1]).toMatchObject({ refused: false });
    expect(decideOne.mock.calls.map(([a]) => [a.holdId, a.decision, a.batched])).toEqual([
      [1, 'confirm', true],
      [2, 'confirm', true],
      [3, 'confirm', true],
    ]);
    expect(mocks.createStrike).not.toHaveBeenCalled();
  });
});
