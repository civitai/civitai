import { dbRead, dbWrite } from '~/server/db/client';
import { Prisma } from '@prisma/client';
import type {
  SetUserHubOrderInput,
  UpsertUserHubInput,
  UserHubSourceInput,
} from '~/server/schema/user-hub.schema';
import { HUB_COLLECTION_SOURCES_ENABLED, hubLimits } from '~/server/schema/user-hub.schema';
import { throwBadRequestError, throwNotFoundError } from '~/server/utils/errorHandling';
import {
  CollectionReadConfiguration,
  MetricTimeframe,
  UserHubSourceType,
} from '~/shared/utils/prisma/enums';
import { ImageSort } from '~/server/common/enums';
import { getUserCollectionPermissionsByIds } from '~/server/services/collection.service';
import type { CollectionMetadataSchema } from '~/server/schema/collection.schema';

const hubSelect = {
  id: true,
  name: true,
  index: true,
  sort: true,
  period: true,
  mediaTypes: true,
  sources: {
    select: { id: true, type: true, targetId: true, alias: true, enabled: true, index: true },
    orderBy: { index: 'asc' },
  },
} as const;

export type UserHubDetail = Awaited<ReturnType<typeof getUserHubs>>[number];

export async function getUserHubs({ userId }: { userId: number }) {
  return dbRead.userHub.findMany({
    where: { userId },
    select: hubSelect,
    orderBy: { index: 'asc' },
  });
}

// Every read is scoped by userId rather than checked after the fetch, so an id
// belonging to someone else is a not-found rather than a leak.
export async function getUserHubById({ id, userId }: { id: number; userId: number }) {
  const hub = await dbRead.userHub.findFirst({ where: { id, userId }, select: hubSelect });
  if (!hub) throw throwNotFoundError('Hub not found');
  return hub;
}

export async function upsertUserHub({ userId, ...input }: UpsertUserHubInput & { userId: number }) {
  const { id, sources, ...data } = input;

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
    const count = await dbRead.userHub.count({ where: { userId } });
    if (count >= hubLimits.hubsPerUser)
      throw throwBadRequestError(`You can have at most ${hubLimits.hubsPerUser} hubs`);

    return dbWrite.userHub.create({
      data: {
        ...data,
        sort: data.sort ?? ImageSort.Newest,
        period: data.period ?? MetricTimeframe.AllTime,
        mediaTypes: data.mediaTypes ?? [],
        userId,
        index: count,
        sources: { create: (sources ?? []).map(({ id: _, ...source }) => source) },
      },
      select: hubSelect,
    });
  }

  const existing = await dbRead.userHub.findFirst({ where: { id, userId }, select: { id: true } });
  if (!existing) throw throwNotFoundError('Hub not found');

  if (!sources) return dbWrite.userHub.update({ where: { id }, data, select: hubSelect });

  return dbWrite.$transaction(async (tx) => {
    await tx.userHubSource.deleteMany({ where: { hubId: id } });
    return tx.userHub.update({
      where: { id },
      data: { ...data, sources: { create: sources.map(({ id: _, ...source }) => source) } },
      select: hubSelect,
    });
  });
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
    ids.map((id, index) => dbWrite.userHub.update({ where: { id }, data: { index } }))
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

  // Returns a POSITIONAL array aligned with `ids`, not an id-keyed map. Indexing
  // it by collection id reads an unrelated slot — almost always undefined, which
  // fails closed and so hid the fact that the permission check never ran.
  const permissionList = await getUserCollectionPermissionsByIds({ ids: collectionIds, userId });
  const permissions = new Map(collectionIds.map((id, index) => [id, permissionList[index]]));

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
