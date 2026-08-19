import { beforeEach, describe, expect, it, vi } from 'vitest';

// These cover the two ways a hub can fail QUIETLY rather than loudly:
//   - resolveHubSources returning something for a hub the viewer does not own,
//     which would leak another user's feed composition;
//   - upsert accepting a collection source the indexed membership field cannot
//     represent, which would silently contribute nothing (private) or contribute
//     without its content-rating cap (forcedBrowsingLevel).
// Neither shows up as an error at any layer, so only a test pins them.

const { permissionsMock } = vi.hoisted(() => ({ permissionsMock: vi.fn() }));

vi.mock('~/server/services/collection.service', () => ({
  getUserCollectionPermissionsByIds: permissionsMock,
}));

import { resolveHubSources, upsertUserHub } from '~/server/services/user-hub.service';
import { HUB_COLLECTION_SOURCES_ENABLED } from '~/server/schema/user-hub.schema';
import {
  CollectionReadConfiguration,
  MetricTimeframe,
  UserHubSourceType,
} from '~/shared/utils/prisma/enums';
import { ImageSort } from '~/server/common/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';
const findFirstHub = dbMock.dbRead.userHub.findFirst;
const findManyCollections = dbMock.dbRead.collection.findMany;
const findManyVersions = dbMock.dbRead.modelVersion.findMany;

beforeEach(() => {
  vi.clearAllMocks();
  findManyVersions.mockResolvedValue([]);
});

describe('resolveHubSources', () => {
  it('returns null for a hub the viewer does not own', async () => {
    // The service scopes by userId in the where clause, so a non-owner's read
    // finds nothing rather than finding-then-checking.
    findFirstHub.mockResolvedValue(null);

    const result = await resolveHubSources({ hubId: 1, userId: 999 });

    expect(result).toBeNull();
    expect(findFirstHub).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 1, userId: 999 } })
    );
  });

  it('returns null when there is no viewer at all', async () => {
    const result = await resolveHubSources({ hubId: 1, userId: undefined });

    expect(result).toBeNull();
    // Must not even reach the database — an anonymous request has no hub to resolve.
    expect(findFirstHub).not.toHaveBeenCalled();
  });

  it('expands a model source into its versions alongside explicit versions', async () => {
    findFirstHub.mockResolvedValue({
      sources: [
        { type: UserHubSourceType.User, targetId: 10 },
        { type: UserHubSourceType.Model, targetId: 20 },
        { type: UserHubSourceType.ModelVersion, targetId: 31 },
        { type: UserHubSourceType.Collection, targetId: 40 },
      ],
    });
    findManyVersions.mockResolvedValue([{ id: 30 }, { id: 31 }]);

    const result = await resolveHubSources({ hubId: 1, userId: 5 });

    expect(result?.userIds).toEqual([10]);
    expect(result?.collectionIds).toEqual([40]);
    // 31 is both explicit and expanded — it must appear once, or the filter
    // carries a duplicate id for every version a user pinned by hand.
    expect([...(result?.modelVersionIds ?? [])].sort((a, b) => a - b)).toEqual([30, 31]);
  });

  it('only resolves enabled sources', async () => {
    findFirstHub.mockResolvedValue({ sources: [] });

    await resolveHubSources({ hubId: 1, userId: 5 });

    expect(findFirstHub).toHaveBeenCalledWith(
      expect.objectContaining({
        select: { sources: expect.objectContaining({ where: { enabled: true } }) },
      })
    );
  });
});

describe('upsertUserHub', () => {
  it('creates a creator-only hub', async () => {
    // The negative control for every rejection below, and the only thing standing
    // between us and a mutation that makes EVERY upsert throw. Without it,
    // `if (!collectionIds.length) return` -> `< 0` kills the shipped feature and
    // the suite still prints all-green.
    dbMock.dbRead.userHub.count.mockResolvedValue(0);
    dbMock.dbWrite.userHub.create.mockResolvedValue({ id: 7 });

    await upsertUserHub({
      name: 'creators only',
      sources: [{ type: UserHubSourceType.User, targetId: 10, enabled: true, index: 0 }],
      userId: 5,
    });

    expect(dbMock.dbWrite.userHub.create).toHaveBeenCalledTimes(1);
    const arg = dbMock.dbWrite.userHub.create.mock.calls[0][0];
    expect(arg.data.userId).toBe(5);
    expect(arg.data.sources.create).toHaveLength(1);
  });

  it('applies creation defaults without them leaking into updates', async () => {
    // sort/period/mediaTypes carry no zod default any more: a default on an UPDATE
    // silently overwrote fields the caller had not sent, which reset the user's
    // sort every time they toggled a source. Create must still get real values.
    dbMock.dbRead.userHub.count.mockResolvedValue(0);
    dbMock.dbWrite.userHub.create.mockResolvedValue({ id: 8 });

    await upsertUserHub({ name: 'defaults', sources: [], userId: 5 });

    const arg = dbMock.dbWrite.userHub.create.mock.calls[0][0];
    expect(arg.data.sort).toBe(ImageSort.Newest);
    expect(arg.data.period).toBe(MetricTimeframe.AllTime);
  });
});

describe('upsertUserHub collection sources', () => {
  const hubInput = (targetId: number) => ({
    name: 'hub',
    sort: 'Newest' as const,
    period: 'AllTime' as const,
    mediaTypes: [],
    sources: [{ type: UserHubSourceType.Collection, targetId, enabled: true, index: 0 }],
    userId: 5,
  });

  it.skipIf(HUB_COLLECTION_SOURCES_ENABLED)(
    'refuses every collection while the index attribute is not live',
    async () => {
      // The guard sits before the per-collection checks, so this fires for a
      // collection that would otherwise be perfectly usable.
      findManyCollections.mockResolvedValue([
        { id: 44, name: 'Fine', read: CollectionReadConfiguration.Public, metadata: {} },
      ]);
      permissionsMock.mockResolvedValue([{ read: true }]);

      await expect(upsertUserHub(hubInput(44))).rejects.toThrow(/cannot be added to a hub yet/i);
    }
  );

  it.skipIf(!HUB_COLLECTION_SOURCES_ENABLED)('refuses a private collection', async () => {
    findManyCollections.mockResolvedValue([
      { id: 40, name: 'Secret', read: CollectionReadConfiguration.Private, metadata: {} },
    ]);
    permissionsMock.mockResolvedValue([{ read: true }]);

    await expect(upsertUserHub(hubInput(40))).rejects.toThrow(/private/i);
  });

  it.skipIf(!HUB_COLLECTION_SOURCES_ENABLED)(
    'refuses a collection with a forced browsing level',
    async () => {
      findManyCollections.mockResolvedValue([
        {
          id: 41,
          name: 'Contest',
          read: CollectionReadConfiguration.Public,
          metadata: { forcedBrowsingLevel: 3 },
        },
      ]);
      permissionsMock.mockResolvedValue([{ read: true }]);

      await expect(upsertUserHub(hubInput(41))).rejects.toThrow(/content ratings/i);
    }
  );

  it.skipIf(!HUB_COLLECTION_SOURCES_ENABLED)(
    'refuses a collection the viewer cannot read',
    async () => {
      findManyCollections.mockResolvedValue([
        { id: 42, name: 'Theirs', read: CollectionReadConfiguration.Public, metadata: {} },
      ]);
      permissionsMock.mockResolvedValue([{ read: false }]);

      await expect(upsertUserHub(hubInput(42))).rejects.toThrow(/not found/i);
    }
  );

  it.skipIf(!HUB_COLLECTION_SOURCES_ENABLED)(
    'accepts a readable public collection with no forced level',
    async () => {
      findManyCollections.mockResolvedValue([
        { id: 43, name: 'Fine', read: CollectionReadConfiguration.Public, metadata: {} },
      ]);
      permissionsMock.mockResolvedValue([{ read: true }]);

      // Proves the three rejections above are not passing for free — the same call
      // shape reaches the write path when the collection is usable.
      await expect(upsertUserHub(hubInput(43))).resolves.not.toThrow();
    }
  );
});
