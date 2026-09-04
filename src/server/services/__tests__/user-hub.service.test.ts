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
  addUserHubSource,
  getUserHubs,
  getHubCardData,
  getUserHubByKey,
  hubRouteIsDark,
  getUserHubForRoute,
  getHubSourceSuggestions,
  deleteUserHub,
  hubBrowsingLevel,
  hubViewerWhere,
  hubWriterWhere,
  removeUserHubSource,
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
  TagTarget,
  TagType,
  UserHubSourceType,
} from '~/shared/utils/prisma/enums';
import { ImageSort } from '~/server/common/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { encodeHubId } from '~/server/utils/hub-id';
const findFirstHub = dbMock.dbRead.userHub.findFirst;
// The source mutations read the hub through the WRITER — the duplicate check, the cap
// and the next index all come off that row.
const writerHub = dbMock.dbWrite.userHub.findFirst;
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
  dbMock.dbWrite.userHub.create.mockResolvedValue({ id: 7, metadata: {}, sources: [] });
  dbMock.dbWrite.userHub.update.mockResolvedValue({ id: 9, metadata: {}, sources: [] });
});

/**
 * Who may open a hub. Every hub read in this service goes through this fragment, so
 * a mistake here is a private hub readable by strangers rather than an error
 * anywhere. Asserted on the fragment itself, and again on what the reads emit.
 */
describe('hubViewerWhere', () => {
  it('lets a signed-in viewer reach their own hubs and public ones, and nothing else', () => {
    expect(hubViewerWhere({ userId: 5 })).toStrictEqual({
      OR: [{ userId: 5 }, { availability: Availability.Public }],
    });
  });

  it('gives a signed-out viewer the public arm ONLY', () => {
    // A stray `{ userId: undefined }` arm would be `WHERE "userId" IS NULL`, which
    // matches no hub today — but it is a leak the moment userId becomes nullable,
    // and it reads as harmless.
    expect(hubViewerWhere({})).toStrictEqual({ OR: [{ availability: Availability.Public }] });
  });

  it('lets a moderator reach every hub regardless of visibility', () => {
    // Strict: `toEqual({})` also passes for `{ OR: undefined }`, which is a
    // different query and would be a moderator seeing nothing.
    expect(hubViewerWhere({ userId: 5, isModerator: true })).toStrictEqual({});
  });
});

describe('resolveHubSources', () => {
  it('scopes a signed-in viewer to their own hubs plus public ones', async () => {
    findFirstHub.mockResolvedValue(null);

    const result = await resolveHubSources({ hubId: 1, userId: 999 });

    expect(result).toBeNull();
    expect(findFirstHub).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1, OR: [{ userId: 999 }, { availability: Availability.Public }] },
      })
    );
  });

  it('scopes a signed-out viewer to public hubs', async () => {
    // Anonymous viewers used to be refused before the query ran. A public hub opens
    // for anyone holding the link now, so the refusal has to come from the WHERE.
    findFirstHub.mockResolvedValue(null);

    const result = await resolveHubSources({ hubId: 1, userId: undefined });

    expect(result).toBeNull();
    expect(findFirstHub).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1, OR: [{ availability: Availability.Public }] },
      })
    );
  });

  it('puts no visibility restriction on a moderator', async () => {
    findFirstHub.mockResolvedValue({ forcedBrowsingLevel: 0, sources: [] });

    await resolveHubSources({ hubId: 1, userId: 999, isModerator: true });

    expect(findFirstHub).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 1 } }));
  });

  it('subtracts the sources this viewer switched off for their session', async () => {
    findFirstHub.mockResolvedValue({
      forcedBrowsingLevel: 0,
      sources: [
        { type: UserHubSourceType.User, targetId: 10 },
        { type: UserHubSourceType.User, targetId: 11 },
      ],
    });

    const result = await resolveHubSources({
      hubId: 1,
      userId: 5,
      excludedSources: [{ type: UserHubSourceType.User, targetId: 11 }],
    });

    // The id, not the count: a length assertion passes when the WRONG source is
    // dropped, which is the same feed with the wrong creator missing.
    expect(result?.userIds).toEqual([10]);
  });

  it('ignores an exclusion naming a different source TYPE with the same id', async () => {
    // The key is the pair. Matching on targetId alone would silently drop a creator
    // whenever a model happened to share its id.
    findFirstHub.mockResolvedValue({
      forcedBrowsingLevel: 0,
      sources: [{ type: UserHubSourceType.User, targetId: 10 }],
    });

    const result = await resolveHubSources({
      hubId: 1,
      userId: 5,
      excludedSources: [{ type: UserHubSourceType.Model, targetId: 10 }],
    });

    expect(result?.userIds).toEqual([10]);
  });

  /**
   * Negative sources. The properties here are the ones no assertion on the emitted
   * FILTER can see, because they decide what reaches the builder in the first place.
   */
  describe('negative sources', () => {
    const excludedVersions = dbMock.dbRead.modelVersion.findMany;

    it('keeps an excluded source out of the positive sets and in the excluded ones', async () => {
      findFirstHub.mockResolvedValue({
        forcedBrowsingLevel: 0,
        sources: [
          { type: UserHubSourceType.User, targetId: 10, exclude: false },
          { type: UserHubSourceType.User, targetId: 11, exclude: true },
          { type: UserHubSourceType.Tag, targetId: 77, exclude: false },
          { type: UserHubSourceType.Tag, targetId: 78, exclude: true },
        ],
      });

      const result = await resolveHubSources({ hubId: 1, userId: 5 });

      // Both directions asserted. Half of this — the positive sets — stays green if
      // every source is read as an exclusion, which is a hub that shows nothing.
      expect(result?.userIds).toEqual([10]);
      expect(result?.tagIds).toEqual([77]);
      expect(result?.excluded.userIds).toEqual([11]);
      expect(result?.excluded.tagIds).toEqual([78]);
    });

    it('IGNORES a session toggle aimed at a negative source', async () => {
      // 🔴 The one direction a viewer-supplied list must never move the feed. A
      // session toggle removes content from the person who forged it; letting it
      // reach an exclusion would ADD content the owner refused, to anyone who can
      // post a hub feed query. Do not "fix" this by subtracting before the split.
      findFirstHub.mockResolvedValue({
        forcedBrowsingLevel: 0,
        sources: [
          { type: UserHubSourceType.User, targetId: 10, exclude: false },
          { type: UserHubSourceType.User, targetId: 11, exclude: true },
        ],
      });

      const result = await resolveHubSources({
        hubId: 1,
        userId: 5,
        excludedSources: [{ type: UserHubSourceType.User, targetId: 11 }],
      });

      expect(result?.excluded.userIds).toEqual([11]);
    });

    it('still lets a session toggle drop a POSITIVE source', async () => {
      // The control for the test above: without it, that assertion also passes for a
      // resolver that ignores the session list entirely, which breaks every viewer's
      // source toggles.
      findFirstHub.mockResolvedValue({
        forcedBrowsingLevel: 0,
        sources: [
          { type: UserHubSourceType.User, targetId: 10, exclude: false },
          { type: UserHubSourceType.User, targetId: 11, exclude: true },
        ],
      });

      const result = await resolveHubSources({
        hubId: 1,
        userId: 5,
        excludedSources: [{ type: UserHubSourceType.User, targetId: 10 }],
      });

      expect(result?.userIds).toEqual([]);
      expect(result?.excluded.userIds).toEqual([11]);
    });

    it('expands an excluded model into ALL of its versions, untrimmed', async () => {
      // Deliberately not the budgeted, per-model-ranked expansion the positive path
      // uses: a trimmed exclusion serves back content the owner said to keep out.
      findFirstHub.mockResolvedValue({
        forcedBrowsingLevel: 0,
        sources: [
          { type: UserHubSourceType.Model, targetId: 20, exclude: true },
          { type: UserHubSourceType.ModelVersion, targetId: 99, exclude: true },
        ],
      });
      excludedVersions.mockResolvedValue([{ id: 30 }, { id: 31 }, { id: 32 }]);

      const result = await resolveHubSources({ hubId: 1, userId: 5 });

      expect(result?.excluded.modelVersionIds).toEqual([99, 30, 31, 32]);
      // Every version of the model, with no rank limit anywhere in the query.
      expect(excludedVersions).toHaveBeenCalledWith(
        expect.objectContaining({ where: { modelId: { in: [20] } } })
      );
      expect(result?.modelVersionIds).toEqual([]);
    });

    it('does not query versions when nothing is excluded', async () => {
      // The control: the assertion above passes for a resolver that expands models
      // unconditionally, which would make every hub pay for a query it does not use.
      findFirstHub.mockResolvedValue({
        forcedBrowsingLevel: 0,
        sources: [{ type: UserHubSourceType.User, targetId: 10, exclude: false }],
      });

      await resolveHubSources({ hubId: 1, userId: 5 });

      expect(excludedVersions).not.toHaveBeenCalled();
    });
  });

  it('carries the hub stored level out to the filter builders', async () => {
    findFirstHub.mockResolvedValue({ forcedBrowsingLevel: 3, sources: [] });

    const result = await resolveHubSources({ hubId: 1, userId: 5 });

    expect(result?.forcedBrowsingLevel).toBe(3);
  });
});

describe('hubBrowsingLevel', () => {
  const sources = (forcedBrowsingLevel: number) =>
    ({
      userIds: [],
      modelVersionIds: [],
      collectionIds: [],
      truncated: false,
      forcedBrowsingLevel,
    } as const);

  it('narrows the viewer level to what the hub allows', () => {
    // PG|PG-13|R asked for, PG|PG-13 allowed.
    expect(hubBrowsingLevel(1 | 2 | 4, sources(1 | 2))).toBe(1 | 2);
  });

  it('never widens past what the viewer was already allowed', () => {
    // The direction that would matter: a hub allowing R must not hand R to a viewer
    // whose own level (already capped by domain and account) is PG.
    expect(hubBrowsingLevel(1, sources(1 | 4))).toBe(1);
  });

  it('treats an absent viewer level as PG rather than as everything', () => {
    // A request carrying no level at all reaches the filter builders on red, where
    // nothing backfills it. Reading that as "no restriction" and intersecting the
    // hub's cap into it would turn an R-only hub into an R feed for a caller who
    // asked for nothing — the cap widening a request instead of narrowing it.
    expect(hubBrowsingLevel(undefined, sources(4))).toBe(0);
    expect(hubBrowsingLevel(undefined, sources(1 | 4))).toBe(1);
  });

  it('returns 0 when the two do not overlap, so the caller can serve nothing', () => {
    expect(hubBrowsingLevel(1, sources(4))).toBe(0);
  });

  it('leaves the viewer level untouched when the hub sets no cap', () => {
    expect(hubBrowsingLevel(1 | 2 | 4, sources(0))).toBe(1 | 2 | 4);
  });
});

describe('resolveHubSources source expansion', () => {
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
        select: expect.objectContaining({
          // Named, not just `objectContaining` around `sources`: a mocked Prisma call
          // ignores `select`, so dropping this key returns `undefined` in production,
          // `hubBrowsingLevel` reads it as "no cap", and every cap test stays green
          // over a hub serving uncapped.
          forcedBrowsingLevel: true,
          sources: expect.objectContaining({ where: { enabled: true } }),
        }),
      })
    );
  });
});

/**
 * Which tags a hub may name. The tag table carries the moderation labels the
 * scanners write and the system tags the site runs on beside the subject tags, and
 * a hub source is an id — so without this a hub can be keyed on any of them.
 */
describe('tag sources are restricted to the browsable vocabulary', () => {
  const findTags = dbMock.dbRead.tag.findMany;
  const imageTag = (over: Record<string, unknown> = {}) => ({
    id: 77,
    name: 'dragon',
    type: TagType.UserGenerated,
    target: [TagTarget.Image],
    unlisted: false,
    adminOnly: false,
    ...over,
  });
  const withTag = (exclude = false) => ({
    name: 'tagged',
    sources: [{ type: UserHubSourceType.Tag, targetId: 77, enabled: true, exclude, index: 0 }],
    userId: 5,
  });

  beforeEach(() => {
    dbMock.dbRead.userHub.count.mockResolvedValue(0);
    dbMock.dbWrite.userHub.create.mockResolvedValue({ id: 7, metadata: {}, sources: [] });
  });

  it('accepts a listed image tag', async () => {
    // The negative control for every refusal below. Without it a guard that throws
    // on every tag passes this whole block while shipping no tag sources at all.
    findTags.mockResolvedValue([imageTag()]);

    await upsertUserHub(withTag());

    expect(dbMock.dbWrite.userHub.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a moderation label', imageTag({ type: TagType.Moderation })],
    ['a system tag', imageTag({ type: TagType.System })],
    ['an unlisted tag', imageTag({ unlisted: true })],
    ['an admin-only tag', imageTag({ adminOnly: true })],
    ['a tag that does not apply to images', imageTag({ target: [TagTarget.Model] })],
  ])('refuses %s', async (_label, tag) => {
    findTags.mockResolvedValue([tag]);

    await expect(upsertUserHub(withTag())).rejects.toThrow(/not found/i);
    expect(dbMock.dbWrite.userHub.create).not.toHaveBeenCalled();
  });

  it('refuses a tag id that matches no row', async () => {
    findTags.mockResolvedValue([]);

    await expect(upsertUserHub(withTag())).rejects.toThrow(/not found/i);
  });

  it('applies the same rule to an EXCLUDED tag', async () => {
    // The direction that reads as harmless — keeping something out cannot show
    // anything. It still names a moderation label by id, and the error text would
    // confirm which ids are moderation labels to anyone counting.
    findTags.mockResolvedValue([imageTag({ type: TagType.Moderation })]);

    await expect(upsertUserHub(withTag(true))).rejects.toThrow(/not found/i);
  });
});

describe('upsertUserHub', () => {
  it('creates a creator-only hub', async () => {
    // The negative control for every rejection below, and the only thing standing
    // between us and a mutation that makes EVERY upsert throw. Without it,
    // `if (!collectionIds.length) return` -> `< 0` kills the shipped feature and
    // the suite still prints all-green.
    dbMock.dbRead.userHub.count.mockResolvedValue(0);
    dbMock.dbWrite.userHub.create.mockResolvedValue({ id: 7, sources: [] });

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
    dbMock.dbWrite.userHub.create.mockResolvedValue({ id: 8, sources: [] });

    await upsertUserHub({ name: 'defaults', sources: [], userId: 5 });

    const arg = dbMock.dbWrite.userHub.create.mock.calls[0][0];
    // NOT Newest: a caller that omitted the field cannot have decided this viewer is
    // offered Newest, and the sort menu withholds it from anyone who cannot view NSFW.
    expect(arg.data.sort).toBe(ImageSort.MostReactions);
    expect(arg.data.period).toBe(MetricTimeframe.AllTime);

    // The half the title used to claim and never exercised: the same call shape
    // against an existing hub must not carry those values, or toggling a source
    // resets the user's sort.
    dbMock.dbWrite.userHub.findFirst.mockResolvedValue({
      id: 9,
      userId: 5,
      metadata: {},
      sources: [],
    });

    await upsertUserHub({ id: 9, name: 'defaults', sources: [], userId: 5 });

    const updateArg = dbMock.dbWrite.userHub.update.mock.calls[0][0];
    expect(updateArg.data.sort).toBeUndefined();
    expect(updateArg.data.period).toBeUndefined();
  });

  it('leaves the sources alone when the input omits them', async () => {
    // A rename and a sort change both used to resend their own cached copy of the
    // whole list, so either could revert a source edit made in between. With the
    // list omitted the update must not touch UserHubSource at all.
    dbMock.dbWrite.userHub.findFirst.mockResolvedValue({
      id: 9,
      userId: 5,
      metadata: {},
      sources: [],
    });

    await upsertUserHub({ id: 9, name: 'renamed', userId: 5 });

    expect(dbMock.dbWrite.userHubSource.deleteMany).not.toHaveBeenCalled();
    const arg = dbMock.dbWrite.userHub.update.mock.calls[0][0];
    expect(arg.data.sources).toBeUndefined();
    expect(arg.data.name).toBe('renamed');
  });

  it('still replaces the sources when the input carries them', async () => {
    // Negative control for the test above: without it, an update branch that
    // dropped source writes entirely would pass.
    dbMock.dbWrite.userHub.findFirst.mockResolvedValue({
      id: 9,
      userId: 5,
      metadata: {},
      sources: [],
    });

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
    dbMock.dbWrite.userHub.findFirst.mockResolvedValue({
      id: 9,
      userId: 5,
      metadata: {},
      sources: [],
    });

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

  // Reported 2026-08-26: a viewer following 2,738 creators could not find one of them
  // in the picker. The name filter runs over what the relationship query returns, so
  // the window is not a page size — it is the whole searchable set, and the creator
  // sat at position 1,905 of the follow list. Do not lower these back to one window
  // without re-measuring the search: they are what makes a rare name reachable.
  it('reaches past the recent-relationships window when there is a term to search', async () => {
    dbMock.dbRead.userEngagement.findMany.mockResolvedValue([{ targetUserId: 11 }]);
    dbMock.dbRead.user.findMany.mockResolvedValue([{ id: 11, username: 'someone' }]);

    await getHubSourceSuggestions({ userId: 5, type: UserHubSourceType.User });
    const listing = dbMock.dbRead.userEngagement.findMany.mock.calls[0][0].take;

    await getHubSourceSuggestions({ userId: 5, type: UserHubSourceType.User, query: 'some' });
    const searching = dbMock.dbRead.userEngagement.findMany.mock.calls[1][0].take;

    expect(searching).toBeGreaterThan(listing);
    expect(searching).toBeGreaterThan(2738);
  });

  it('treats a one-character term as no term at all', async () => {
    // Measured on the prod replica: a term costs the whole relationship read whatever
    // its length — up to 1.02 GB of buffer touches on the models arm — and one
    // character matches most of the window anyway. So the first keystroke lists
    // instead of searching.
    dbMock.dbRead.userEngagement.findMany.mockResolvedValue([{ targetUserId: 11 }]);
    dbMock.dbRead.user.findMany.mockResolvedValue([{ id: 11, username: 'someone' }]);

    await getHubSourceSuggestions({ userId: 5, type: UserHubSourceType.User, query: 's' });

    const names = dbMock.dbRead.user.findMany.mock.calls[0][0];
    expect(names.where.username).toBeUndefined();
    expect(names.orderBy).toBeUndefined();

    // The half that costs something: the RELATIONSHIP read must stay at the listing
    // window too. Reading it with `trimmed` instead of `term` produces an identical
    // name query while paying the full 5,000-row read this gate exists to avoid.
    const follows = dbMock.dbRead.userEngagement.findMany.mock.calls[0][0];
    expect(follows.take).toBe(500);

    // The boundary, in the same test: two characters must SEARCH. Without this the
    // constant is only pinned to (1, 4] — raising it to 3 or 4 silently turns the
    // shortest terms people actually type into a recency list, and every other query
    // in this file is four characters, so nothing else would notice.
    await getHubSourceSuggestions({ userId: 5, type: UserHubSourceType.User, query: 'so' });

    const searched = dbMock.dbRead.user.findMany.mock.calls[1][0];
    expect(searched.where.username).toEqual({ contains: 'so', mode: 'insensitive' });
  });

  it('hands the WHOLE window to the name query, not a page of it', async () => {
    // The window only helps if `scopeSuggestionIds` passes all of it through. Slicing
    // there unconditionally collapses the searchable set to 50 — a worse regression
    // than the bug this fixes, and invisible to every other search test in this file,
    // which all mock a handful of ids.
    const followed = Array.from({ length: 600 }, (_, i) => ({ targetUserId: 100 + i }));
    dbMock.dbRead.userEngagement.findMany.mockResolvedValue(followed);
    dbMock.dbRead.user.findMany.mockResolvedValue([{ id: 100, username: 'someone' }]);

    await getHubSourceSuggestions({ userId: 5, type: UserHubSourceType.User, query: 'some' });

    const names = dbMock.dbRead.user.findMany.mock.calls[0][0];
    expect(names.where.id.in).toHaveLength(600);
    expect(names.take).toBe(25);
  });

  // Skipped while collections are dark, following the four `skipIf` cases above: the
  // arm returns before its query, so an assertion on it would pass with the widened
  // window reverted. It runs the day the constant flips, which is the day it means
  // something.
  it.skipIf(!HUB_COLLECTION_SOURCES_ENABLED)(
    'widens the collections relationship query for a search too',
    async () => {
      dbMock.dbRead.collectionContributor.findMany.mockResolvedValue([{ collectionId: 3 }]);
      dbMock.dbRead.collection.findMany.mockResolvedValue([{ id: 3, name: 'stuff' }]);

      await getHubSourceSuggestions({ userId: 5, type: UserHubSourceType.Collection });
      const listing = dbMock.dbRead.collectionContributor.findMany.mock.calls[0][0].take;

      await getHubSourceSuggestions({
        userId: 5,
        type: UserHubSourceType.Collection,
        query: 'stu',
      });
      const searchCall = dbMock.dbRead.collectionContributor.findMany.mock.calls[1][0];

      expect(searchCall.take).toBeGreaterThan(listing);
      // `nulls: 'last'` because the column is nullable and Postgres sorts DESC as
      // NULLS FIRST — without it the window fills with rows carrying no date at all,
      // which is the opposite of the recency cut this claims to be.
      expect(searchCall.orderBy).toEqual({ createdAt: { sort: 'desc', nulls: 'last' } });
      // And the whole window must reach the names query here too, the same way it
      // does on the creators arm.
      expect(dbMock.dbRead.collection.findMany.mock.calls[1][0].where.id.in).toEqual([3]);
    }
  );

  it('widens every models relationship query for a search, not just the creators one', async () => {
    dbMock.dbRead.collection.findFirst.mockResolvedValue({ id: 77 });
    dbMock.dbRead.model.findMany.mockResolvedValue([{ id: 1 }]);
    dbMock.dbRead.modelEngagement.findMany.mockResolvedValue([{ modelId: 2 }]);
    dbMock.dbRead.collectionItem.findMany.mockResolvedValue([{ modelId: 3 }]);

    await getHubSourceSuggestions({ userId: 5, type: UserHubSourceType.Model });
    const listing = [
      dbMock.dbRead.model.findMany.mock.calls[0][0].take,
      dbMock.dbRead.modelEngagement.findMany.mock.calls[0][0].take,
      dbMock.dbRead.collectionItem.findMany.mock.calls[0][0].take,
    ];

    await getHubSourceSuggestions({ userId: 5, type: UserHubSourceType.Model, query: 'nova' });
    // The names query is call 1 on `model.findMany` with no term and call 3 with one,
    // so the id queries are 0 and 2 — reading the wrong one is how a widened window
    // gets asserted against a page size.
    const searching = [
      dbMock.dbRead.model.findMany.mock.calls[2][0].take,
      dbMock.dbRead.modelEngagement.findMany.mock.calls[1][0].take,
      dbMock.dbRead.collectionItem.findMany.mock.calls[1][0].take,
    ];

    expect(listing).toEqual([listing[0], listing[0], listing[0]]);
    expect(searching).toEqual([searching[0], searching[0], searching[0]]);
    expect(searching[0]).toBeGreaterThan(listing[0]);
  });

  it('keeps the most recent relationships when there is nothing to search', async () => {
    // Ordering by name sits above `take`, so with no term it would decide WHICH
    // suggestions survive: a viewer following more than a page of creators would
    // get the alphabetically first ones and never their most recent follows.
    const followed = Array.from({ length: 60 }, (_, i) => ({ targetUserId: 100 + i }));
    dbMock.dbRead.userEngagement.findMany.mockResolvedValue(followed);
    dbMock.dbRead.user.findMany.mockResolvedValue([
      { id: 101, username: 'zoe' },
      { id: 100, username: 'aaron' },
    ]);

    const result = await getHubSourceSuggestions({ userId: 5, type: UserHubSourceType.User });

    const names = dbMock.dbRead.user.findMany.mock.calls[0][0];
    expect(names.orderBy).toBeUndefined();
    // A margin over the page size, because deleted rows are filtered after the id
    // restriction — asking for exactly 25 returns a short page when one has gone.
    expect(names.where.id.in).toEqual(followed.slice(0, 50).map((f) => f.targetUserId));
    expect(names.where.id.in.length).toBeGreaterThan(25);
    expect(result.map((r) => r.targetId)).toEqual([100, 101]);
  });

  it('trims the deleted-row margin back to one page, keeping the most recent', async () => {
    const followed = Array.from({ length: 60 }, (_, i) => ({ targetUserId: 100 + i }));
    dbMock.dbRead.userEngagement.findMany.mockResolvedValue(followed);
    // 40 survive the `deletedAt` filter, in whatever order the PK scan produced.
    dbMock.dbRead.user.findMany.mockResolvedValue(
      Array.from({ length: 40 }, (_, i) => ({ id: 139 - i, username: `user${139 - i}` }))
    );

    const result = await getHubSourceSuggestions({ userId: 5, type: UserHubSourceType.User });

    expect(result).toHaveLength(25);
    // The 25 earliest positions in the follow list, not the 25 the query happened to
    // return first — a page short of 25, or ordered by id, both fail here.
    expect(result.map((r) => r.targetId)).toEqual(Array.from({ length: 25 }, (_, i) => 100 + i));
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
    // The shape `ModelEngagement_notify_userId_createdAt_idx` was built to serve.
    // Changing this to any other column silently makes that index unusable and the
    // arm goes back to reading every row — 250,491 of them on the largest account.
    expect(engaged.orderBy).toEqual({ createdAt: 'desc' });
    const names = dbMock.dbRead.model.findMany.mock.calls[1][0];
    expect(names.where.id).toEqual({ in: [1, 2, 3] });
    expect(names.where.name).toEqual({ contains: 'nova', mode: 'insensitive' });
    expect(names.orderBy).toEqual({ name: 'asc' });
  });

  it('offers only the models the paste-a-link path would resolve', async () => {
    dbMock.dbRead.collection.findFirst.mockResolvedValue(null);
    dbMock.dbRead.model.findMany.mockResolvedValue([{ id: 1 }]);
    dbMock.dbRead.modelEngagement.findMany.mockResolvedValue([{ modelId: 2 }]);
    dbMock.dbRead.collectionItem.findMany.mockResolvedValue([]);

    await getHubSourceSuggestions({ userId: 5, type: UserHubSourceType.Model });
    const suggested = dbMock.dbRead.model.findMany.mock.calls[1][0].where;

    dbMock.dbRead.model.findFirst.mockResolvedValue(null);
    await resolveHubSourceFromUrl({ url: 'https://civitai.com/models/2', userId: 5 });
    const resolved = dbMock.dbRead.model.findFirst.mock.calls[0][0].where;

    // Read off the resolve path rather than written out here, so the two cannot drift.
    expect(suggested.deletedAt).toEqual(resolved.deletedAt);
    expect(suggested.OR).toEqual(resolved.OR);
    // The control: two undefined visibility clauses would satisfy the pair above.
    expect(resolved.OR).toEqual([
      { userId: 5 },
      { status: ModelStatus.Published, availability: { not: Availability.Private } },
    ]);
  });

  it('lifts the visibility filter for a moderator, as the link path does', async () => {
    dbMock.dbRead.collection.findFirst.mockResolvedValue(null);
    dbMock.dbRead.model.findMany.mockResolvedValue([{ id: 1 }]);
    dbMock.dbRead.modelEngagement.findMany.mockResolvedValue([]);
    dbMock.dbRead.collectionItem.findMany.mockResolvedValue([]);

    await getHubSourceSuggestions({
      userId: 5,
      type: UserHubSourceType.Model,
      isModerator: true,
    });

    const suggested = dbMock.dbRead.model.findMany.mock.calls[1][0].where;
    expect(suggested.OR).toBeUndefined();
    expect(suggested.deletedAt).toBeNull();
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

describe('addUserHubSource', () => {
  const source = { type: UserHubSourceType.User, targetId: 42, alias: 'someone' };

  it('refuses a hub the viewer does not own', async () => {
    writerHub.mockResolvedValue(null);

    await expect(addUserHubSource({ userId: 999, hubId: 1, ...source })).rejects.toThrow();
    expect(dbMock.dbWrite.userHubSource.create).not.toHaveBeenCalled();
    expect(writerHub).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 1, userId: 999 } })
    );
  });

  it('is a no-op when the hub already has that source', async () => {
    writerHub.mockResolvedValue({
      id: 1,
      sources: [{ id: 9, type: UserHubSourceType.User, targetId: 42, enabled: true, index: 0 }],
    });

    const result = await addUserHubSource({ userId: 5, hubId: 1, ...source });

    expect(result).toEqual({ hubId: 1, added: false });
    expect(dbMock.dbWrite.userHubSource.create).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.userHubSource.updateMany).not.toHaveBeenCalled();
  });

  it('re-enables a source the owner had switched off, rather than reporting a no-op', async () => {
    // A disabled source is invisible to the feed, so "already there" would be a success
    // message for a hub that still shows the viewer nothing from that creator.
    writerHub.mockResolvedValue({
      id: 1,
      sources: [{ id: 9, type: UserHubSourceType.User, targetId: 42, enabled: false, index: 0 }],
    });

    const result = await addUserHubSource({ userId: 5, hubId: 1, ...source });

    expect(result).toEqual({ hubId: 1, added: true });
    // Owner-scoped on the write, not only in the SELECT above: id-addressing is safe
    // only while a source row cannot change hubs, and nothing enforces that.
    expect(dbMock.dbWrite.userHubSource.updateMany).toHaveBeenCalledWith({
      where: { id: 9, hub: { userId: 5 } },
      data: { enabled: true },
    });
    expect(dbMock.dbWrite.userHubSource.create).not.toHaveBeenCalled();
  });

  it('tells two sources apart by type as well as target', async () => {
    // Matching on targetId alone would report Model 42 as already present in a hub that
    // holds User 42, and the checkbox would never tick with nothing to explain it.
    writerHub.mockResolvedValue({
      id: 1,
      sources: [{ id: 9, type: UserHubSourceType.Model, targetId: 42, enabled: true, index: 3 }],
    });

    const result = await addUserHubSource({ userId: 5, hubId: 1, ...source });

    expect(result).toEqual({ hubId: 1, added: true });
    expect(dbMock.dbWrite.userHubSource.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: UserHubSourceType.User, targetId: 42, index: 4 }),
    });
  });

  it('refuses a Collection source while collection sources are switched off', async () => {
    // The router accepts the whole enum, so this is reachable even though the modal
    // never sends it. `assertHubSourcesUsable` is the only thing that refuses it, and
    // deleting that call from the add path is otherwise invisible.
    writerHub.mockResolvedValue({ id: 1, sources: [] });

    await expect(
      addUserHubSource({
        userId: 5,
        hubId: 1,
        type: UserHubSourceType.Collection,
        targetId: 7,
        alias: null,
      })
    ).rejects.toThrow();
    expect(dbMock.dbWrite.userHubSource.create).not.toHaveBeenCalled();
  });

  it('adds past the highest existing index, not past the count', async () => {
    // Indexes are not dense — removing a source leaves a gap — so appending at
    // `length` collides with a row that is still there.
    writerHub.mockResolvedValue({
      id: 1,
      sources: [
        { id: 1, type: UserHubSourceType.Model, targetId: 1, enabled: true, index: 0 },
        { id: 2, type: UserHubSourceType.Model, targetId: 2, enabled: true, index: 7 },
      ],
    });

    await addUserHubSource({ userId: 5, hubId: 1, ...source });

    expect(dbMock.dbWrite.userHubSource.create).toHaveBeenCalledWith({
      data: { hubId: 1, type: UserHubSourceType.User, targetId: 42, alias: 'someone', index: 8 },
    });
  });

  it('refuses to go past the per-hub source cap', async () => {
    writerHub.mockResolvedValue({
      id: 1,
      sources: Array.from({ length: hubLimits.sourcesPerHub }, (_, i) => ({
        id: i + 1,
        type: UserHubSourceType.Model,
        targetId: i + 100,
        enabled: true,
        index: i,
      })),
    });

    await expect(addUserHubSource({ userId: 5, hubId: 1, ...source })).rejects.toThrow();
    expect(dbMock.dbWrite.userHubSource.create).not.toHaveBeenCalled();
  });
});

describe('removeUserHubSource', () => {
  it('refuses a hub the viewer does not own', async () => {
    writerHub.mockResolvedValue(null);

    await expect(
      removeUserHubSource({ userId: 999, hubId: 1, type: UserHubSourceType.User, targetId: 42 })
    ).rejects.toThrow();
    expect(dbMock.dbWrite.userHubSource.deleteMany).not.toHaveBeenCalled();
    // The scope has to be IN the lookup. Asserting only that a null hub throws passes
    // just as well when the lookup stops asking whose hub it is.
    expect(writerHub).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 1, userId: 999 } })
    );
  });

  it('deletes only the named source in that hub', async () => {
    writerHub.mockResolvedValue({ id: 1 });
    dbMock.dbWrite.userHubSource.deleteMany.mockResolvedValue({ count: 1 });

    const result = await removeUserHubSource({
      userId: 5,
      hubId: 1,
      type: UserHubSourceType.User,
      targetId: 42,
    });

    expect(result).toEqual({ hubId: 1, removed: true });
    // Owner-scoped on the DELETE too, not only in the lookup above it — dropping it
    // there is a cross-owner delete the moment `UserHub.userId` can move.
    expect(dbMock.dbWrite.userHubSource.deleteMany).toHaveBeenCalledWith({
      where: { hubId: 1, type: UserHubSourceType.User, targetId: 42, hub: { userId: 5 } },
    });
  });
});

describe('getUserHubs', () => {
  it('asks the database for the list in alphabetical order', async () => {
    // Ordering above a read decides WHICH rows come back once there is a limit, and
    // sorting in the component would leave the rail and the server disagreeing.
    dbMock.dbRead.userHub.findMany.mockResolvedValue([]);

    await getUserHubs({ userId: 5 });

    expect(dbMock.dbRead.userHub.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { name: 'asc' } })
    );
  });

  it('marks the caller as the owner of their own hubs', async () => {
    dbMock.dbRead.userHub.findMany.mockResolvedValue([{ id: 1, userId: 5, metadata: {} }]);

    const [hub] = await getUserHubs({ userId: 5 });

    expect(hub.isOwner).toBe(true);
  });
});

describe('getUserHubById', () => {
  it('scopes the read to what this viewer may open', async () => {
    findFirstHub.mockResolvedValue({ id: 1, userId: 5, metadata: {}, sources: [] });

    await getUserHubById({ id: 1, userId: 5 });

    expect(findFirstHub).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1, OR: [{ userId: 5 }, { availability: Availability.Public }] },
      })
    );
  });

  it('is a not-found for a hub the viewer may not open', async () => {
    // Revoking Public makes every shared link 404 by this route and no other: there
    // is no separate list of issued links to keep in step.
    findFirstHub.mockResolvedValue(null);

    await expect(getUserHubById({ id: 1, userId: 999 })).rejects.toThrow(/not found/i);
  });

  it('reports a moderator as NOT the owner, so the client renders it read-only', async () => {
    // "View only" is the whole scope of moderator access. `isOwner` is what every
    // write affordance branches on, so a moderator reading as owner would hand them
    // an edit UI nobody agreed to.
    findFirstHub.mockResolvedValue({ id: 1, userId: 5, metadata: {}, sources: [] });

    const hub = await getUserHubById({ id: 1, userId: 999, isModerator: true });

    expect(hub.isOwner).toBe(false);
  });

  it('reports a signed-out viewer as NOT the owner even if the row carries no userId', async () => {
    // The row shape that makes `hub.userId === viewerId` come out TRUE for a
    // stranger: `undefined === undefined`. One dropped key in `hubSelect` reaches
    // it, and the mistake grants an edit UI on someone else's hub rather than
    // erroring. A row with a real userId cannot tell this test from a broken one,
    // which is why it is written against the nullish row.
    findFirstHub.mockResolvedValue({ id: 1, userId: undefined, metadata: {}, sources: [] });

    const hub = await getUserHubById({ id: 1 });

    expect(hub.isOwner).toBe(false);
  });
});

describe('hubWriterWhere', () => {
  it('scopes an ordinary caller to their own hubs', () => {
    expect(hubWriterWhere({ userId: 5 })).toStrictEqual({ userId: 5 });
  });

  it('does NOT let Public grant writing', () => {
    // The whole reason this is a second fragment rather than `hubViewerWhere`:
    // Public means anyone holding the link can READ. Reusing the read fragment here
    // would let any viewer of a shared hub rename or delete it.
    expect(JSON.stringify(hubWriterWhere({ userId: 5 }))).not.toContain('availability');
  });

  it('lets a moderator manage any hub', () => {
    expect(hubWriterWhere({ userId: 5, isModerator: true })).toStrictEqual({});
  });
});

describe('deleteUserHub', () => {
  it('scopes the delete to the caller by default', async () => {
    dbMock.dbWrite.userHub.deleteMany.mockResolvedValue({ count: 1 });

    await deleteUserHub({ id: 9, userId: 5 });

    expect(dbMock.dbWrite.userHub.deleteMany).toHaveBeenCalledWith({
      where: { id: 9, userId: 5 },
    });
  });

  it('lets a moderator delete a hub that is not theirs', async () => {
    dbMock.dbWrite.userHub.deleteMany.mockResolvedValue({ count: 1 });

    await deleteUserHub({ id: 9, userId: 5, isModerator: true });

    expect(dbMock.dbWrite.userHub.deleteMany).toHaveBeenCalledWith({ where: { id: 9 } });
  });
});

describe('the moderator write line is enforced, not just described', () => {
  it('refuses a moderator replacing another user’s source list', async () => {
    // `hubWriterWhere` opens the ROW to a moderator, and `upsert` is how a source
    // list is written — so without an explicit refusal here, one API call replaces
    // someone's whole curation. The client never offers it; that is not a control.
    dbMock.dbWrite.userHub.findFirst.mockResolvedValue({ id: 9, userId: 42, metadata: {} });

    await expect(
      upsertUserHub({ id: 9, userId: 5, isModerator: true, sources: [] })
    ).rejects.toThrow(/only the owner/i);
  });

  it('refuses a moderator setting another user’s content level', async () => {
    dbMock.dbWrite.userHub.findFirst.mockResolvedValue({ id: 9, userId: 42, metadata: {} });

    await expect(
      upsertUserHub({ id: 9, userId: 5, isModerator: true, forcedBrowsingLevel: 1 })
    ).rejects.toThrow(/only the owner/i);
  });

  it('still lets a moderator rename and re-describe it', async () => {
    // The control. Without it the two refusals above pass for a service that refuses
    // every moderator write, which is not what Justin asked for.
    dbMock.dbWrite.userHub.findFirst.mockResolvedValue({ id: 9, userId: 42, metadata: {} });

    await expect(
      upsertUserHub({ id: 9, userId: 5, isModerator: true, name: 'renamed by a mod' })
    ).resolves.toBeDefined();
  });

  it('leaves the OWNER able to change both', async () => {
    dbMock.dbWrite.userHub.findFirst.mockResolvedValue({ id: 9, userId: 5, metadata: {} });

    await expect(
      upsertUserHub({ id: 9, userId: 5, sources: [], forcedBrowsingLevel: 1 })
    ).resolves.toBeDefined();
  });
});

describe('getUserHubForRoute', () => {
  it('scopes the route read the same way the tRPC read is scoped', async () => {
    // The SSR 404 and the client query must not be able to disagree — they share
    // `hubViewerWhere`, and this is what pins that they do.
    findFirstHub.mockResolvedValue({ id: 1, name: 'Cute Models' });

    await getUserHubForRoute({ id: 1, userId: 5 });

    expect(findFirstHub).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1, OR: [{ userId: 5 }, { availability: Availability.Public }] },
      })
    );
  });

  it('returns the name, which the canonical slug redirect needs', async () => {
    findFirstHub.mockResolvedValue({ id: 1, name: 'Cute Models' });

    expect(await getUserHubForRoute({ id: 1, userId: 5 })).toMatchObject({ name: 'Cute Models' });
  });

  it('asks for the columns the route gate and the meta tags read', async () => {
    // `availability` in particular: a mocked Prisma call ignores `select`, so dropping
    // it leaves every test here green while `hubRouteIsDark` reads `undefined` in
    // production, treats every hub as non-public, and 404s the previews.
    findFirstHub.mockResolvedValue({ id: 1, name: 'Cute Models', availability: 'Public' });

    await getUserHubForRoute({ id: 1, userId: 5 });

    expect(findFirstHub.mock.calls[0][0].select).toEqual({
      id: true,
      name: true,
      availability: true,
      metadata: true,
    });
  });

  it('returns the description, which the page renders as og:description', async () => {
    // Server-side, because the hub the page body uses arrives through a client query
    // — a description read off that never reaches the HTML an unfurler fetches.
    findFirstHub.mockResolvedValue({
      id: 1,
      name: 'Cute Models',
      availability: Availability.Public,
      metadata: { description: 'Models I think are neat' },
    });

    expect(await getUserHubForRoute({ id: 1, userId: 5 })).toMatchObject({
      description: 'Models I think are neat',
      // The value the whole feature turns on, and it is COMPUTED here — `UserHub` has
      // no `key` column. Passing one through from the row would be `undefined` in
      // production while a mock that supplies it stays green.
      key: encodeHubId(1),
    });
  });

  it('returns a null description rather than whatever metadata happens to hold', async () => {
    findFirstHub.mockResolvedValue({
      id: 1,
      name: 'Cute Models',
      availability: Availability.Public,
      metadata: { description: { nope: true } },
    });

    expect(await getUserHubForRoute({ id: 1, userId: 5 })).toMatchObject({ description: null });
  });

  it('returns null for a hub this viewer may not open', async () => {
    // Null is what the route turns into a real 404 rather than a 200 carrying a
    // not-found component. Returning a truthy value here restores exactly the
    // behaviour the function exists to remove.
    findFirstHub.mockResolvedValue(null);

    expect(await getUserHubForRoute({ id: 1, userId: 999 })).toBeNull();
  });
});

describe('hubRouteIsDark', () => {
  // The gate the /hubs/[id] route runs. A public hub is deliberately exempt from the
  // `user-hubs` flag so a link unfurler — which fetches signed out — gets a 200 with
  // meta instead of a 404. Restoring a flat `!hubsEnabled` here is what puts hub link
  // previews back to producing nothing, and no other test would notice.
  it.each([
    { hubsEnabled: false, availability: Availability.Public, dark: false },
    { hubsEnabled: false, availability: Availability.Private, dark: true },
    { hubsEnabled: false, availability: Availability.Unsearchable, dark: true },
    { hubsEnabled: true, availability: Availability.Public, dark: false },
    { hubsEnabled: true, availability: Availability.Private, dark: false },
    // With the flag on the gate must be inert for EVERY availability, including this
    // one. Without the row, a predicate that special-cases Unsearchable passes.
    { hubsEnabled: true, availability: Availability.Unsearchable, dark: false },
  ])('flag $hubsEnabled + $availability -> dark $dark', ({ hubsEnabled, availability, dark }) => {
    expect(hubRouteIsDark({ hubsEnabled, availability })).toBe(dark);
  });
});

describe('getUserHubByKey', () => {
  // The enumeration gate itself. `getById` is the one procedure open to signed-out
  // callers, so if this accepted the pre-encoding format every public hub would be
  // walkable by counting through tRPC — the exact hole the encoding closes.
  it('decodes a real key and reads that id', async () => {
    findFirstHub.mockResolvedValue({
      id: 19,
      userId: 5,
      sources: [],
      metadata: {},
      availability: Availability.Public,
    });

    await getUserHubByKey({ key: encodeHubId(19), userId: 5 });

    expect(findFirstHub.mock.calls[0][0].where.id).toBe(19);
  });

  it.each(['19', '0', 'not-a-key', ''])(
    'refuses %j without reading anything at all',
    async (key) => {
      // `not.toHaveBeenCalled` is the load-bearing half: a decode that fell through to
      // the lookup would still 404 for a private hub and pass a result-only assertion,
      // while resolving every public one.
      await expect(getUserHubByKey({ key, userId: 5 })).rejects.toThrow(/not found/i);
      expect(findFirstHub).not.toHaveBeenCalled();
    }
  );
});

describe('getHubCardData', () => {
  it('resolves a PUBLIC hub only, whoever is asking', async () => {
    // The card is served unauthenticated, so this `where` is the only thing between a
    // private hub's NAME and anyone who guesses its id. There is no viewer to scope
    // to — an ownership arm here would be a hole, not a courtesy.
    findFirstHub.mockResolvedValue({
      name: 'Cute Models',
      metadata: {},
      user: { username: 'ellie' },
      _count: { sources: 3, followers: 0 },
    });

    await getHubCardData(1);

    // Read off `hubViewerWhere` rather than restated here, so the card and the three
    // authenticated reads cannot drift: a rule added to the helper later reaches this
    // assertion too. The control below pins what the helper answers for no viewer.
    expect(findFirstHub).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 1, ...hubViewerWhere({}) } })
    );
    expect(hubViewerWhere({})).toEqual({ OR: [{ availability: Availability.Public }] });
  });

  it('asks for every column the card reads', async () => {
    // A mocked Prisma call IGNORES `select` and returns whatever the mock holds, so a
    // dropped column is invisible to every assertion on the RESULT. Only the argument
    // shows it.
    findFirstHub.mockResolvedValue({
      name: 'Cute Models',
      metadata: {},
      user: { username: 'ellie' },
      _count: { sources: 3, followers: 0 },
    });

    await getHubCardData(1);

    expect(findFirstHub.mock.calls[0][0].select).toEqual({
      name: true,
      metadata: true,
      user: { select: { username: true } },
      // Enabled only — the count a visitor can see, not the owner's full list.
      _count: { select: { sources: { where: { enabled: true } }, followers: true } },
    });
  });

  it('drops a description that is not a string, as the route reader does', async () => {
    findFirstHub.mockResolvedValue({
      name: 'Cute Models',
      metadata: { description: { nope: true } },
      user: { username: 'ellie' },
      _count: { sources: 1, followers: 0 },
    });

    expect(await getHubCardData(1)).toMatchObject({ description: null });
  });

  it('returns null when the hub is not public', async () => {
    // Note this is NOT a 404 at the endpoint: null renders the generic Civitai card at
    // 200, which is what keeps a private hub and a nonexistent id indistinguishable.
    // Do not "fix" that into a real 404 — it hands back the oracle this closes.
    findFirstHub.mockResolvedValue(null);

    expect(await getHubCardData(1)).toBeNull();
  });

  it('carries the counts the card puts in its stats bar', async () => {
    findFirstHub.mockResolvedValue({
      name: 'Cute Models',
      metadata: { description: 'neat' },
      user: { username: 'ellie' },
      _count: { sources: 3, followers: 12 },
    });

    expect(await getHubCardData(1)).toEqual({
      name: 'Cute Models',
      description: 'neat',
      username: 'ellie',
      sourceCount: 3,
      followerCount: 12,
    });
  });
});

describe('upsertUserHub visibility and level', () => {
  it('writes the visibility and the level the owner chose', async () => {
    // Both, in one assertion: the schema mask is tested separately, and a masked
    // value that never reaches the UPDATE is a cap the owner set and the hub does
    // not have. Dropping either from the service's destructure leaves every cap test
    // green, because those mock `resolveHubSources`.
    dbMock.dbWrite.userHub.findFirst.mockResolvedValue({
      id: 9,
      userId: 5,
      metadata: {},
      sources: [],
    });

    await upsertUserHub({
      id: 9,
      userId: 5,
      availability: Availability.Public,
      forcedBrowsingLevel: 1 | 2,
    });

    expect(dbMock.dbWrite.userHub.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 9, userId: 5 },
        data: expect.objectContaining({
          availability: Availability.Public,
          forcedBrowsingLevel: 1 | 2,
        }),
      })
    );
  });

  it('masks a level bit this deployment does not have', () => {
    // Stored unmasked, a bit for a level that does not exist yet would WIDEN the
    // hub the day that level ships, silently and without the owner touching it.
    const parsed = upsertUserHubSchema.parse({ id: 9, forcedBrowsingLevel: 1 | 2 | 4096 });

    expect(parsed.forcedBrowsingLevel).toBe(1 | 2);
  });

  it('leaves visibility and level alone when the caller omits them', () => {
    // Same "omitted means leave alone" rule the sort and the source list follow: a
    // source toggle resending its own cached copy must not republish a hub the
    // owner just made private.
    const parsed = upsertUserHubSchema.parse({ id: 9, sort: 'Newest' });

    expect('availability' in parsed).toBe(false);
    expect('forcedBrowsingLevel' in parsed).toBe(false);
  });
});
