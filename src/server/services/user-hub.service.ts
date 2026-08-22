import { dbRead, dbWrite } from '~/server/db/client';
import { Prisma } from '@prisma/client';
import type {
  GetHubSourceSuggestionsInput,
  ResolveHubSourceInput,
  SetUserHubOrderInput,
  UpsertUserHubInput,
  UserHubSourceInput,
} from '~/server/schema/user-hub.schema';
import {
  HUB_COLLECTION_SOURCES_ENABLED,
  hubFeedFiltersSchema,
  hubLimits,
} from '~/server/schema/user-hub.schema';
import { throwBadRequestError, throwNotFoundError } from '~/server/utils/errorHandling';
import {
  Availability,
  CollectionContributorPermission,
  CollectionMode,
  CollectionReadConfiguration,
  CollectionType,
  MetricTimeframe,
  ModelEngagementType,
  ModelStatus,
  UserEngagementType,
  UserHubSourceType,
} from '~/shared/utils/prisma/enums';
import { ImageSort } from '~/server/common/enums';
import { getUserCollectionPermissionsByIds } from '~/server/services/collection.service';
import type { CollectionMetadataSchema } from '~/server/schema/collection.schema';
import { getAllServerHosts } from '~/server/utils/server-domain';
import { parseCivitaiUrlSafe } from '~/utils/civitai-url';

const hubSelect = {
  id: true,
  name: true,
  index: true,
  sort: true,
  period: true,
  mediaTypes: true,
  metadata: true,
  sources: {
    select: { id: true, type: true, targetId: true, alias: true, enabled: true, index: true },
    orderBy: { index: 'asc' },
  },
} as const;

type HubRow = { metadata: Prisma.JsonValue };

function readMetadata(metadata: Prisma.JsonValue | undefined) {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : {};
}

// `metadata` never leaves the service: callers get the fields it carries, so a key
// added to it later is not published to every client by default.
function toHubDetail<T extends HubRow>({ metadata, ...hub }: T) {
  const stored = readMetadata(metadata);
  const description = stored.description;
  return {
    ...hub,
    description: typeof description === 'string' ? description : null,
    // Re-validated on the way out: what is on the row was written by an older
    // shape of this schema, and the feed refuses some combinations outright.
    filters: hubFeedFiltersSchema.catch({}).parse(stored.filters ?? {}),
  };
}

export type UserHubDetail = Awaited<ReturnType<typeof getUserHubs>>[number];

export async function getUserHubs({ userId }: { userId: number }) {
  const hubs = await dbRead.userHub.findMany({
    where: { userId },
    select: hubSelect,
    orderBy: { index: 'asc' },
  });
  return hubs.map(toHubDetail);
}

// Every read is scoped by userId rather than checked after the fetch, so an id
// belonging to someone else is a not-found rather than a leak.
export async function getUserHubById({ id, userId }: { id: number; userId: number }) {
  const hub = await dbRead.userHub.findFirst({ where: { id, userId }, select: hubSelect });
  if (!hub) throw throwNotFoundError('Hub not found');
  return toHubDetail(hub);
}

export async function upsertUserHub({ userId, ...input }: UpsertUserHubInput & { userId: number }) {
  const { id, sources, description, filters, ...data } = input;

  if (sources) {
    const duplicate = new Set<string>();
    for (const source of sources) {
      const key = `${source.type}:${source.targetId}`;
      if (duplicate.has(key)) throw throwBadRequestError('A source was added twice');
      duplicate.add(key);
    }

    await assertHubSourcesUsable({ sources, userId });
  }

  if (!id) {
    if (!data.name) throw throwBadRequestError('A new hub needs a name');

    const count = await dbRead.userHub.count({ where: { userId } });
    if (count >= hubLimits.hubsPerUser)
      throw throwBadRequestError(`You can have at most ${hubLimits.hubsPerUser} hubs`);

    const hub = await dbWrite.userHub.create({
      data: {
        ...data,
        name: data.name,
        // Not Newest: a client that omits the field cannot have decided the viewer
        // is offered Newest, and Most Reactions is the one sort nothing withholds.
        sort: data.sort ?? ImageSort.MostReactions,
        period: data.period ?? MetricTimeframe.AllTime,
        mediaTypes: data.mediaTypes ?? [],
        metadata: {
          ...(description ? { description } : {}),
          ...(filters ? { filters } : {}),
        },
        userId,
        index: count,
        sources: { create: (sources ?? []).map(({ id: _, ...source }) => source) },
      },
      select: hubSelect,
    });
    return toHubDetail(hub);
  }

  // Read through the WRITER, not the replica: this is a read-modify-write of one
  // json column, and a replica lagging behind the previous save merges a stale
  // description back over a newer one.
  const existing = await dbWrite.userHub.findFirst({
    where: { id, userId },
    select: { id: true, metadata: true },
  });
  if (!existing) throw throwNotFoundError('Hub not found');

  // Merged rather than replaced, and only ever with the one key this schema names
  // — `metadata` holds more than the description, and an omitted `description`
  // means "leave it alone" for the same reason `sources` does.
  const metadata =
    description === undefined && filters === undefined
      ? undefined
      : {
          ...readMetadata(existing.metadata),
          ...(description === undefined ? {} : { description: description || undefined }),
          ...(filters === undefined ? {} : { filters }),
        };

  if (!sources) {
    const hub = await dbWrite.userHub.update({
      where: { id, userId },
      data: { ...data, ...(metadata ? { metadata } : {}) },
      select: hubSelect,
    });
    return toHubDetail(hub);
  }

  const updated = await dbWrite.$transaction(async (tx) => {
    await tx.userHubSource.deleteMany({ where: { hubId: id } });
    return tx.userHub.update({
      // Scoped by userId as well as id, like every read here. Redundant while
      // `UserHub.userId` never changes; the moment hub sharing lands — which the
      // rail already anticipates — a check in a prior SELECT is a check that can
      // disagree with the write.
      where: { id, userId },
      data: {
        ...data,
        ...(metadata ? { metadata } : {}),
        sources: { create: sources.map(({ id: _, ...source }) => source) },
      },
      select: hubSelect,
    });
  });
  return toHubDetail(updated);
}

export async function deleteUserHub({ id, userId }: { id: number; userId: number }) {
  const { count } = await dbWrite.userHub.deleteMany({ where: { id, userId } });
  if (!count) throw throwNotFoundError('Hub not found');
}

export async function setUserHubOrder({ ids, userId }: SetUserHubOrderInput & { userId: number }) {
  const owned = await dbRead.userHub.findMany({
    where: { id: { in: ids }, userId },
    select: { id: true },
  });
  if (owned.length !== ids.length) throw throwNotFoundError('Hub not found');

  await dbWrite.$transaction(
    ids.map((id, index) => dbWrite.userHub.update({ where: { id, userId }, data: { index } }))
  );
}

export type ResolvedHubSources = {
  userIds: number[];
  modelVersionIds: number[];
  collectionIds: number[];
  /** True when a Model source expanded past the id cap and was trimmed. */
  truncated: boolean;
};

// Resolves a hub to the id sets its feed filter is built from. Returns null when
// the hub does not exist or is not the viewer's — callers must treat that as
// "return nothing", never as "no filter", the same way `newCreators` does with an
// unpopulated board.
export async function resolveHubSources({
  hubId,
  userId,
}: {
  hubId: number;
  userId?: number;
}): Promise<ResolvedHubSources | null> {
  if (!userId) return null;
  const hub = await dbRead.userHub.findFirst({
    where: { id: hubId, userId },
    select: { sources: { where: { enabled: true }, select: { type: true, targetId: true } } },
  });
  if (!hub) return null;

  const byType = (type: UserHubSourceType) =>
    hub.sources.filter((s) => s.type === type).map((s) => s.targetId);

  const modelIds = byType(UserHubSourceType.Model);
  const explicitVersionIds = byType(UserHubSourceType.ModelVersion);

  // Explicit ModelVersion sources are kept whole — the user picked those by hand —
  // so only what is left of the cap is available to expand Model sources into.
  const budget = Math.max(0, hubLimits.resolvedVersionIds - new Set(explicitVersionIds).size);

  // Each Model source gets its own share of that budget. Ranking every model's
  // versions in one `id desc` list instead would let one high-version model spend
  // the whole cap, leaving an older model contributing nothing while its row still
  // reads enabled in the rail.
  const perModel = modelIds.length ? Math.max(1, Math.floor(budget / modelIds.length)) : 0;

  let truncated = false;
  const versionIdsOfModels: number[] = [];
  if (modelIds.length && perModel > 0) {
    // One round trip, and the row count is bounded by the share rather than by how
    // many versions the models happen to have. The extra rank is only read to tell
    // whether anything was left behind.
    const ranked = await dbRead.$queryRaw<{ id: number; modelId: number; rn: bigint }[]>`
      SELECT id, "modelId", rn
      FROM (
        SELECT mv.id, mv."modelId", ROW_NUMBER() OVER (PARTITION BY mv."modelId" ORDER BY mv.id DESC) AS rn
        FROM "ModelVersion" mv
        WHERE mv."modelId" IN (${Prisma.join(modelIds)})
      ) ranked
      WHERE rn <= ${perModel + 1}
      ORDER BY id DESC
    `;
    for (const row of ranked) {
      if (Number(row.rn) > perModel) truncated = true;
      else versionIdsOfModels.push(row.id);
    }
  } else if (modelIds.length) {
    truncated = true;
  }

  const allVersionIds = [...new Set([...explicitVersionIds, ...versionIdsOfModels])];
  const modelVersionIds = allVersionIds.slice(0, hubLimits.resolvedVersionIds);
  if (allVersionIds.length > modelVersionIds.length) truncated = true;

  return {
    userIds: byType(UserHubSourceType.User),
    modelVersionIds,
    truncated,
    collectionIds: byType(UserHubSourceType.Collection),
  };
}

export function hubSourcesAreEmpty(sources: ResolvedHubSources) {
  return (
    !sources.userIds.length && !sources.modelVersionIds.length && !sources.collectionIds.length
  );
}

// Collection sources are served by the indexed `collectionIds` field, which only
// carries ACCEPTED membership of non-private collections. A collection the index
// cannot represent must be refused at add time rather than silently contributing
// nothing to the feed.
async function assertHubSourcesUsable({
  sources,
  userId,
}: {
  sources: UserHubSourceInput[];
  userId: number;
}) {
  const collectionIds = sources
    .filter((s) => s.type === UserHubSourceType.Collection)
    .map((s) => s.targetId);
  if (!collectionIds.length) return;

  if (!HUB_COLLECTION_SOURCES_ENABLED)
    throw throwBadRequestError(
      'Collections cannot be added to a hub yet. Creators, models and model versions work today.'
    );

  const collections = await dbRead.collection.findMany({
    where: { id: { in: collectionIds } },
    select: { id: true, name: true, read: true, metadata: true },
  });

  const permissionList = await getUserCollectionPermissionsByIds({ ids: collectionIds, userId });
  // Keyed on the row's own `collectionId`, not on position. Positional is correct
  // today only because the function ends in `ids.map(...)`; the obvious future
  // change — returning only the collections it found — would silently shift every
  // permission by one, and this is the caller where that misattribution is a
  // private-collection read check.
  const permissions = new Map(permissionList.map((p) => [p.collectionId, p]));

  for (const id of collectionIds) {
    const collection = collections.find((c) => c.id === id);
    if (!collection || !permissions.get(id)?.read)
      throw throwNotFoundError(`Collection ${id} not found`);

    if (collection.read === CollectionReadConfiguration.Private)
      throw throwBadRequestError(
        `"${collection.name}" is private and cannot be used as a hub source.`
      );

    // A forced browsing level is applied by the collection page's own provider and
    // has no server-side enforcement, so it cannot survive being mixed into a hub.
    // Refusing the source is the honest option; enforcing it server-side is a
    // separate piece of work that would fix the gap everywhere.
    const metadata = collection.metadata as CollectionMetadataSchema | null;
    if (metadata?.forcedBrowsingLevel)
      throw throwBadRequestError(
        `"${collection.name}" limits the content ratings it shows, which a hub cannot honour. It cannot be used as a hub source.`
      );
  }
}

// What the viewer is allowed to see the name of. This is an id-to-name lookup over
// a dense id space, so an unfiltered arm is a sweepable oracle for the names of
// drafts, unpublished models and private collections. A source they cannot see is
// a not-found, never a name plus a refusal.
const visibleModel = (userId: number, isModerator?: boolean) =>
  isModerator
    ? { deletedAt: null }
    : {
        deletedAt: null,
        OR: [
          { userId },
          { status: ModelStatus.Published, availability: { not: Availability.Private } },
        ],
      };

export async function resolveHubSourceFromUrl({
  url,
  userId,
  isModerator,
}: ResolveHubSourceInput & { userId: number; isModerator?: boolean }) {
  const ref = parseCivitaiUrlSafe(url, { hosts: getAllServerHosts() });
  if (!ref) return null;

  if (ref.type === 'user') {
    // `User.username` is citext, so a plain equals is case-insensitive AND
    // index-served. `mode: 'insensitive'` emits ILIKE, which no btree serves —
    // 4.7s full table read vs 0.14ms, measured on the prod replica.
    const user = await dbRead.user.findFirst({
      where: { username: { equals: ref.username }, deletedAt: null },
      select: { id: true, username: true },
    });
    if (!user) return null;
    return { type: UserHubSourceType.User, targetId: user.id, alias: user.username ?? url };
  }

  if (ref.type === 'model') {
    // A link carrying `?modelVersionId=` is someone looking at one version's
    // gallery, which is what they mean to follow — the whole model is a broader
    // ask than the link they copied.
    if (ref.modelVersionId)
      return resolveHubSourceFromUrl({
        url: `/model-versions/${ref.modelVersionId}`,
        userId,
        isModerator,
      });

    const model = await dbRead.model.findFirst({
      where: { id: ref.modelId, ...visibleModel(userId, isModerator) },
      select: { id: true, name: true },
    });
    if (!model) return null;
    return { type: UserHubSourceType.Model, targetId: model.id, alias: model.name };
  }

  if (ref.type === 'modelVersion') {
    const version = await dbRead.modelVersion.findFirst({
      where: {
        id: ref.modelVersionId,
        model: visibleModel(userId, isModerator),
        ...(isModerator
          ? {}
          : {
              OR: [
                { model: { userId } },
                { status: ModelStatus.Published, availability: { not: Availability.Private } },
              ],
            }),
      },
      select: { id: true, name: true, model: { select: { name: true } } },
    });
    if (!version) return null;
    return {
      type: UserHubSourceType.ModelVersion,
      targetId: version.id,
      alias: `${version.model.name} - ${version.name}`,
    };
  }

  // Same gate the write path enforces, and in the same order: refusing after
  // showing the name is not a refusal.
  if (!HUB_COLLECTION_SOURCES_ENABLED) return null;

  const [collection] = await dbRead.collection.findMany({
    where: { id: ref.collectionId, read: { not: CollectionReadConfiguration.Private } },
    select: { id: true, name: true },
    take: 1,
  });
  if (!collection) return null;

  const [permission] = await getUserCollectionPermissionsByIds({ ids: [collection.id], userId });
  if (!permission?.read) return null;

  return { type: UserHubSourceType.Collection, targetId: collection.id, alias: collection.name };
}

const SUGGESTIONS_LIMIT = 25;

// How much of the viewer's relationship list the type-ahead searches. A name filter
// expressed as a relation filter does NOT bound the work: Prisma emits it as a
// subquery, the planner walks every one of the viewer's rows probing the target
// table, and `take` only stops it early when matches are dense. Measured on the
// prod replica: a viewer following 130,006 people paid 4.8s and ~4.85GB of buffers
// for a term matching none of them — worst exactly for the rare term that makes a
// type-ahead worth having.
//
// So the relationship list drives, bounded, and the name filter runs over the ids
// it returns — a search of your most recent relationships, not all of them.
const SUGGESTIONS_WINDOW = 500;

// A margin over the page size, because the name queries filter deleted rows AFTER the
// id restriction: slicing to exactly `SUGGESTIONS_LIMIT` returns a short page whenever
// one of the ids has since been deleted (measured on prod: 2 of 500 on one account).
const SUGGESTIONS_SLICE = SUGGESTIONS_LIMIT * 2;

// The relationship queries above return their ids most-recent-first. With no search
// term that IS the answer, so the window is cut before the names query rather than
// ordered after it — ordering above a `take` decides WHICH rows come back.
function scopeSuggestionIds(ids: number[], term: string | undefined) {
  return term ? ids : ids.slice(0, SUGGESTIONS_SLICE);
}

// `IN (...)` does not preserve the order it was given, so recency is restored here and
// the margin above is trimmed off.
function bySuggestionOrder<T extends { id: number }>(
  rows: T[],
  ids: number[],
  term: string | undefined
) {
  if (term) return rows;
  const position = new Map(ids.map((id, index) => [id, index]));
  return [...rows]
    .sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0))
    .slice(0, SUGGESTIONS_LIMIT);
}

/**
 * What the source picker searches, one type at a time. Scoped to the viewer's own
 * relationships rather than the whole site: creators they follow, models they own
 * or asked to be notified about or bookmarked, and collections they follow.
 * Anything outside that is still reachable by pasting its link.
 *
 * `ModelEngagementType.Notify` is the bell — the "favourite" button sets it and
 * adds the model to the viewer's bookmark collection at the same time, which is
 * why both are read here.
 */
export async function getHubSourceSuggestions({
  userId,
  type,
  query,
}: GetHubSourceSuggestionsInput & { userId: number }) {
  const term = query?.trim();

  if (type === UserHubSourceType.User) {
    const follows = await dbRead.userEngagement.findMany({
      where: { userId, type: UserEngagementType.Follow },
      select: { targetUserId: true },
      orderBy: { createdAt: 'desc' },
      take: SUGGESTIONS_WINDOW,
    });
    if (!follows.length) return [];

    // Ordering sits ABOVE the `take`, so it decides which rows come back and not
    // merely their order. A search wants the whole window ranked by name; a bare
    // suggestion list wants the most recent relationships, so it is cut to size
    // here and the names query is left unordered.
    const followed = scopeSuggestionIds(
      follows.map((f) => f.targetUserId),
      term
    );

    const users = await dbRead.user.findMany({
      where: {
        id: { in: followed },
        deletedAt: null,
        // citext overloads equality, NOT `LIKE` — a plain `contains` here is
        // case-SENSITIVE. Safe to ask for ILIKE now only because the id list
        // above bounds it; unbounded, this is the 4.7GB scan.
        ...(term ? { username: { contains: term, mode: 'insensitive' as const } } : {}),
      },
      select: { id: true, username: true },
      ...(term ? { orderBy: { username: 'asc' as const } } : {}),
      take: term ? SUGGESTIONS_LIMIT : SUGGESTIONS_SLICE,
    });

    return bySuggestionOrder(users, followed, term)
      .filter((user): user is { id: number; username: string } => !!user.username)
      .map((user) => ({
        type: UserHubSourceType.User,
        targetId: user.id,
        alias: user.username,
      }));
  }

  if (type === UserHubSourceType.Collection) {
    // Kept behind the same switch the write path enforces: offering a collection
    // the server would refuse is worse than not listing it.
    if (!HUB_COLLECTION_SOURCES_ENABLED) return [];

    const followed = await dbRead.collectionContributor.findMany({
      where: { userId, permissions: { has: CollectionContributorPermission.VIEW } },
      select: { collectionId: true },
      take: SUGGESTIONS_WINDOW,
    });
    if (!followed.length) return [];

    const collectionIds = scopeSuggestionIds(
      followed.map((f) => f.collectionId),
      term
    );

    const collections = await dbRead.collection.findMany({
      where: {
        id: { in: collectionIds },
        ...(term ? { name: { contains: term, mode: 'insensitive' as const } } : {}),
      },
      select: { id: true, name: true },
      ...(term ? { orderBy: { name: 'asc' as const } } : {}),
      take: term ? SUGGESTIONS_LIMIT : SUGGESTIONS_SLICE,
    });

    return bySuggestionOrder(collections, collectionIds, term).map((collection) => ({
      type: UserHubSourceType.Collection,
      targetId: collection.id,
      alias: collection.name,
    }));
  }

  // The three relationships overlap, so the ids are gathered first and the name
  // filter runs once over the union.
  const bookmarkCollection = await dbRead.collection.findFirst({
    where: { userId, type: CollectionType.Model, mode: CollectionMode.Bookmark },
    select: { id: true },
  });

  const [ownModels, engaged, bookmarked] = await Promise.all([
    dbRead.model.findMany({
      where: { userId, deletedAt: null },
      select: { id: true },
      orderBy: { id: 'desc' },
      take: SUGGESTIONS_WINDOW,
    }),
    dbRead.modelEngagement.findMany({
      where: { userId, type: ModelEngagementType.Notify },
      select: { modelId: true },
      orderBy: { createdAt: 'desc' },
      take: SUGGESTIONS_WINDOW,
    }),
    bookmarkCollection
      ? dbRead.collectionItem.findMany({
          where: { collectionId: bookmarkCollection.id, modelId: { not: null } },
          select: { modelId: true },
          orderBy: { id: 'desc' },
          take: SUGGESTIONS_WINDOW,
        })
      : Promise.resolve([]),
  ]);

  const candidateIds = [
    ...new Set([
      ...ownModels.map((m) => m.id),
      ...engaged.map((e) => e.modelId),
      ...bookmarked.flatMap((b) => (b.modelId ? [b.modelId] : [])),
    ]),
  ];
  if (!candidateIds.length) return [];

  const scopedIds = scopeSuggestionIds(candidateIds, term);

  const models = await dbRead.model.findMany({
    where: {
      id: { in: scopedIds },
      deletedAt: null,
      ...(term ? { name: { contains: term, mode: 'insensitive' as const } } : {}),
    },
    select: { id: true, name: true },
    ...(term ? { orderBy: { name: 'asc' as const } } : {}),
    take: term ? SUGGESTIONS_LIMIT : SUGGESTIONS_SLICE,
  });

  return bySuggestionOrder(models, scopedIds, term).map((model) => ({
    type: UserHubSourceType.Model,
    targetId: model.id,
    alias: model.name,
  }));
}
