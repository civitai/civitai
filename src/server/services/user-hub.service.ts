import { dbRead, dbWrite } from '~/server/db/client';
import { Prisma } from '@prisma/client';
import type {
  AddUserHubSourceInput,
  HubSourceExclusionInput,
  GetHubSourceSuggestionsInput,
  ResolveHubSourceInput,
  SetUserHubOrderInput,
  UpsertUserHubInput,
  UserHubSourceInput,
  UserHubSourceRefInput,
} from '~/server/schema/user-hub.schema';
import {
  HUB_COLLECTION_SOURCES_ENABLED,
  hubFeedFiltersSchema,
  hubLimits,
  hubSourceKey,
} from '~/server/schema/user-hub.schema';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
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
import { ImageSort, NsfwLevel } from '~/server/common/enums';
import { getUserCollectionPermissionsByIds } from '~/server/services/collection.service';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import type { CollectionMetadataSchema } from '~/server/schema/collection.schema';
import { getAllServerHosts } from '~/server/utils/server-domain';
import { parseCivitaiUrlSafe } from '~/utils/civitai-url';

// Everything a hub carries EXCEPT its owner. `getUserHubs` is `where: { userId }`,
// so the joined owner would always be the caller — a row the client already holds —
// and no consumer of the list reads it. Two round trips per rail render, for nothing.
const hubListSelect = {
  id: true,
  userId: true,
  name: true,
  index: true,
  sort: true,
  period: true,
  mediaTypes: true,
  availability: true,
  forcedBrowsingLevel: true,
  metadata: true,

  sources: {
    select: { id: true, type: true, targetId: true, alias: true, enabled: true, index: true },
    orderBy: { index: 'asc' },
  },
} as const;

// One hub, where the owner IS read: a hub arriving by a shared link says nothing
// about whose curation it is unless they come with it. Cosmetics included, like
// every other attribution surface — without them a creator's equipped badge is
// missing on their own hub and nothing in the types says why.
const hubSelect = {
  ...hubListSelect,
  user: { select: userWithCosmeticsSelect },
} as const;

type HubRow = {
  metadata: Prisma.JsonValue;
  userId: number;
  sources: { enabled: boolean }[];
};

export type HubViewer = { userId?: number; isModerator?: boolean };

/**
 * The single answer to "may this viewer open this hub", expressed as a `where`
 * fragment rather than a check after the fetch: an id the viewer cannot open is a
 * not-found, never a row plus a refusal.
 *
 * A moderator may open any hub — subtask 868kwp5kc, view only. Everyone else gets
 * their own hubs plus whatever is Public. There is no discovery surface, so Public
 * means "anyone holding the link", not "listed".
 */
export function hubViewerWhere({ userId, isModerator }: HubViewer) {
  if (isModerator) return {};
  return {
    OR: [...(userId ? [{ userId }] : []), { availability: Availability.Public }],
  };
}

/**
 * Whether the hub ROUTE stays dark for this viewer. Public hubs are spared the
 * `user-hubs` flag because a link unfurler fetches the page signed out: a 404 gives
 * it nothing to preview, where a 200 carries the meta tags. It buys the meta only —
 * the body still needs the flag, since the hub and its feed both arrive through
 * flag-gated tRPC reads.
 */
export function hubRouteIsDark({
  hubsEnabled,
  availability,
}: {
  hubsEnabled: boolean;
  availability: Availability;
}) {
  return !hubsEnabled && availability !== Availability.Public;
}

/**
 * Who may WRITE a hub. Deliberately not `hubViewerWhere`: Public grants reading to
 * anyone with the link and must never grant writing. Moderators may manage any hub —
 * Justin's call on 2026-08-25, which answers the question subtask 868kwp5kc had
 * parked. It covers the deliberate acts (rename, description, visibility, delete),
 * not the incidental ones: a moderator's source toggles stay session state, so
 * looking at a hub cannot quietly rewrite it.
 */
export function hubWriterWhere({ userId, isModerator }: HubViewer) {
  return isModerator ? {} : { userId };
}

function readMetadata(metadata: Prisma.JsonValue | undefined) {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : {};
}

// Three readers now — the app's own detail shape, the route's SSR meta, and the
// link-preview card — and the last two publish it off-site. One function so that
// sanitising or capping it later reaches all three rather than the one someone opens.
function readDescription(metadata: Prisma.JsonValue | undefined) {
  const description = readMetadata(metadata).description;
  return typeof description === 'string' ? description : null;
}

// `metadata` never leaves the service: callers get the fields it carries, so a key
// added to it later is not published to every client by default.
function toHubDetail<T extends HubRow>({ metadata, ...hub }: T, viewerId?: number) {
  const stored = readMetadata(metadata);
  const isOwner = !!viewerId && hub.userId === viewerId;
  return {
    ...hub,
    // What the client branches its whole chrome on. Computed here rather than
    // compared client-side, because the client's idea of who it is and the row the
    // server just authorised are two different facts.
    isOwner,
    // A source the owner switched off contributes nothing to the feed and is not
    // shown, so shipping it to a viewer publishes part of their curation for no
    // reason. The owner still gets the whole list, which is the one they edit.
    sources: isOwner ? hub.sources : hub.sources.filter((source) => source.enabled),
    description: readDescription(metadata),
    // Re-validated on the way out: what is on the row was written by an older
    // shape of this schema, and the feed refuses some combinations outright.
    filters: hubFeedFiltersSchema.catch({}).parse(stored.filters ?? {}),
  };
}

export type UserHubDetail = Awaited<ReturnType<typeof getUserHubs>>[number];

export async function getUserHubs({ userId }: { userId: number }) {
  const hubs = await dbRead.userHub.findMany({
    where: { userId },
    select: hubListSelect,
    // Alphabetical, not by `index` — subtask 868kwp5m9. `index` is still written by
    // `setUserHubOrder` and still what a hub is created with; nothing reads it for
    // display any more.
    orderBy: { name: 'asc' },
  });
  return hubs.map((hub) => toHubDetail(hub, userId));
}

// Scoped in the `where` rather than checked after the fetch, so a hub this viewer
// may not open is a not-found rather than a leak. Revoking `Public` therefore makes
// every link anyone was given 404 on the next read — subtask 868kwp5g8 — with no
// separate revocation list to keep in step.
export async function getUserHubById({ id, userId, isModerator }: { id: number } & HubViewer) {
  const hub = await dbRead.userHub.findFirst({
    where: { id, ...hubViewerWhere({ userId, isModerator }) },
    select: hubSelect,
  });
  if (!hub) throw throwNotFoundError('Hub not found');
  return toHubDetail(hub, userId);
}

/**
 * What the route needs before it renders: null when this viewer may not open the
 * hub, so a revoked link is a real HTTP 404 rather than a 200 carrying a not-found
 * component (subtask 868kwp5g8). The name comes back with it because the canonical
 * slug redirect needs it, and two facts off one primary-key read beats two reads.
 */
export async function getUserHubForRoute({ id, userId, isModerator }: { id: number } & HubViewer) {
  const hub = await dbRead.userHub.findFirst({
    where: { id, ...hubViewerWhere({ userId, isModerator }) },
    select: { id: true, name: true, availability: true, metadata: true },
  });
  if (!hub) return null;

  // The description rides along because the page's <Meta> has to render on the
  // SERVER: the hub itself arrives through a client query, so anything read off that
  // is absent from the HTML a link unfurler fetches.
  const { metadata, ...rest } = hub;
  return { ...rest, description: readDescription(metadata) };
}

/**
 * What the link-preview card renders. Public only, and scoped in the `where` like
 * every other hub read, so a private hub and an id that never existed are the same
 * answer — a card that resolved a private hub would publish its name to anyone who
 * guessed the id.
 */
export async function getHubCardData(id: number) {
  const hub = await dbRead.userHub.findFirst({
    where: { id, availability: Availability.Public },
    select: {
      name: true,
      metadata: true,
      user: { select: { username: true } },
      // Enabled only, because that is the number a visitor can see: `toHubDetail`
      // strips disabled sources for everyone but the owner, so counting all of them
      // advertises a hub as larger than the page it opens.
      _count: { select: { sources: { where: { enabled: true } }, followers: true } },
    },
  });
  if (!hub) return null;

  return {
    name: hub.name,
    description: readDescription(hub.metadata),
    username: hub.user.username,
    sourceCount: hub._count.sources,
    followerCount: hub._count.followers,
  };
}

export async function upsertUserHub({
  userId,
  isModerator,
  ...input
}: UpsertUserHubInput & { userId: number; isModerator?: boolean }) {
  const writable = hubWriterWhere({ userId, isModerator });
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

    // Through the WRITER, like every other read-then-write in this file: replica lag
    // lets a burst of creates overshoot the cap, and Duplicate makes creating a hub
    // one click.
    const count = await dbWrite.userHub.count({ where: { userId } });
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
      select: hubListSelect,
    });
    return toHubDetail(hub, userId);
  }

  // Read through the WRITER, not the replica: this is a read-modify-write of one
  // json column, and a replica lagging behind the previous save merges a stale
  // description back over a newer one.
  const existing = await dbWrite.userHub.findFirst({
    where: { id, ...writable },
    select: { id: true, userId: true, metadata: true },
  });
  if (!existing) throw throwNotFoundError('Hub not found');

  // The moderator line, ENFORCED here rather than only described. `hubWriterWhere`
  // opens the row to a moderator, and this mutation is how a source list and a
  // content cap are written — so without this a moderator could replace another
  // user's whole curation in one call, which is the incidental half the grant
  // deliberately excludes. The client never offers it; that is not a control.
  if (existing.userId !== userId && (sources || input.forcedBrowsingLevel !== undefined))
    throw throwAuthorizationError(
      'Only the owner can change the sources or the content level of a hub'
    );

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
      where: { id, ...writable },
      data: { ...data, ...(metadata ? { metadata } : {}) },
      select: hubListSelect,
    });
    return toHubDetail(hub, userId);
  }

  const updated = await dbWrite.$transaction(async (tx) => {
    await tx.userHubSource.deleteMany({ where: { hubId: id } });
    return tx.userHub.update({
      // Scoped on the write as well as in the SELECT above, not instead of it: a
      // check in a prior SELECT is a check that can disagree with the write.
      where: { id, ...writable },
      data: {
        ...data,
        ...(metadata ? { metadata } : {}),
        sources: { create: sources.map(({ id: _, ...source }) => source) },
      },
      select: hubListSelect,
    });
  });
  return toHubDetail(updated, userId);
}

export async function addUserHubSource({
  userId,
  hubId,
  ...source
}: AddUserHubSourceInput & { userId: number }) {
  // Read through the WRITER, like `upsertUserHub` above and for the same reason: the
  // duplicate check, the cap and the next index all come off this row, and a modal of
  // checkboxes invites a second write inside the replica's lag window.
  const hub = await dbWrite.userHub.findFirst({
    where: { id: hubId, userId },
    select: {
      id: true,
      sources: { select: { id: true, type: true, targetId: true, enabled: true, index: true } },
    },
  });
  if (!hub) throw throwNotFoundError('Hub not found');

  const existing = hub.sources.find(
    (s) => s.type === source.type && s.targetId === source.targetId
  );
  if (existing) {
    // A source the owner switched off is invisible to the feed — `resolveHubSources`
    // selects enabled rows only — so reporting "already there" and leaving it off is a
    // success message for nothing happening.
    if (existing.enabled) return { hubId, added: false };

    // Owner-scoped on the write as well as in the read above, per the argument this
    // file makes for `removeUserHubSource`: id-addressing is safe only while a source
    // row cannot change hubs, and that is not a property anything enforces.
    await dbWrite.userHubSource.updateMany({
      where: { id: existing.id, hub: { userId } },
      data: { enabled: true },
    });
    return { hubId, added: true };
  }

  if (hub.sources.length >= hubLimits.sourcesPerHub)
    throw throwBadRequestError(`A hub can hold at most ${hubLimits.sourcesPerHub} sources`);

  await assertHubSourcesUsable({ sources: [{ ...source, enabled: true, index: 0 }], userId });

  try {
    await dbWrite.userHubSource.create({
      data: {
        hubId,
        type: source.type,
        targetId: source.targetId,
        alias: source.alias ?? null,
        index: hub.sources.reduce((max, s) => Math.max(max, s.index + 1), 0),
      },
    });
  } catch (error) {
    // Two writes genuinely in flight. NOT `isPrismaUniqueViolation`, whose own doc
    // restricts it to sites where P2002 can only mean the row we wanted: `id` is a
    // unique key here too, so a sequence behind the table collides while saying nothing
    // about this source, and swallowing that would report a write that never happened.
    if (!isDuplicateSourceError(error)) throw error;
    return { hubId, added: false };
  }

  return { hubId, added: true };
}

function isDuplicateSourceError(error: unknown) {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002')
    return false;

  const target = error.meta?.target;
  return Array.isArray(target) && target.includes('targetId');
}

export async function removeUserHubSource({
  userId,
  hubId,
  type,
  targetId,
}: UserHubSourceRefInput & { userId: number }) {
  const hub = await dbWrite.userHub.findFirst({
    where: { id: hubId, userId },
    select: { id: true },
  });
  if (!hub) throw throwNotFoundError('Hub not found');

  // Owner-scoped on the DELETE as well as in the read above, per the argument this file
  // already makes for `upsert`: a check in a prior SELECT is a check that can disagree
  // with the write the moment `UserHub.userId` can move.
  const { count } = await dbWrite.userHubSource.deleteMany({
    where: { hubId, type, targetId, hub: { userId } },
  });
  return { hubId, removed: count > 0 };
}

export async function deleteUserHub({
  id,
  userId,
  isModerator,
}: { id: number; userId: number } & HubViewer) {
  const { count } = await dbWrite.userHub.deleteMany({
    where: { id, ...hubWriterWhere({ userId, isModerator }) },
  });
  if (!count) throw throwNotFoundError('Hub not found');
}

/**
 * The hubs this viewer follows, in the same shape and the same order the owned list
 * comes back in.
 *
 * Filtered through `hubViewerWhere` on the READ, not merely at follow time. An owner
 * flipping a hub back to Private has to make it vanish from every follower's list
 * immediately, and there is no revocation pass to delete follow rows — the same
 * argument `getUserHubById` makes for links (subtask 868kwp5g8). The row stays, and
 * starts counting again if the hub is made Public a second time.
 *
 * `isModerator` is deliberately NOT threaded through: a moderator's reach over any
 * hub is a view privilege, and letting it decide this list would put private hubs in
 * a personal sidebar that everyone else's revocation empties.
 */
export async function getFollowedHubs({ userId }: { userId: number }) {
  const follows = await dbRead.userHubFollow.findMany({
    where: { userId, hub: hubViewerWhere({ userId }) },
    // `hubListSelect`, not `hubSelect`: the rail renders a name and a source count,
    // and joining the owner costs two extra round trips per render for a field
    // nothing reads.
    select: { hub: { select: hubListSelect } },
    orderBy: { hub: { name: 'asc' } },
    take: hubLimits.followedHubs,
  });
  return follows.map((follow) => toHubDetail(follow.hub, userId));
}

export async function followUserHub({ hubId, userId }: { hubId: number; userId: number }) {
  // Through the WRITER, and scoped by the same fragment every hub read uses: a hub
  // this viewer cannot open must be a not-found here, never a follow row pointing at
  // something they will never be shown.
  const hub = await dbWrite.userHub.findFirst({
    where: { id: hubId, ...hubViewerWhere({ userId }) },
    select: { id: true, userId: true },
  });
  if (!hub) throw throwNotFoundError('Hub not found');

  // Your own hubs are already the list above this one in the rail.
  if (hub.userId === userId) throw throwBadRequestError('This is your own hub');

  const count = await dbWrite.userHubFollow.count({ where: { userId } });
  if (count >= hubLimits.followedHubs)
    throw throwBadRequestError(`You can follow at most ${hubLimits.followedHubs} hubs`);

  // Idempotent: the button is rendered from a cached list, so a second click inside
  // the invalidate window must not be an error.
  await dbWrite.userHubFollow.upsert({
    where: { userId_hubId: { userId, hubId } },
    create: { userId, hubId },
    update: {},
  });
  return { hubId, following: true };
}

export async function unfollowUserHub({ hubId, userId }: { hubId: number; userId: number }) {
  // Scoped to the caller's own row on the DELETE itself, like every other write in
  // this file — `deleteMany`, not a lookup followed by a delete by id.
  const { count } = await dbWrite.userHubFollow.deleteMany({ where: { userId, hubId } });
  return { hubId, following: false, removed: count > 0 };
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
  /** The hub's stored browsing-level cap. 0 means the hub imposes none. */
  forcedBrowsingLevel: number;
};

// Resolves a hub to the id sets its feed filter is built from. Returns null when
// the hub does not exist or this viewer may not open it — callers must treat that
// as "return nothing", never as "no filter", the same way `newCreators` does with
// an unpopulated board.
export async function resolveHubSources({
  hubId,
  userId,
  isModerator,
  excludedSources,
}: {
  hubId: number;
  excludedSources?: HubSourceExclusionInput[];
} & HubViewer): Promise<ResolvedHubSources | null> {
  const hub = await dbRead.userHub.findFirst({
    where: { id: hubId, ...hubViewerWhere({ userId, isModerator }) },
    select: {
      forcedBrowsingLevel: true,
      sources: { where: { enabled: true }, select: { type: true, targetId: true } },
    },
  });
  if (!hub) return null;

  // A viewer of someone else's hub toggles sources off for their own session, and
  // that never reaches the owner's row — subtask 868kwp5gt. Applied here rather
  // than in the filter builders because this is the one place the id sets exist,
  // and because subtracting can only ever NARROW the feed: a forged exclusion
  // removes content from the forger, and can add none.
  const excluded = new Set((excludedSources ?? []).map(hubSourceKey));
  const sources = excluded.size
    ? hub.sources.filter((s) => !excluded.has(hubSourceKey(s)))
    : hub.sources;

  const byType = (type: UserHubSourceType) =>
    sources.filter((s) => s.type === type).map((s) => s.targetId);

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
    forcedBrowsingLevel: hub.forcedBrowsingLevel,
  };
}

/**
 * The hub's own content cap, intersected with whatever the viewer was already
 * allowed. Returns 0 for "this viewer can see nothing in this hub", which callers
 * must serve as an empty page rather than as an uncapped one.
 *
 * Extracted because three filter builders apply it — the two Meilisearch paths and
 * BitDex — and a cap missing from one of them is a hub quietly serving past its
 * own setting on whichever backend that request happened to take.
 */
export function hubBrowsingLevel(browsingLevel: number | undefined, sources: ResolvedHubSources) {
  if (!sources.forcedBrowsingLevel) return browsingLevel;
  // An absent level means PG here, exactly as it does in the level block each
  // caller runs next. Defaulting to "every level" instead would let a hub's cap
  // WIDEN a request that asked for no level at all, which is the opposite of what
  // a cap is for.
  return (browsingLevel || NsfwLevel.PG) & sources.forcedBrowsingLevel;
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
  isModerator,
}: GetHubSourceSuggestionsInput & { userId: number; isModerator?: boolean }) {
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
        // Unreachable while the switch above is off, and here so that flipping it
        // does not reopen the models divergence on this arm: a VIEW contributor on
        // a private collection is someone both the link path and the write path
        // refuse.
        read: { not: CollectionReadConfiguration.Private },
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
      // A bookmark or a bell outlives the model going private or back to draft, so
      // without this the picker offers by name what `resolveSource` refuses by link.
      ...visibleModel(userId, isModerator),
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
