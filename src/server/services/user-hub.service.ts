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
  CollectionContributorPermission,
  CollectionMode,
  CollectionReadConfiguration,
  CollectionType,
  MetricTimeframe,
  ModelEngagementType,
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
        sort: data.sort ?? ImageSort.Newest,
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

  const existing = await dbRead.userHub.findFirst({
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

// Resolves a pasted link to the source it names. Server-side so the parser gets
// the real domain list and the lookup is one round trip instead of four client
// queries against four different routers.
export async function resolveHubSourceFromUrl({ url }: ResolveHubSourceInput) {
  const ref = parseCivitaiUrlSafe(url, { hosts: getAllServerHosts() });
  if (!ref) return null;

  if (ref.type === 'user') {
    const user = await dbRead.user.findFirst({
      where: { username: { equals: ref.username, mode: 'insensitive' }, deletedAt: null },
      select: { id: true, username: true },
    });
    if (!user) return null;
    return { type: UserHubSourceType.User, targetId: user.id, alias: user.username ?? url };
  }

  if (ref.type === 'model') {
    const model = await dbRead.model.findFirst({
      where: { id: ref.modelId, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!model) return null;
    return { type: UserHubSourceType.Model, targetId: model.id, alias: model.name };
  }

  if (ref.type === 'modelVersion') {
    const version = await dbRead.modelVersion.findFirst({
      where: { id: ref.modelVersionId },
      select: { id: true, name: true, model: { select: { name: true, deletedAt: true } } },
    });
    if (!version || version.model.deletedAt) return null;
    return {
      type: UserHubSourceType.ModelVersion,
      targetId: version.id,
      alias: `${version.model.name} - ${version.name}`,
    };
  }

  const collection = await dbRead.collection.findFirst({
    where: { id: ref.collectionId },
    select: { id: true, name: true },
  });
  if (!collection) return null;
  return { type: UserHubSourceType.Collection, targetId: collection.id, alias: collection.name };
}

const SUGGESTIONS_PER_ARM = 25;

/**
 * What the source picker searches. Scoped to the viewer's own relationships
 * rather than the whole site: creators they follow, models they own or asked to
 * be notified about or bookmarked, and collections they follow. Anything outside
 * that is still reachable by pasting its link.
 *
 * `ModelEngagementType.Notify` is the bell — the "favourite" button sets it and
 * adds the model to the viewer's bookmark collection at the same time, which is
 * why both are read here.
 */
export async function getHubSourceSuggestions({
  userId,
  query,
}: GetHubSourceSuggestionsInput & { userId: number }) {
  const term = query?.trim();
  const contains = term ? { contains: term, mode: 'insensitive' as const } : undefined;

  const [follows, ownModels, engagedModels, bookmarkCollection, followedCollections] =
    await Promise.all([
      dbRead.userEngagement.findMany({
        where: {
          userId,
          type: UserEngagementType.Follow,
          targetUser: { deletedAt: null, ...(contains ? { username: contains } : {}) },
        },
        select: { targetUser: { select: { id: true, username: true } } },
        orderBy: { createdAt: 'desc' },
        take: SUGGESTIONS_PER_ARM,
      }),
      dbRead.model.findMany({
        where: { userId, deletedAt: null, ...(contains ? { name: contains } : {}) },
        select: { id: true, name: true },
        orderBy: { id: 'desc' },
        take: SUGGESTIONS_PER_ARM,
      }),
      dbRead.modelEngagement.findMany({
        where: {
          userId,
          type: ModelEngagementType.Notify,
          model: { deletedAt: null, ...(contains ? { name: contains } : {}) },
        },
        select: { model: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' },
        take: SUGGESTIONS_PER_ARM,
      }),
      dbRead.collection.findFirst({
        where: { userId, type: CollectionType.Model, mode: CollectionMode.Bookmark },
        select: { id: true },
      }),
      dbRead.collectionContributor.findMany({
        where: {
          userId,
          permissions: { has: CollectionContributorPermission.VIEW },
          ...(contains ? { collection: { name: contains } } : {}),
        },
        select: { collection: { select: { id: true, name: true } } },
        take: SUGGESTIONS_PER_ARM,
      }),
    ]);

  const bookmarked = bookmarkCollection
    ? await dbRead.collectionItem.findMany({
        where: {
          collectionId: bookmarkCollection.id,
          model: { deletedAt: null, ...(contains ? { name: contains } : {}) },
        },
        select: { model: { select: { id: true, name: true } } },
        orderBy: { id: 'desc' },
        take: SUGGESTIONS_PER_ARM,
      })
    : [];

  const models = new Map<number, string>();
  for (const model of ownModels) models.set(model.id, model.name);
  for (const { model } of engagedModels) if (model) models.set(model.id, model.name);
  for (const { model } of bookmarked) if (model) models.set(model.id, model.name);

  return {
    users: follows
      .map(({ targetUser }) => targetUser)
      .filter((user): user is { id: number; username: string } => !!user?.username)
      .map((user) => ({
        type: UserHubSourceType.User,
        targetId: user.id,
        alias: user.username,
      })),
    models: [...models].slice(0, SUGGESTIONS_PER_ARM).map(([id, name]) => ({
      type: UserHubSourceType.Model,
      targetId: id,
      alias: name,
    })),
    // Kept behind the same switch the write path enforces: offering a collection
    // the server would refuse is worse than not listing it.
    collections: HUB_COLLECTION_SOURCES_ENABLED
      ? followedCollections
          .map(({ collection }) => collection)
          .filter((collection): collection is { id: number; name: string } => !!collection)
          .map((collection) => ({
            type: UserHubSourceType.Collection,
            targetId: collection.id,
            alias: collection.name,
          }))
      : [],
  };
}
