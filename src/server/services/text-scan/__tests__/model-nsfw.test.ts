import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';

const { entityChangesMock, checkSfwFaceMock } = vi.hoisted(() => ({
  entityChangesMock: vi.fn(),
  checkSfwFaceMock: vi.fn(),
}));

// The package's ESM build can't be loaded here; the face check it backs is passed in instead.
vi.mock('@civitai/orchestration-client', () => ({
  createCivitaiClient: vi.fn(() => ({})),
  submitWorkflow: vi.fn(),
}));

// Hand-listed, as in model-moderation.adapter.test.ts: each real module builds clients at load.
vi.mock('~/server/services/nsfwLevels.service', () => ({ updateModelNsfwLevels: vi.fn() }));
vi.mock('~/server/services/model-version.service', () => ({
  bustPublicModelResponseCache: vi.fn(),
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/services/job-queue.service', () => ({ enqueueJobs: vi.fn() }));
vi.mock('~/server/clickhouse/tracker', () => ({
  Tracker: class {
    entityChanges = entityChangesMock;
  },
}));

const { applyModelNsfwTextScan, finishHeldVerdictApply } = await import(
  '~/server/services/text-scan/actions/model-nsfw'
);
const { enqueueJobs } = await import('~/server/services/job-queue.service');
const { bustPublicModelResponseCache } = await import('~/server/services/model-version.service');
const { updateModelNsfwLevels } = await import('~/server/services/nsfwLevels.service');
const { createNotification } = await import('~/server/services/notification.service');
const { sfwFaceStampHash } = await import('~/server/services/model-sfw-face-stamp');

const args = (raised: boolean) => ({
  entityId: 1,
  workflowId: 'wf',
  textHash: 'hash',
  outcome: {
    nsfw: { detectedLevel: NsfwLevel.X, declaredLevel: NsfwLevel.PG13, raised, reason: 'r' },
    triggeredLabels: raised ? ['nsfw' as const] : [],
    nsfwLevel: NsfwLevel.X,
  },
  subject: { fields: [], declared: {} },
});
const model = (over: Record<string, unknown> = {}) => ({
  id: 1,
  name: 'LoRA',
  nsfw: false,
  nsfwLevel: 1,
  lockedProperties: [],
  userId: 99,
  ...over,
});
// Nested `Prisma.raw` fragments are inlined so an assertion sees the SQL that runs; bound values stay `?`.
const flipSql = () =>
  dbMock.dbWrite.$executeRaw.mock.calls
    .map(([strings, ...values]: [readonly string[], ...unknown[]]) =>
      strings.reduce((sql, part, i) => {
        if (i === 0) return part;
        const v = values[i - 1];
        const raw = (v as { sql?: unknown } | null)?.sql;
        const inlined = typeof raw === 'string' ? raw : '?';
        return sql + inlined + part;
      }, '')
    )
    .find((sql: string) => sql.includes('SET nsfw = TRUE'));

beforeEach(() => {
  vi.clearAllMocks();
  entityChangesMock.mockResolvedValue(undefined);
  dbMock.dbWrite.$executeRaw.mockResolvedValue(1);
  dbMock.dbWrite.model.findUnique.mockResolvedValue(model());
});

describe('applyModelNsfwTextScan', () => {
  it('flips nsfw without locking it, attributes it to the text scan, and notifies the owner once', async () => {
    await applyModelNsfwTextScan(args(true));
    expect(flipSql()).not.toContain('array_append');
    expect(flipSql()).toContain(`NOT ('nsfw' = ANY(`);
    // Merged into meta in the same guarded write, never written back from a read.
    expect(flipSql()).toMatch(
      /meta = \(CASE WHEN jsonb_typeof\(m\.meta\) = 'object' THEN m\.meta ELSE '\{\}'::jsonb END\) \|\| CASE\s+WHEN m\."sfwOnly"[\s\S]*ELSE '\{\}'::jsonb END \|\| jsonb_build_object\(\s*'systemNsfwLock', jsonb_build_object\('source', \?::text, 'at', now\(\)\)/
    );
    const flipCall = dbMock.dbWrite.$executeRaw.mock.calls.find((c: unknown[]) =>
      (c[0] as readonly string[]).join('?').includes('SET nsfw = TRUE')
    );
    expect(flipCall).toContain('text-scan');
    expect(updateModelNsfwLevels).toHaveBeenCalledWith([1]);
    expect(entityChangesMock).toHaveBeenCalled();
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 99,
        type: 'text-scan-rating-raised',
        key: `text-scan-rating-raised-Model-1-${NsfwLevel.X}-wf`,
        details: expect.objectContaining({ url: '/models/1', title: 'LoRA' }),
      })
    );
  });

  it('never touches nsfw for an outcome that did not ask for it (the web-search pass)', async () => {
    await applyModelNsfwTextScan({
      ...args(false),
      outcome: { triggeredLabels: ['poi'], nsfwLevel: null },
    });
    expect(dbMock.dbWrite.model.findUnique).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('is silent on redelivery: the model is already nsfw', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(model({ nsfw: true, nsfwLevel: 60 }));
    await applyModelNsfwTextScan(args(true));
    expect(flipSql()).toBeUndefined();
    expect(updateModelNsfwLevels).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  // The face keeps it on .com; rated, the model stays mature whatever later removes the face.
  it('rates a model with a complete .com face too, without the notice to add one', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(
      model({ sfwName: 'Safe title', sfwCoverImageId: 5, nsfwLevel: NsfwLevel.PG })
    );
    await applyModelNsfwTextScan(args(true));
    expect(flipSql()).toBeDefined();
    expect(flipSql()).not.toContain('array_append');
    expect(createNotification).not.toHaveBeenCalled();
  });

  it.each([
    ['no .com cover', { sfwName: 'Safe title', sfwCoverImageId: null }],
    ['no .com title', { sfwName: null, sfwCoverImageId: 5 }],
    [
      'a cover the level computation refused',
      { sfwName: 'Safe title', sfwCoverImageId: 5, nsfwLevel: NsfwLevel.R },
    ],
  ])('still flips with an incomplete .com face (%s)', async (_, face) => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(model(face));
    await applyModelNsfwTextScan(args(true));
    expect(flipSql()).toBeDefined();
    expect(flipSql()).not.toContain('array_append');
    expect(createNotification).toHaveBeenCalledTimes(1);
  });

  it('never overturns a moderator lock', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(model({ lockedProperties: ['nsfw'] }));
    await applyModelNsfwTextScan(args(true));
    expect(flipSql()).toBeUndefined();
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('does not notify when a lock landed between read and write', async () => {
    dbMock.dbWrite.$executeRaw.mockResolvedValue(0);
    await applyModelNsfwTextScan(args(true));
    expect(updateModelNsfwLevels).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  it.each(['poi', 'minor'] as const)(
    'flips and returns the rating notice instead of sending it when the same scan detects %s',
    async (label) => {
      const base = args(true);
      const flag = { detected: true, declared: false, newlyDetected: true, reason: 'r' };
      const result = await applyModelNsfwTextScan({
        ...base,
        outcome: { ...base.outcome, [label]: label === 'poi' ? { ...flag, names: ['A'] } : flag },
      });
      expect(flipSql()).toBeDefined();
      expect(flipSql()).not.toContain('array_append');
      expect(createNotification).not.toHaveBeenCalled();
      expect(result).toEqual({
        deferredRatingNotice: {
          entityType: 'Model',
          entityId: 1,
          userId: 99,
          level: NsfwLevel.X,
          title: 'LoRA',
          url: '/models/1',
          workflowId: 'wf',
        },
      });
    }
  );

  it('returns no deferred notice when it sent one or none was due', async () => {
    expect(await applyModelNsfwTextScan(args(true))).toEqual({ deferredRatingNotice: null });
    expect(await applyModelNsfwTextScan(args(false))).toEqual({ deferredRatingNotice: null });
  });

  it('does nothing when the model is gone', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(null);
    await applyModelNsfwTextScan(args(true));
    expect(flipSql()).toBeUndefined();
    expect(createNotification).not.toHaveBeenCalled();
  });
});

// W1: a Model is rated on R+ text whatever it declared, unless it has a complete .com face whose text
// passed the face check. That face lists it on .com as safe; anything less and the scan rates it.
describe('applyModelNsfwTextScan and the .com face', () => {
  const face = {
    sfwName: 'Retro Poster Style',
    sfwDescription: '<p>A retro poster illustration style.</p>',
    sfwCoverImageId: 5,
    nsfwLevel: NsfwLevel.PG,
  };
  const stampFor = (f: {
    sfwName: string | null;
    sfwDescription: string | null;
    sfwCoverImageId: number | null;
  }) => ({
    sfwFaceCheckedAt: { at: '2026-11-20T00:00:00.000Z', promptId: 7, hash: sfwFaceStampHash(f) },
  });
  /** A face as the save gate leaves it: stamped for its own values. */
  const stamped = (over: Record<string, unknown> = {}) => {
    const f = { ...face, ...over } as typeof face;
    return model({ ...f, meta: stampFor(f) });
  };
  const sqlWith = (fragment: string) =>
    dbMock.dbWrite.$executeRaw.mock.calls
      .map(([strings]: [readonly string[]]) => strings.join('?'))
      .find((sql: string) => sql.includes(fragment));
  const stampSql = () => sqlWith('sfwFaceCheckedAt');
  const markerSql = () =>
    dbMock.dbWrite.$executeRaw.mock.calls
      .map(([strings]: [readonly string[]]) => strings.join('?'))
      .find(
        (sql: string) =>
          sql.includes("'systemNsfwLock', jsonb_build_object('source'") &&
          !sql.includes('SET nsfw = TRUE')
      );
  const clean = { status: 'clean', promptId: 7 } as const;
  const scan = (a: Parameters<typeof applyModelNsfwTextScan>[0]) =>
    applyModelNsfwTextScan(a, { checkSfwFace: checkSfwFaceMock });
  const rated = (detectedLevel: number, declaredLevel: number) => ({
    ...args(detectedLevel > declaredLevel),
    outcome: {
      nsfw: { detectedLevel, declaredLevel, raised: detectedLevel > declaredLevel, reason: 'r' },
      triggeredLabels: detectedLevel > declaredLevel ? ['nsfw' as const] : [],
      nsfwLevel: detectedLevel,
    },
  });

  beforeEach(() => {
    dbMock.dbWrite.image.findUnique.mockResolvedValue({ nsfwLevel: NsfwLevel.PG });
    checkSfwFaceMock.mockResolvedValue({ sfwName: clean, sfwDescription: clean });
  });

  it('leaves a model with a complete, clean, stamped face unrated, without re-checking it', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(stamped());
    await scan(args(true));
    expect(flipSql()).toBeUndefined();
    expect(markerSql()).toBeUndefined();
    expect(updateModelNsfwLevels).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
    expect(checkSfwFaceMock).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.image.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 5 } })
    );
  });

  it.each([
    ['no .com description', { sfwDescription: null }],
    ['a .com description that is only markup', { sfwDescription: '<p> </p>' }],
    ['no .com title', { sfwName: null }],
    ['no .com cover', { sfwCoverImageId: null }],
  ])('flips a model with no complete face (%s)', async (_, over) => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(stamped(over));
    await scan(args(true));
    expect(flipSql()).toBeDefined();
    expect(checkSfwFaceMock).not.toHaveBeenCalled();
  });

  it('flips a model whose .com cover image is gone', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(stamped());
    dbMock.dbWrite.image.findUnique.mockResolvedValue(null);
    await scan(args(true));
    expect(flipSql()).toBeDefined();
  });

  it.each([
    ['R', NsfwLevel.R],
    ['X', NsfwLevel.X],
    ['not rated yet', 0],
  ])('flips a model whose .com cover is over the PG-13 cap (%s)', async (_, nsfwLevel) => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(stamped());
    dbMock.dbWrite.image.findUnique.mockResolvedValue({ nsfwLevel });
    await scan(args(true));
    expect(flipSql()).toBeDefined();
  });

  it('lets a PG-13 .com cover count as clean', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(stamped());
    dbMock.dbWrite.image.findUnique.mockResolvedValue({ nsfwLevel: NsfwLevel.PG13 });
    await scan(args(true));
    expect(flipSql()).toBeUndefined();
  });

  it.each([
    ['the .com title changed', { meta: stampFor(face), sfwName: 'Edited title' }],
    ['the .com description changed', { meta: stampFor(face), sfwDescription: '<p>New text.</p>' }],
    ['the .com cover changed', { meta: stampFor(face), sfwCoverImageId: 6 }],
    ['there is no stamp', { meta: null }],
  ])('re-checks the face when %s, and stamps it when it passes', async (_, over) => {
    const row = model({ ...face, ...over });
    dbMock.dbWrite.model.findUnique.mockResolvedValue(row);
    await scan(args(true));
    expect(checkSfwFaceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sfwName: row.sfwName,
        sfwDescription: row.sfwDescription,
        modelId: 1,
        userId: 99,
      })
    );
    expect(flipSql()).toBeUndefined();
    const stampCall = dbMock.dbWrite.$executeRaw.mock.calls.find((c: unknown[]) =>
      (c[0] as readonly string[]).join('?').includes('sfwFaceCheckedAt')
    );
    expect(stampCall).toBeDefined();
    // Only onto the face it checked: an edit landing since leaves its row unstamped.
    expect(stampSql()).toMatch(/"sfwName" IS NOT DISTINCT FROM \?/);
    expect(stampSql()).toMatch(/"sfwDescription" IS NOT DISTINCT FROM \?/);
    expect(stampSql()).toMatch(/"sfwCoverImageId" IS NOT DISTINCT FROM \?/);
    const stamp = JSON.parse(
      (stampCall as unknown[]).find((v) => typeof v === 'string' && v.includes('"hash"')) as string
    );
    expect(stamp).toMatchObject({
      promptId: 7,
      hash: sfwFaceStampHash({
        sfwName: row.sfwName as string,
        sfwDescription: row.sfwDescription as string,
        sfwCoverImageId: row.sfwCoverImageId as number,
      }),
    });
  });

  it.each([
    ['unavailable', { sfwName: clean, sfwDescription: { status: 'unavailable' } }],
    ['flagged', { sfwName: { status: 'flagged', level: 'X', reason: 'r' }, sfwDescription: clean }],
    [
      'flagged on the version text',
      {
        sfwName: clean,
        sfwDescription: clean,
        versions: { status: 'flagged', level: 'R', reason: 'r' },
      },
    ],
    ['missing a verdict for the description', { sfwName: clean }],
  ])('fails closed: flips when the re-check is %s, and writes no stamp', async (_, verdicts) => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(model({ ...face, meta: null }));
    checkSfwFaceMock.mockResolvedValue(verdicts);
    await scan(args(true));
    expect(flipSql()).toBeDefined();
    expect(stampSql()).toBeUndefined();
  });

  it('fails closed when the re-check throws', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(model({ ...face, meta: null }));
    checkSfwFaceMock.mockRejectedValue(new Error('orchestrator down'));
    await scan(args(true));
    expect(flipSql()).toBeDefined();
    expect(stampSql()).toBeUndefined();
  });

  it('records the scan marker on an already-mature model with R+ text and no face, though it declared mature', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(model({ nsfw: true, nsfwLevel: 60 }));
    await scan(rated(NsfwLevel.R, NsfwLevel.XXX));
    expect(markerSql()).toBeDefined();
    expect(flipSql()).toBeUndefined();
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('records no marker on an already-mature model with a complete, clean face', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(stamped({ nsfw: true, nsfwLevel: 61 }));
    await scan(rated(NsfwLevel.X, NsfwLevel.XXX));
    expect(markerSql()).toBeUndefined();
    expect(flipSql()).toBeUndefined();
  });

  it('never rates on PG-13 text, face or not', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(model());
    await scan(rated(NsfwLevel.PG13, NsfwLevel.PG13));
    expect(flipSql()).toBeUndefined();
    expect(markerSql()).toBeUndefined();
    expect(dbMock.dbWrite.model.findUnique).not.toHaveBeenCalled();
  });

  it('still holds a restricted model for a moderator, without checking its face', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(stamped({ minor: true }));
    await scan(args(true));
    expect(flipSql()).toBeUndefined();
    expect(checkSfwFaceMock).not.toHaveBeenCalled();
  });
});

describe('applyModelNsfwTextScan on a model its owner restricted', () => {
  it.each(['minor', 'poi'] as const)(
    'never marks a %s model nsfw: holds the verdict for a moderator instead',
    async (flag) => {
      dbMock.dbWrite.model.findUnique.mockResolvedValue(model({ [flag]: true }));
      const result = await applyModelNsfwTextScan(args(true));
      expect(flipSql()).toBeUndefined();
      expect(updateModelNsfwLevels).not.toHaveBeenCalled();
      expect(createNotification).not.toHaveBeenCalled();
      expect(result).toEqual({ deferredRatingNotice: null });
    }
  );

  it('rates an SFW-only model as any other and tells the owner', async () => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue(model({ sfwOnly: true }));
    await applyModelNsfwTextScan(args(true));
    expect(updateModelNsfwLevels).toHaveBeenCalledWith([1]);
    expect(createNotification).toHaveBeenCalled();
  });

  it('holds the verdict when a restriction landed between read and write', async () => {
    dbMock.dbWrite.$executeRaw.mockImplementation(async (strings: readonly string[]) =>
      strings.join('?').includes('SET nsfw = TRUE') ? 0 : 1
    );
    await applyModelNsfwTextScan(args(true));
    expect(updateModelNsfwLevels).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });
});

describe('finishHeldVerdictApply', () => {
  const nsfwLevelJob = [{ entityId: 7, entityType: 'Model', type: 'UpdateNsfwLevel' }];
  beforeEach(() => {
    vi.mocked(updateModelNsfwLevels).mockResolvedValue(undefined as never);
    vi.mocked(bustPublicModelResponseCache).mockResolvedValue(undefined as never);
    vi.mocked(enqueueJobs).mockResolvedValue(undefined);
  });

  it('refreshes the level and the public cache, queueing nothing', async () => {
    await finishHeldVerdictApply(7);
    expect(updateModelNsfwLevels).toHaveBeenCalledWith([7]);
    expect(bustPublicModelResponseCache).toHaveBeenCalledWith(7);
    expect(enqueueJobs).not.toHaveBeenCalled();
  });

  it('queues the model for the nsfw-level job when the refresh fails, without throwing', async () => {
    vi.mocked(updateModelNsfwLevels).mockRejectedValueOnce(new Error('db down'));
    await expect(finishHeldVerdictApply(7)).resolves.toBeUndefined();
    expect(enqueueJobs).toHaveBeenCalledWith(nsfwLevelJob);
  });

  it('still does not throw when the queue write fails too', async () => {
    vi.mocked(updateModelNsfwLevels).mockRejectedValueOnce(new Error('db down'));
    vi.mocked(enqueueJobs).mockRejectedValueOnce(new Error('db down'));
    await expect(finishHeldVerdictApply(7)).resolves.toBeUndefined();
  });
});
