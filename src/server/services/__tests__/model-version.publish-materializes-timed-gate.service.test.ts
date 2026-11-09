import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { increaseDate } from '~/utils/date-helpers';

// A timed Early Access gate is stored pending (endsAt NULL) until publish materializes
// endsAt = publishedAt + timeframeDays. Every read treats a timed row with endsAt NULL as live with no
// end, so a publish that skips the materialize leaves a PERMANENT gate on a version the creator set to
// timed. The publish skipped it whenever the version already carried a past publishedAt: the anti-bump
// guard blocks the write (writeCount 0) and the materialize sat behind `writeCount > 0`. "Publish now"
// lands there when a client clock running ahead turns it into a seconds-long schedule and the version
// is then published directly once that moment has passed.
//
// `materializePaidAccessEndsAt` runs for real so the assertions are on the endsAt written, not on a
// call shape.

vi.mock('~/server/cloudflare/client', () => ({ purgeCache: vi.fn() }));
vi.mock('~/server/utils/url-helpers', () => ({
  getBaseUrl: () => 'https://civitai.com',
  getInternalUrl: () => 'http://localhost:3000',
}));
vi.mock('~/server/prom/client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, dbReadFallbackCounter: { inc: vi.fn() } };
});
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
vi.mock('~/server/redis/caches', () => ({
  dataForModelsCache: { refresh: vi.fn() },
  modelVersionAccessCache: { refresh: vi.fn() },
  modelVersionPublicDonationGoalsCache: {},
  modelVersionResourceCache: {},
}));
vi.mock('~/server/redis/resource-data.redis', () => ({ resourceDataCache: { bust: vi.fn() } }));
vi.mock('~/server/search-index', () => ({
  modelsSearchIndex: { queueUpdate: vi.fn() },
  imagesSearchIndex: { queueUpdate: vi.fn() },
  imagesMetricsSearchIndex: { queueUpdate: vi.fn() },
}));
vi.mock('~/server/utils/cache-helpers', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createCachedObject: () => ({ fetch: vi.fn(async () => ({})), bust: vi.fn() }),
    bustFetchThroughCache: vi.fn(),
  };
});
vi.mock('~/server/services/auction.service', () => ({ deleteBidsForModelVersion: vi.fn() }));
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedLinkDomain: vi.fn(),
  throwOnBlockedUserContent: vi.fn(),
}));
vi.mock('~/server/services/buzz.service', () => ({}));
vi.mock('~/server/services/common.service', () => ({ hasEntityAccess: vi.fn() }));
vi.mock('~/server/services/donation-goal.service', () => ({ checkDonationGoalComplete: vi.fn() }));
vi.mock('~/server/services/image.service', () => ({
  imagesForModelVersionsCache: { refresh: vi.fn() },
  uploadImageFromUrl: vi.fn(),
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/services/orchestrator/models', () => ({ bustOrchestratorModelCache: vi.fn() }));
vi.mock('~/server/services/post.service', () => ({ addPostImage: vi.fn(), createPost: vi.fn() }));
vi.mock('~/server/services/model.service', () => ({ updateModelLastVersionAt: vi.fn() }));
vi.mock('~/server/services/model-file.service', () => ({
  deleteFilesForModelVersionCache: vi.fn(),
  findOfficialFileByHash: vi.fn(),
  markFileReplaced: vi.fn(),
}));
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, preventModelVersionLag: vi.fn() };
});
vi.mock('~/utils/s3-utils', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, deleteModelFileObjects: vi.fn() };
});

import {
  publishModelVersionById,
  publishModelVersionsWithEarlyAccess,
  updateModelVersionById,
} from '~/server/services/model-version.service';

const VERSION_ID = 101;
const MODEL_ID = 202;
const OWNER_ID = 303;
const DAYS = 3;

// The moment the version went live: already past when the direct publish arrives.
const STORED_PUBLISHED_AT = new Date(Date.now() - 5_000);

const pendingGate = { timeframeDays: DAYS, endsAt: null };

/** Make the anti-bump UPDATE of ModelVersion.publishedAt report `count` rows; every other raw write 0. */
function guardWrites(count: number) {
  dbMock.dbWrite.$executeRaw.mockImplementation((async (strings: TemplateStringsArray) =>
    /UPDATE "ModelVersion"\s+SET "publishedAt"/.test(strings.join('?')) ? count : 0) as never);
}

function endsAtWrites() {
  return dbMock.dbWrite.paidAccess.update.mock.calls.map(
    ([args]) => (args as { data: { endsAt: Date } }).data.endsAt
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  guardWrites(0);
  dbMock.dbWrite.modelVersion.findMany.mockResolvedValue([
    {
      id: VERSION_ID,
      name: 'v1',
      baseModel: 'Illustrious',
      publishedAt: STORED_PUBLISHED_AT,
      model: { id: MODEL_ID, userId: OWNER_ID, name: 'model', nsfw: false, meta: {} },
    },
  ]);
  dbMock.dbWrite.modelVersion.findUnique.mockResolvedValue({ publishedAt: STORED_PUBLISHED_AT });
  dbMock.dbWrite.modelVersion.update.mockResolvedValue({
    id: VERSION_ID,
    modelId: MODEL_ID,
    baseModel: 'Illustrious',
    publishedAt: STORED_PUBLISHED_AT,
    model: { userId: OWNER_ID, id: MODEL_ID, type: 'LORA', nsfw: false },
  });
  dbMock.dbWrite.paidAccess.findUnique.mockResolvedValue(pendingGate);
  dbMock.dbWrite.paidAccess.update.mockResolvedValue({});
});

describe('publish materializes a timed gate from the publishedAt the version carries', () => {
  it('publishModelVersionsWithEarlyAccess: a version already dated in the past gets endsAt', async () => {
    await publishModelVersionsWithEarlyAccess({
      modelVersionIds: [VERSION_ID],
      publishedAt: new Date(),
    });

    expect(endsAtWrites()).toEqual([increaseDate(STORED_PUBLISHED_AT, DAYS, 'days')]);
  });

  it('publishModelVersionById: "publish now" on a version whose schedule just passed gets endsAt', async () => {
    dbMock.dbRead.modelVersion.findUniqueOrThrow.mockResolvedValue({
      id: VERSION_ID,
      name: 'v1',
      baseModel: 'Illustrious',
      publishedAt: STORED_PUBLISHED_AT,
      meta: {},
      model: {
        userId: OWNER_ID,
        type: 'LORA',
        name: 'model',
        availability: 'Public',
        publishedAt: new Date('2026-01-01'),
        nsfw: false,
        meta: {},
      },
    });
    dbMock.dbWrite.paidAccess.findFirst.mockResolvedValue({ entityId: VERSION_ID });
    dbMock.dbWrite.post.findMany.mockResolvedValue([]);
    dbMock.dbWrite.image.findMany.mockResolvedValue([]);
    dbMock.dbRead.modelFileHash.findMany.mockResolvedValue([]);

    await publishModelVersionById({ id: VERSION_ID, enforceTakedown: false });

    expect(endsAtWrites()).toEqual([increaseDate(STORED_PUBLISHED_AT, DAYS, 'days')]);
  });

  it('updateModelVersionById: a publish blocked by the guard still materializes from the stored date', async () => {
    dbMock.dbWrite.modelVersion.findUniqueOrThrow.mockResolvedValue({ model: { meta: {} } });

    await updateModelVersionById({
      id: VERSION_ID,
      enforceTakedown: false,
      data: { status: 'Published', publishedAt: new Date() },
    });

    expect(endsAtWrites()).toEqual([increaseDate(STORED_PUBLISHED_AT, DAYS, 'days')]);
  });

  it('a publish that writes publishedAt materializes from the new date', async () => {
    guardWrites(1);
    const now = new Date();

    await publishModelVersionsWithEarlyAccess({ modelVersionIds: [VERSION_ID], publishedAt: now });

    expect(endsAtWrites()).toEqual([increaseDate(now, DAYS, 'days')]);
  });

  // An end date that is not publishedAt + timeframeDays: creators and buyers have seen it, so a publish
  // that writes no publishedAt must not recompute it.
  const handSetGate = () => ({
    timeframeDays: DAYS,
    endsAt: increaseDate(STORED_PUBLISHED_AT, DAYS + 7, 'days'),
  });

  it('publishModelVersionsWithEarlyAccess: a republish leaves an active gate’s endsAt alone', async () => {
    dbMock.dbWrite.paidAccess.findUnique.mockResolvedValue(handSetGate());

    await publishModelVersionsWithEarlyAccess({
      modelVersionIds: [VERSION_ID],
      publishedAt: new Date(),
    });

    expect(dbMock.dbWrite.paidAccess.update).not.toHaveBeenCalled();
  });

  it('updateModelVersionById: a republish leaves an active gate’s endsAt alone', async () => {
    dbMock.dbWrite.paidAccess.findUnique.mockResolvedValue(handSetGate());
    dbMock.dbWrite.modelVersion.findUniqueOrThrow.mockResolvedValue({ model: { meta: {} } });

    await updateModelVersionById({
      id: VERSION_ID,
      enforceTakedown: false,
      data: { status: 'Published', publishedAt: new Date() },
    });

    expect(dbMock.dbWrite.paidAccess.update).not.toHaveBeenCalled();
  });

  it('a reschedule that writes publishedAt still moves an active gate’s endsAt', async () => {
    guardWrites(1);
    dbMock.dbWrite.paidAccess.findUnique.mockResolvedValue(handSetGate());
    const rescheduled = new Date(Date.now() + 86_400_000);

    await publishModelVersionsWithEarlyAccess({
      modelVersionIds: [VERSION_ID],
      publishedAt: rescheduled,
    });

    expect(endsAtWrites()).toEqual([increaseDate(rescheduled, DAYS, 'days')]);
  });

  it('a permanent gate stays permanent', async () => {
    dbMock.dbWrite.paidAccess.findUnique.mockResolvedValue({ timeframeDays: null, endsAt: null });

    await publishModelVersionsWithEarlyAccess({
      modelVersionIds: [VERSION_ID],
      publishedAt: new Date(),
    });

    expect(dbMock.dbWrite.paidAccess.update).not.toHaveBeenCalled();
  });
});

describe('publishing a version a moderator took down after the caller checked', () => {
  // The handler's status check runs before the write transaction; a takedown can land in between,
  // so the write re-reads the model, then the version, under a lock first. Each read answers apart,
  // so a check that drops either half shows up.
  const lockReads: string[] = [];
  const takenDown = ({ model = false, version = false }) =>
    dbMock.dbWrite.$queryRaw.mockImplementation((async (strings: string[], ...values: never[]) => {
      const sql = Prisma.sql(strings, ...values).text;
      lockReads.push(sql);
      return [{ downed: sql.includes('FROM "Model" WHERE') ? model : version }];
    }) as never);

  beforeEach(() => {
    lockReads.length = 0;
    dbMock.dbRead.modelVersion.findUniqueOrThrow.mockResolvedValue({
      id: VERSION_ID,
      name: 'v1',
      baseModel: 'Illustrious',
      publishedAt: null,
      meta: {},
      model: {
        userId: OWNER_ID,
        type: 'LORA',
        name: 'model',
        availability: 'Public',
        publishedAt: new Date('2026-01-01'),
        nsfw: false,
        meta: {},
      },
    });
    dbMock.dbWrite.paidAccess.findFirst.mockResolvedValue(null);
    dbMock.dbWrite.modelVersion.findUniqueOrThrow.mockResolvedValue({ model: { meta: {} } });
  });

  const publishVersion = (enforceTakedown: boolean) =>
    publishModelVersionById({ id: VERSION_ID, enforceTakedown });
  const publishPrivateVersion = (enforceTakedown: boolean) =>
    updateModelVersionById({
      id: VERSION_ID,
      data: { status: 'Published', publishedAt: new Date() },
      enforceTakedown,
    });

  it.each([
    ['publishModelVersionById', publishVersion],
    ['updateModelVersionById', publishPrivateVersion],
  ])(
    '%s refuses the owner on a taken-down version or model, and writes nothing',
    async (_n, run) => {
      for (const downed of [{ version: true }, { model: true }]) {
        dbMock.dbWrite.modelVersion.update.mockClear();
        takenDown(downed);

        await expect(run(true)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
        expect(dbMock.dbWrite.modelVersion.update).not.toHaveBeenCalled();
      }
    }
  );

  it.each([
    ['publishModelVersionById', publishVersion],
    ['updateModelVersionById', publishPrivateVersion],
  ])('%s still publishes for the owner when nothing is taken down', async (_n, run) => {
    takenDown({});

    await run(true).catch(() => undefined);
    expect(dbMock.dbWrite.modelVersion.update).toHaveBeenCalled();
  });

  it.each([
    ['publishModelVersionById', publishVersion],
    ['updateModelVersionById', publishPrivateVersion],
  ])('%s lets a moderator through', async (_n, run) => {
    takenDown({ model: true, version: true });

    await run(false).catch(() => undefined);
    expect(dbMock.dbWrite.modelVersion.update).toHaveBeenCalled();
  });

  // An update lock, model first: these rows are written next, and two publishes holding share locks
  // that both upgrade to a write deadlock (40P01, measured on Postgres 17 with two connections).
  it('reads under an update lock, the model before the version', async () => {
    takenDown({});

    await publishVersion(true).catch(() => undefined);
    expect(
      lockReads.slice(0, 2).map((sql) => /FROM "(Model|ModelVersion)" WHERE/.exec(sql)?.[1])
    ).toEqual(['Model', 'ModelVersion']);
    expect(lockReads.slice(0, 2).every((sql) => sql.includes('FOR NO KEY UPDATE'))).toBe(true);
  });
});
