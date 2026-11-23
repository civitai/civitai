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

const setPost = (availability: Availability) =>
  updateEntityAvailabilityHandler({
    ctx: {} as Context,
    input: { entityType: 'Post', entityId: 5, availability },
  });
const imageReads = () => statements.filter((s) => s.sql.includes('from "Image"'));

beforeEach(() => {
  vi.clearAllMocks();
  statements.length = 0;
  clearKnightsSourcesConfigCache();
  redisMock.sysRedis.get.mockImplementation(async (key: string) =>
    key === REDIS_SYS_KEYS.SYSTEM.KNIGHTS_V2_SOURCES ? JSON.stringify({ enabled: true }) : null
  );
  dbMock.dbRead.image.findMany.mockResolvedValue([{ id: 50 }]);
  dbMock.dbWrite.post.findUnique.mockResolvedValue({ availability: Availability.Private } as never);
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
    dbMock.dbWrite.post.findUnique.mockResolvedValue({ availability: before } as never);
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
