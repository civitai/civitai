import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type { Context } from '~/server/createContext';
import { updateEntityAvailabilityHandler } from '~/server/controllers/common.controller';
import { REDIS_SYS_KEYS } from '~/server/redis/client';
import { clearKnightsSourcesConfigCache } from '~/server/services/knights/sources';
import { Availability } from '~/shared/utils/prisma/enums';

// The Knights reads, recorded at the database boundary: `writesBefore` is how many availability
// writes had run when each statement was sent.
const { statements } = vi.hoisted(() => ({
  statements: [] as { sql: string; values: unknown[]; writesBefore: number }[],
}));
vi.mock('~/server/db/kyselyDb', async () => {
  const { fakeKysely } = await import('~/test-utils/kysely-raw-fake');
  const { dbMock: db } = await import('~/__tests__/mocks/db.mock');
  const kysely = fakeKysely((strings, ...values) => {
    statements.push({
      sql: strings.join('?'),
      values,
      writesBefore: db.dbWrite.$executeRawUnsafe.mock.calls.length,
    });
    return [];
  });
  return { kyselyWrite: kysely, kyselyRead: kysely };
});
// A model leaving Private applies any held scan verdict in the same transaction; none is held here.
vi.mock('~/server/services/text-scan/actions/model-nsfw', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  applyHeldVerdictLeavingPrivate: vi.fn(async () => false),
  finishHeldVerdictApply: vi.fn(async () => undefined),
}));

// The stored availability: `stored` until the availability write runs, then the value written, as the primary returns it.
let stored: Availability;
let written: Availability;
const setPost = (availability: Availability) => {
  written = availability;
  return updateEntityAvailabilityHandler({
    ctx: {} as Context,
    input: { entityType: 'Post', entityId: 5, availability },
  });
};
const imageReads = () => statements.filter((s) => s.sql.includes('from "Image"'));
const postsOfVersionsReads = () =>
  statements.filter((s) => s.sql.includes('from "Post"') && s.sql.includes('"modelVersionId" in'));
const setModel = (entityType: 'Model' | 'ModelVersion', availability: Availability) => {
  written = availability;
  return updateEntityAvailabilityHandler({
    ctx: {} as Context,
    input: { entityType, entityId: 3, availability },
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  statements.length = 0;
  clearKnightsSourcesConfigCache();
  redisMock.sysRedis.get.mockImplementation(async (key: string) =>
    key === REDIS_SYS_KEYS.SYSTEM.KNIGHTS_V2_SOURCES ? JSON.stringify({ enabled: true }) : null
  );
  dbMock.dbRead.image.findMany.mockResolvedValue([{ id: 50 }]);
  stored = Availability.Private;
  const storedNow = async () => ({
    availability: dbMock.dbWrite.$executeRawUnsafe.mock.calls.length === 0 ? stored : written,
  });
  dbMock.dbWrite.post.findUnique.mockImplementation(storedNow as never);
  dbMock.dbWrite.model.findUnique.mockImplementation(storedNow as never);
  dbMock.dbWrite.modelVersion.findUnique.mockImplementation(storedNow as never);
  dbMock.dbWrite.modelVersion.findMany.mockResolvedValue([{ id: 7 }, { id: 8 }] as never);
  dbMock.dbRead.modelVersion.findUniqueOrThrow.mockResolvedValue({ id: 3, modelId: 1 } as never);
});

describe('updateEntityAvailabilityHandler on a Post', () => {
  it("offers the post's images to Knights after the availability is written", async () => {
    await setPost(Availability.Public);

    await vi.waitFor(() => expect(imageReads().length).toBeGreaterThan(0));
    for (const read of imageReads()) {
      expect(read.sql).toContain('"img"."postId" in');
      expect(read.values.filter((v) => typeof v === 'number')).toContain(5);
      expect(read.writesBefore).toBe(1);
    }
  });

  it.each([
    ['Public to Unsearchable', Availability.Public, Availability.Unsearchable],
    ['Public to Public', Availability.Public, Availability.Public],
    ['Unsearchable to Public', Availability.Unsearchable, Availability.Public],
  ])('offers nothing when the post was not Private: %s', async (_label, before, after) => {
    stored = before;
    await setPost(after);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(dbMock.dbWrite.$executeRawUnsafe).toHaveBeenCalled();
    expect(imageReads()).toEqual([]);
  });

  it('offers nothing when the post is set to Private (control)', async () => {
    await setPost(Availability.Private);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(dbMock.dbWrite.$executeRawUnsafe).toHaveBeenCalled();
    expect(redisMock.sysRedis.get).not.toHaveBeenCalledWith(
      REDIS_SYS_KEYS.SYSTEM.KNIGHTS_V2_SOURCES
    );
    expect(imageReads()).toEqual([]);
  });
});

describe('updateEntityAvailabilityHandler on a Model or ModelVersion', () => {
  it.each([
    ['Model', [7, 8]],
    ['ModelVersion', [3]],
  ] as const)(
    "offers the images on a %s's posts to Knights after it leaves Private",
    async (entityType, versionIds) => {
      await setModel(entityType, Availability.Public);

      await vi.waitFor(() => expect(postsOfVersionsReads().length).toBeGreaterThan(0));
      for (const read of postsOfVersionsReads()) {
        expect(read.values.filter((v) => typeof v === 'number')).toEqual(versionIds);
        expect(read.writesBefore).toBe(1);
      }
    }
  );

  it.each([
    ['Model', Availability.Public, Availability.Unsearchable],
    ['ModelVersion', Availability.Public, Availability.Public],
    ['Model', Availability.Private, Availability.Private],
  ] as const)(
    'offers nothing when a %s does not leave Private: %s to %s',
    async (entityType, before, after) => {
      stored = before;
      await setModel(entityType, after);
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(dbMock.dbWrite.$executeRawUnsafe).toHaveBeenCalled();
      expect(postsOfVersionsReads()).toEqual([]);
      expect(imageReads()).toEqual([]);
    }
  );
});
