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

import {
  getHubSourceSuggestions,
  getUserHubById,
  resolveHubSourceFromUrl,
  resolveHubSources,
  upsertUserHub,
} from '~/server/services/user-hub.service';
import {
  HUB_COLLECTION_SOURCES_ENABLED,
  hubLimits,
  upsertUserHubSchema,
} from '~/server/schema/user-hub.schema';
import {
  Availability,
  CollectionReadConfiguration,
  MetricTimeframe,
  ModelStatus,
  UserHubSourceType,
} from '~/shared/utils/prisma/enums';
import { ImageSort } from '~/server/common/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';
const findFirstHub = dbMock.dbRead.userHub.findFirst;
const findManyCollections = dbMock.dbRead.collection.findMany;
const queryRaw = dbMock.dbRead.$queryRaw;

// Stands in for the ranked ModelVersion query: it reads the model ids and the rank
// limit out of the emitted template rather than assuming them, so a change to
// either shows up here instead of being absorbed.
function stubVersions(versionsByModel: Record<number, number[]>) {
  queryRaw.mockImplementation((_strings: TemplateStringsArray, ...values: unknown[]) => {
    const modelIds = (values[0] as { values: number[] }).values;
    const rankLimit = values[1] as number;
    const rows: { id: number; modelId: number; rn: bigint }[] = [];
    for (const modelId of modelIds) {
      const ids = [...(versionsByModel[modelId] ?? [])].sort((a, b) => b - a);
      ids.slice(0, rankLimit).forEach((id, i) => rows.push({ id, modelId, rn: BigInt(i + 1) }));
    }
    return Promise.resolve(rows.sort((a, b) => b.id - a.id));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  stubVersions({});
  // The service maps whatever the write returns before handing it back, so the
  // fakes have to return a row rather than undefined.
  dbMock.dbWrite.userHub.create.mockResolvedValue({ id: 7, metadata: {} });
  dbMock.dbWrite.userHub.update.mockResolvedValue({ id: 9, metadata: {} });
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
    stubVersions({ 20: [30, 31] });

    const result = await resolveHubSources({ hubId: 1, userId: 5 });

    expect(result?.userIds).toEqual([10]);
    expect(result?.collectionIds).toEqual([40]);
    // 31 is both explicit and expanded — it must appear once, or the filter
    // carries a duplicate id for every version a user pinned by hand.
    expect([...(result?.modelVersionIds ?? [])].sort((a, b) => a - b)).toEqual([30, 31]);
  });

  it('ranks versions per model in the emitted SQL', async () => {
    // The fake below does its own partitioning, so it cannot observe the clause that
    // makes the real query partition — delete `PARTITION BY mv."modelId"` and every
    // value-level assertion in this file stays green while production ranks all
    // models in one list. These two literals live wholly in the static segments of
    // the template, so reading them off `strings` is honest.
    findFirstHub.mockResolvedValue({
      sources: [{ type: UserHubSourceType.Model, targetId: 20 }],
    });
    stubVersions({ 20: [30, 31] });

    await resolveHubSources({ hubId: 1, userId: 5 });

    const strings = queryRaw.mock.calls[0][0] as TemplateStringsArray;
    const sql = strings.join('?');
    expect(sql).toContain('PARTITION BY mv."modelId"');
    expect(sql).toContain('ORDER BY mv.id DESC');
  });

  it('gives each model source its own share of the cap, so an older model still contributes', async () => {
    // Ranking every model's versions in ONE `id desc` list is the regression: the
    // high-version model spends the whole cap and model 21 contributes nothing
    // while its row still reads enabled.
    findFirstHub.mockResolvedValue({
      sources: [
        { type: UserHubSourceType.Model, targetId: 20 },
        { type: UserHubSourceType.Model, targetId: 21 },
      ],
    });
    const manyNewIds = Array.from({ length: 800 }, (_, i) => 100_000 + i);
    const fewOldIds = [1, 2, 3, 4, 5];
    stubVersions({ 20: manyNewIds, 21: fewOldIds });

    const result = await resolveHubSources({ hubId: 1, userId: 5 });

    const ids = result?.modelVersionIds ?? [];
    expect(ids.length).toBeLessThanOrEqual(hubLimits.resolvedVersionIds);
    for (const id of fewOldIds) expect(ids).toContain(id);
    expect(ids.some((id) => manyNewIds.includes(id))).toBe(true);
    // Model 20 was cut short, and that has to be visible on the result rather than
    // inferred from a short list.
    expect(result?.truncated).toBe(true);
  });

  it('leaves truncated false when every version fits', async () => {
    // Negative control: without it, `truncated = true` unconditionally passes the
    // assertion above.
    findFirstHub.mockResolvedValue({
      sources: [{ type: UserHubSourceType.Model, targetId: 20 }],
    });
    stubVersions({ 20: [30, 31] });

    const result = await resolveHubSources({ hubId: 1, userId: 5 });

    expect(result?.truncated).toBe(false);
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

    // The half the title used to claim and never exercised: the same call shape
    // against an existing hub must not carry those values, or toggling a source
    // resets the user's sort.
    dbMock.dbWrite.userHub.findFirst.mockResolvedValue({ id: 9, metadata: {} });

    await upsertUserHub({ id: 9, name: 'defaults', sources: [], userId: 5 });

    const updateArg = dbMock.dbWrite.userHub.update.mock.calls[0][0];
    expect(updateArg.data.sort).toBeUndefined();
    expect(updateArg.data.period).toBeUndefined();
  });

  it('leaves the sources alone when the input omits them', async () => {
    // A rename and a sort change both used to resend their own cached copy of the
    // whole list, so either could revert a source edit made in between. With the
    // list omitted the update must not touch UserHubSource at all.
    dbMock.dbWrite.userHub.findFirst.mockResolvedValue({ id: 9, metadata: {} });

    await upsertUserHub({ id: 9, name: 'renamed', userId: 5 });

    expect(dbMock.dbWrite.userHubSource.deleteMany).not.toHaveBeenCalled();
    const arg = dbMock.dbWrite.userHub.update.mock.calls[0][0];
    expect(arg.data.sources).toBeUndefined();
    expect(arg.data.name).toBe('renamed');
  });

  it('still replaces the sources when the input carries them', async () => {
    // Negative control for the test above: without it, an update branch that
    // dropped source writes entirely would pass.
    dbMock.dbWrite.userHub.findFirst.mockResolvedValue({ id: 9, metadata: {} });

    await upsertUserHub({
      id: 9,
      name: 'renamed',
      sources: [{ type: UserHubSourceType.User, targetId: 10, enabled: true, index: 0 }],
      userId: 5,
    });

    expect(dbMock.dbWrite.userHubSource.deleteMany).toHaveBeenCalledWith({ where: { hubId: 9 } });
    const arg = dbMock.dbWrite.userHub.update.mock.calls[0][0];
    expect(arg.data.sources.create).toHaveLength(1);
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

// `UserHub` has no description column, so the field lives on `metadata`. That makes
// three things silent rather than loud if they break: an update that REPLACES the
// json drops whatever else is on it; an omitted field that defaults to empty wipes
// a description the caller never touched; and a filter key the feed refuses would
// reach `image.getInfinite` if the whole blob were handed back.
describe('description and filters on metadata', () => {
  it('merges the description into the existing metadata rather than replacing it', async () => {
    dbMock.dbWrite.userHub.findFirst.mockResolvedValue({
      id: 9,
      metadata: { description: 'old', somethingElse: 'keep me' },
    });

    await upsertUserHub({ id: 9, description: 'new', userId: 5 });

    const arg = dbMock.dbWrite.userHub.update.mock.calls[0][0];
    expect(arg.data.metadata).toEqual({ description: 'new', somethingElse: 'keep me' });
  });

  it('leaves the description alone when the input omits it', async () => {
    dbMock.dbWrite.userHub.findFirst.mockResolvedValue({
      id: 9,
      metadata: { description: 'still here' },
    });

    await upsertUserHub({ id: 9, name: 'renamed', userId: 5 });

    const arg = dbMock.dbWrite.userHub.update.mock.calls[0][0];
    expect(arg.data.metadata).toBeUndefined();
  });

  it('truncates an over-long description instead of rejecting the whole edit', () => {
    const parsed = upsertUserHubSchema.parse({
      id: 9,
      description: 'x'.repeat(hubLimits.descriptionLength + 50),
    });

    expect(parsed.description).toHaveLength(hubLimits.descriptionLength);
  });

  it('drops a stored filter key that is not on the allowlist', async () => {
    // A hub feed is index-only: `collectionId` forces the DB path, and
    // `getInfiniteImagesSchema` refuses it alongside `hubId`. Reaching the page at
    // all means it was never handed back.
    dbMock.dbRead.userHub.findFirst.mockResolvedValue({
      id: 9,
      sources: [],
      metadata: { filters: { withMeta: true, collectionId: 4 } },
    });

    const hub = await getUserHubById({ id: 9, userId: 5 });

    expect(hub.filters).toEqual({ withMeta: true });
  });

  it('reads back an empty filter set when the stored json is nonsense', async () => {
    dbMock.dbRead.userHub.findFirst.mockResolvedValue({
      id: 9,
      sources: [],
      metadata: { filters: 'not an object' },
    });

    const hub = await getUserHubById({ id: 9, userId: 5 });

    expect(hub.filters).toEqual({});
    expect(hub.description).toBeNull();
  });
});

// A model page carrying `?modelVersionId=` is a version's gallery. Resolving it to
// the whole model is a silent widening — the hub fills with images from versions
// the user never linked, and nothing about the row they added says so.
describe('resolving a pasted link', () => {
  it('resolves a versioned model link to the version, not the model', async () => {
    dbMock.dbRead.modelVersion.findFirst.mockResolvedValue({
      id: 456,
      name: 'v2',
      model: { name: 'Nova', deletedAt: null },
    });

    const source = await resolveHubSourceFromUrl({
      url: 'https://civitai.com/models/123?modelVersionId=456',
      userId: 5,
    });

    expect(source).toEqual({
      type: UserHubSourceType.ModelVersion,
      targetId: 456,
      alias: 'Nova - v2',
    });
    // The negative control: widening to the model would have read the Model table.
    expect(dbMock.dbRead.model.findFirst).not.toHaveBeenCalled();
  });

  it('still resolves a bare model link to the model', async () => {
    dbMock.dbRead.model.findFirst.mockResolvedValue({ id: 123, name: 'Nova' });

    const source = await resolveHubSourceFromUrl({
      url: 'https://civitai.com/models/123',
      userId: 5,
    });

    expect(source).toEqual({ type: UserHubSourceType.Model, targetId: 123, alias: 'Nova' });
  });

  it('returns null for a link on another host', async () => {
    const source = await resolveHubSourceFromUrl({
      url: 'https://example.com/models/123',
      userId: 5,
    });

    expect(source).toBeNull();
    expect(dbMock.dbRead.model.findFirst).not.toHaveBeenCalled();
  });
});

// The resolve arm is an id-to-name lookup over a dense id space. Every arm that
// answers without a visibility filter is a sweepable oracle for names the entity
// pages themselves 404 on, so each one is pinned here rather than trusted.
describe('what a pasted link is allowed to name', () => {
  it('asks only for models the viewer owns or that are published and not private', async () => {
    dbMock.dbRead.model.findFirst.mockResolvedValue(null);

    const source = await resolveHubSourceFromUrl({
      url: 'https://civitai.com/models/123',
      userId: 5,
    });

    expect(source).toBeNull();
    const where = dbMock.dbRead.model.findFirst.mock.calls[0][0].where;
    expect(where.OR).toEqual([
      { userId: 5 },
      { status: ModelStatus.Published, availability: { not: Availability.Private } },
    ]);
  });

  it('drops the visibility filter for a moderator', async () => {
    dbMock.dbRead.model.findFirst.mockResolvedValue({ id: 123, name: 'Nova' });

    await resolveHubSourceFromUrl({
      url: 'https://civitai.com/models/123',
      userId: 5,
      isModerator: true,
    });

    const where = dbMock.dbRead.model.findFirst.mock.calls[0][0].where;
    expect(where.OR).toBeUndefined();
    expect(where.deletedAt).toBeNull();
  });

  it('refuses a collection link outright while collection sources are off', async () => {
    // The write path rejects every collection while the flag is false, so naming
    // one here would preview a source that then fails to save.
    expect(HUB_COLLECTION_SOURCES_ENABLED).toBe(false);

    const source = await resolveHubSourceFromUrl({
      url: 'https://civitai.com/collections/9',
      userId: 5,
    });

    expect(source).toBeNull();
    expect(dbMock.dbRead.collection.findMany).not.toHaveBeenCalled();
  });
});

// The write half of `metadata.filters`. The read half is covered above, and the
// two look alike enough that covering only the read reads as covering both — drop
// the filters key from the update and nothing else in this suite goes red, while
// every filter the user picks silently forgets itself on reload.
describe('persisting the feed filters', () => {
  it('merges filters into the existing metadata', async () => {
    dbMock.dbWrite.userHub.findFirst.mockResolvedValue({
      id: 9,
      metadata: { description: 'keep me' },
    });

    await upsertUserHub({ id: 9, filters: { withMeta: true }, userId: 5 });

    const arg = dbMock.dbWrite.userHub.update.mock.calls[0][0];
    expect(arg.data.metadata).toEqual({ description: 'keep me', filters: { withMeta: true } });
  });

  it('writes both keys when a save carries description and filters together', async () => {
    dbMock.dbWrite.userHub.findFirst.mockResolvedValue({ id: 9, metadata: {} });

    await upsertUserHub({
      id: 9,
      description: 'both',
      filters: { hideChallenges: true },
      userId: 5,
    });

    const arg = dbMock.dbWrite.userHub.update.mock.calls[0][0];
    expect(arg.data.metadata).toEqual({
      description: 'both',
      filters: { hideChallenges: true },
    });
  });

  it('stores filters on a new hub', async () => {
    dbMock.dbRead.userHub.count.mockResolvedValue(0);

    await upsertUserHub({ name: 'new', filters: { fromPlatform: true }, userId: 5 });

    const arg = dbMock.dbWrite.userHub.create.mock.calls[0][0];
    expect(arg.data.metadata).toEqual({ filters: { fromPlatform: true } });
  });

  it('clears the description when an empty string is saved', async () => {
    dbMock.dbWrite.userHub.findFirst.mockResolvedValue({
      id: 9,
      metadata: { description: 'gone soon' },
    });

    await upsertUserHub({ id: 9, description: '', userId: 5 });

    const arg = dbMock.dbWrite.userHub.update.mock.calls[0][0];
    expect(arg.data.metadata.description).toBeUndefined();
  });
});

// Each arm reads a table that also holds other people's rows. A `userId` dropped
// from any of these where clauses is a leak with no visible symptom — the picker
// simply offers more, which looks like the feature working.
describe('source suggestions stay inside the viewer', () => {
  it('scopes the creators arm to the viewer, over a bounded window', async () => {
    dbMock.dbRead.userEngagement.findMany.mockResolvedValue([{ targetUserId: 11 }]);
    dbMock.dbRead.user.findMany.mockResolvedValue([{ id: 11, username: 'someone' }]);

    await getHubSourceSuggestions({ userId: 5, type: UserHubSourceType.User, query: 'some' });

    const follows = dbMock.dbRead.userEngagement.findMany.mock.calls[0][0];
    expect(follows.where.userId).toBe(5);
    // The name filter must NOT ride on the relationship query: expressed there it
    // is a subquery the planner walks the whole follow list to satisfy.
    expect(follows.where.targetUser).toBeUndefined();
    expect(follows.take).toBeGreaterThan(0);

    const names = dbMock.dbRead.user.findMany.mock.calls[0][0];
    expect(names.where.id).toEqual({ in: [11] });
    // citext overloads `=`, not `LIKE`, so the substring match needs `insensitive`
    // — measured live: without it, searching "A" missed a username with a lowercase
    // "a". Bounded by the id list above, so it is not the scan that ILIKE was on
    // the unbounded query.
    expect(names.where.username).toEqual({ contains: 'some', mode: 'insensitive' });
    expect(names.orderBy).toEqual({ username: 'asc' });
  });

  it('scopes every models arm to the viewer, and filters names once over the union', async () => {
    dbMock.dbRead.collection.findFirst.mockResolvedValue({ id: 77 });
    dbMock.dbRead.model.findMany.mockResolvedValue([{ id: 1 }]);
    dbMock.dbRead.modelEngagement.findMany.mockResolvedValue([{ modelId: 2 }]);
    dbMock.dbRead.collectionItem.findMany.mockResolvedValue([{ modelId: 3 }]);

    await getHubSourceSuggestions({ userId: 5, type: UserHubSourceType.Model, query: 'nova' });

    const own = dbMock.dbRead.model.findMany.mock.calls[0][0];
    const engaged = dbMock.dbRead.modelEngagement.findMany.mock.calls[0][0];
    expect(own.where.userId).toBe(5);
    expect(engaged.where.userId).toBe(5);
    // The bookmark arm is scoped by the collection it reads, which is itself the
    // viewer's — so assert the lookup that picked it, not the item query.
    expect(dbMock.dbRead.collection.findFirst.mock.calls[0][0].where.userId).toBe(5);
    expect(dbMock.dbRead.collectionItem.findMany.mock.calls[0][0].where.collectionId).toBe(77);

    // None of the three id queries may carry the name filter — that is what made
    // the planner walk every bookmark and every Notify row.
    expect(own.where.name).toBeUndefined();
    expect(engaged.where.model).toBeUndefined();
    const names = dbMock.dbRead.model.findMany.mock.calls[1][0];
    expect(names.where.id).toEqual({ in: [1, 2, 3] });
    expect(names.where.name).toEqual({ contains: 'nova', mode: 'insensitive' });
    expect(names.orderBy).toEqual({ name: 'asc' });
  });

  it('offers no collections while the write path refuses them', async () => {
    expect(HUB_COLLECTION_SOURCES_ENABLED).toBe(false);

    const result = await getHubSourceSuggestions({ userId: 5, type: UserHubSourceType.Collection });

    expect(result).toEqual([]);
    expect(dbMock.dbRead.collectionContributor.findMany).not.toHaveBeenCalled();
  });
});

// A source pointed at a taken-down model contributes nothing to the feed forever,
// and the row gives no clue why.
describe('taken-down models', () => {
  it('will not name a version whose model is deleted', async () => {
    dbMock.dbRead.modelVersion.findFirst.mockResolvedValue(null);

    const source = await resolveHubSourceFromUrl({
      url: 'https://civitai.com/model-versions/456',
      userId: 5,
    });

    expect(source).toBeNull();
    const where = dbMock.dbRead.modelVersion.findFirst.mock.calls[0][0].where;
    expect(where.model.deletedAt).toBeNull();
  });
});
