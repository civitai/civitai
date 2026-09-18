import { dbRead, dbWrite } from '~/server/db/client';
import { throwOnBlockedUserContent } from '~/server/services/blocklist.service';
import { getBasicDataForUsers, getProfilePicturesForUsers } from '~/server/services/user.service';
import { decodeHubId, encodeHubId } from '~/server/utils/hub-id';
import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import type {
  AddUserHubSourceInput,
  GetHubSourceCandidatesInput,
  HubSourceExclusionInput,
  HubSourceTargetInput,
  GetHubSourceScopeInput,
  HubSourceScope,
  HubTemplate,
  ResolveHubSourceInput,
  SetUserHubOrderInput,
  UpsertUserHubInput,
  UserHubSourceInput,
  UserHubSourceRefInput,
} from '~/server/schema/user-hub.schema';
import {
  HUB_COLLECTION_SOURCES_ENABLED,
  HUB_TAG_SOURCE_FILTER,
  hubFeedFiltersSchema,
  hubLimits,
  hubSourceKey,
  hubSourceScopeSchema,
  hubTagGroupKey,
} from '~/server/schema/user-hub.schema';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import {
  Availability,
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
import { getReplacedTagIds } from '~/server/services/system-cache';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import type { ProfileImage } from '~/server/selectors/image.selector';
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
    select: {
      id: true,
      type: true,
      targetId: true,
      alias: true,
      enabled: true,
      exclude: true,
      index: true,
      groupKey: true,
    },
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
  id: number;
  metadata: Prisma.JsonValue;
  userId: number;
  sources: { enabled: boolean; exclude: boolean }[];
};

export type HubViewer = { userId?: number; isModerator?: boolean };

/**
 * The single answer to "may this viewer open this hub", expressed as a `where`
 * fragment rather than a check after the fetch: an id the viewer cannot open is a
 * not-found, never a row plus a refusal.
 *
 * A moderator may open any hub — subtask 868kwp5kc, view only. Everyone else gets
 * their own hubs plus whatever is Public.
 *
 * 🔴 Public means FULLY public — Justin's call, 2026-08-27, superseding an earlier
 * reading of "anyone holding the link, not listed". `UserHub.id` is a dense
 * autoincrement and the link-preview card at `/api/og?type=hub&id=N` answers
 * unauthenticated, so every public hub's name, description, owner and counts are
 * walkable by id whether or not a discovery surface exists. That is accepted, not
 * overlooked: do not add a check here on the theory that Public is semi-private.
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
    // The id the CLIENT builds URLs from. Encoded here rather than there because the
    // salt is a server env var — shipping it to the browser would make the encoding
    // decorative. `hubUrl` takes this, never `id`.
    key: encodeHubId(hub.id),
    // What the client branches its whole chrome on. Computed here rather than
    // compared client-side, because the client's idea of who it is and the row the
    // server just authorised are two different facts.
    isOwner,
    // A source the owner switched off contributes nothing to the feed and is not
    // shown, so shipping it to a viewer publishes part of their curation for no
    // reason. The owner still gets the whole list, which is the one they edit.
    //
    // 🔴 Exclusions are withheld from everyone but the owner, and that is a stronger
    // rule than the one above rather than the same one. A positive source says "I
    // like this creator"; a negative one says "keep this creator away from me", about
    // a named person, on a hub anyone with the link can open. Publishing it would
    // make every public hub a list of who its owner refuses.
    sources: isOwner
      ? hub.sources
      : hub.sources.filter((source) => source.enabled && !source.exclude),
    // The count without the identities. A viewer who is shown nothing cannot tell a
    // hub that filters from one that does not — and "Duplicate this hub" copies only
    // what the payload carries, so a copy silently serves content the original
    // refuses. A bare number says the feed is narrowed without naming anyone.
    excludedCount: hub.sources.filter((source) => source.enabled && source.exclude).length,
    description: readDescription(metadata),
    // Re-validated on the way out: what is on the row was written by an older
    // shape of this schema, and the feed refuses some combinations outright.
    filters: hubFeedFiltersSchema.catch({}).parse(stored.filters ?? {}),
  };
}

export type UserHubDetail = Awaited<ReturnType<typeof getUserHubById>>;
export type UserHubSummary = Awaited<ReturnType<typeof getUserHubs>>[number];

// Everything but the sources. A nav row needs how MANY of each kind a hub holds, not
// which ones — and the full lists are the whole payload: 20 hubs of 50 sources is a
// thousand rows with their aliases on every render of every hub page.
const hubSummarySelect = {
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
} as const;

type HubSourceCountRow = {
  type: UserHubSourceType;
  enabled: boolean;
  exclude: boolean;
  count: number;
};

async function hubSourceCounts(hubIds: number[]) {
  const counts = new Map<number, HubSourceCountRow[]>();
  if (!hubIds.length) return counts;

  const rows = await dbRead.userHubSource.groupBy({
    by: ['hubId', 'type', 'enabled', 'exclude'],
    where: { hubId: { in: hubIds } },
    _count: { _all: true },
  });

  for (const row of rows) {
    const held = counts.get(row.hubId) ?? [];
    held.push({
      type: row.type,
      enabled: row.enabled,
      exclude: row.exclude,
      count: row._count._all,
    });
    counts.set(row.hubId, held);
  }
  return counts;
}

/**
 * The list row. Carries the same visibility rule as `toHubDetail` — a non-owner is
 * told about the sources that fill the feed and nothing else — expressed over counts
 * rather than rows, since that is all this shape ships.
 */
function toHubSummary<T extends { id: number; userId: number; metadata: Prisma.JsonValue }>(
  { metadata, ...hub }: T,
  counts: HubSourceCountRow[] = [],
  viewerId?: number
) {
  const stored = readMetadata(metadata);
  const isOwner = !!viewerId && hub.userId === viewerId;
  const sum = (rows: HubSourceCountRow[]) => rows.reduce((total, row) => total + row.count, 0);

  const filling = counts.filter((row) => row.enabled && !row.exclude);
  const sourceCounts = filling.reduce<Partial<Record<UserHubSourceType, number>>>((acc, row) => {
    acc[row.type] = (acc[row.type] ?? 0) + row.count;
    return acc;
  }, {});

  return {
    ...hub,
    key: encodeHubId(hub.id),
    isOwner,
    sourceCounts,
    // What the source cap is measured against, so it counts a switched-off source the
    // way `addUserHubSource` does. A non-owner is shown only what fills the feed,
    // matching the list they would have been given before.
    sourceCount: isOwner ? sum(counts.filter((row) => !row.exclude)) : sum(filling),
    excludedCount: sum(counts.filter((row) => row.enabled && row.exclude)),
    description: readDescription(metadata),
    filters: hubFeedFiltersSchema.catch({}).parse(stored.filters ?? {}),
  };
}

export async function getUserHubs({ userId }: { userId: number }) {
  const hubs = await dbRead.userHub.findMany({
    where: { userId },
    select: hubSummarySelect,
    // Alphabetical, not by `index` — subtask 868kwp5m9. `index` is still written by
    // `setUserHubOrder` and still what a hub is created with; nothing reads it for
    // display any more.
    orderBy: { name: 'asc' },
  });

  const counts = await hubSourceCounts(hubs.map((hub) => hub.id));
  return hubs.map((hub) => toHubSummary(hub, counts.get(hub.id), userId));
}

// Scoped in the `where` rather than checked after the fetch, so a hub this viewer
// may not open is a not-found rather than a leak. Revoking `Public` therefore makes
// every link anyone was given 404 on the next read — subtask 868kwp5g8 — with no
// separate revocation list to keep in step.
/**
 * The public read, addressed the way the URL addresses it. A key that does not decode
 * is the same not-found as a hub this viewer may not open — including a bare integer,
 * which is what the pre-encoding links carried.
 */
export async function getUserHubByKey({ key, ...viewer }: { key: string } & HubViewer) {
  const id = decodeHubId(key);
  if (!id) throw throwNotFoundError('Hub not found');
  return getUserHubById({ id, ...viewer });
}

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
  return { ...rest, key: encodeHubId(hub.id), description: readDescription(metadata) };
}

/**
 * What the link-preview card renders. Public only, and scoped in the `where` like
 * every other hub read, so a private hub and an id that never existed are the same
 * answer — a card that resolved a private hub would publish its name to anyone who
 * guessed the id.
 */
export async function getHubCardData(id: number) {
  const hub = await dbRead.userHub.findFirst({
    // Through the shared guard with an EMPTY viewer, not a hand-written Public check:
    // this endpoint has no session, so no-viewer is the exact case, and the card is
    // the one read that publishes off-site and CDN-caches. A rule added to
    // `hubViewerWhere` later — a soft delete, a hub-level ban — must not miss it.
    where: { id, ...hubViewerWhere({}) },
    select: {
      name: true,
      metadata: true,
      user: { select: { username: true } },
      // Enabled and POSITIVE only, because that is the number a visitor can see:
      // `toHubDetail` strips disabled sources — and every exclusion — for everyone but
      // the owner. Counting all of them advertises a hub as larger than the page it
      // opens, and counting the exclusions publishes by subtraction the one number the
      // owner's keep-out list is withheld to keep private. This card answers
      // unauthenticated, at /api/og?type=hub.
      _count: {
        select: { sources: { where: { enabled: true, exclude: false } }, followers: true },
      },
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
  const { id, sources: submitted, description, filters, ...data } = input;

  // The hub's OWN text — the two fields this caller wrote — refuses the save.
  await throwOnBlockedUserContent([data.name, description], { isModerator, surface: 'userHub' });

  // Aliases are scanned too, but they lose the LABEL rather than the save. They are
  // other people's usernames and stored model names, arriving by the dozen from a
  // starting point or a picker, and a hub is now filled before it is saved: one
  // refusal used to take the whole curated list with it, naming neither the offender
  // nor a way to drop it. Nulling stores nothing blocked — the identity is
  // `targetId`, the alias is decoration — so the guard holds and the save survives.
  const sources =
    submitted && (await withoutBlockedAliases(submitted, { isModerator, surface: 'userHub' }));

  if (sources) {
    const duplicate = new Set<string>();
    for (const source of sources) {
      const key = `${source.type}:${source.targetId}`;
      if (duplicate.has(key)) throw throwBadRequestError('A source was added twice');
      duplicate.add(key);
    }

    assertSourceCounts(sources);
    await assertHubSourcesUsable({ sources, userId });
    await assertExcludedModelsFit(excludedModelIds(sources));
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

const excludedModelIds = (
  sources: { type: UserHubSourceType; targetId: number; exclude?: boolean }[]
) => sources.filter((s) => s.exclude && s.type === UserHubSourceType.Model).map((s) => s.targetId);

// Each kind against its own cap. Counted here rather than on the zod array, which
// sees one list and cannot say which half overran it.
function assertSourceCounts(sources: UserHubSourceInput[]) {
  const excluded = sources.filter((source) => source.exclude).length;
  if (sources.length - excluded > hubLimits.sourcesPerHub)
    throw throwBadRequestError(`A hub can hold at most ${hubLimits.sourcesPerHub} sources`);
  if (excluded > hubLimits.exclusionsPerHub)
    throw throwBadRequestError(`A hub can exclude at most ${hubLimits.exclusionsPerHub} sources`);
}

/**
 * Everything one added-or-flipped source has to satisfy: the cap on the side it lands
 * on, the rules for what may be a source at all, and the excluded-model expansion
 * budget over the set the hub would hold afterwards.
 *
 * `ignoreId` is the row being flipped — it is leaving the other side, so counting it
 * against the destination would charge the hub twice for one target.
 */
async function assertHubSourceFits({
  hub,
  source,
  userId,
  ignoreId,
}: {
  hub: { sources: { id: number; type: UserHubSourceType; targetId: number; exclude: boolean }[] };
  source: { type: UserHubSourceType; targetId: number; exclude: boolean; alias?: string | null };
  userId: number;
  ignoreId?: number;
}) {
  const held = hub.sources.filter((s) => s.exclude === source.exclude && s.id !== ignoreId).length;
  if (source.exclude) {
    if (held >= hubLimits.exclusionsPerHub)
      throw throwBadRequestError(`A hub can exclude at most ${hubLimits.exclusionsPerHub} sources`);
  } else if (held >= hubLimits.sourcesPerHub)
    throw throwBadRequestError(`A hub can hold at most ${hubLimits.sourcesPerHub} sources`);

  await assertHubSourcesUsable({
    sources: [{ ...source, enabled: true, index: 0 }],
    userId,
  });

  await assertExcludedModelsFit(
    excludedModelIds([...hub.sources.filter((s) => s.id !== ignoreId), source])
  );
}

export async function addUserHubSource({
  userId,
  hubId,
  ...source
}: AddUserHubSourceInput & { userId: number }) {
  await throwOnBlockedUserContent(source.alias, { surface: 'userHub' });

  // Read through the WRITER, like `upsertUserHub` above and for the same reason: the
  // duplicate check, the cap and the next index all come off this row, and a modal of
  // checkboxes invites a second write inside the replica's lag window.
  const hub = await dbWrite.userHub.findFirst({
    where: { id: hubId, userId },
    select: {
      id: true,
      sources: {
        select: { id: true, type: true, targetId: true, enabled: true, exclude: true, index: true },
      },
    },
  });
  if (!hub) throw throwNotFoundError('Hub not found');

  const existing = hub.sources.find(
    (s) => s.type === source.type && s.targetId === source.targetId
  );
  if (existing) {
    // A source the owner switched off is invisible to the feed — `resolveHubSources`
    // selects enabled rows only — so reporting "already there" and leaving it off is a
    // success message for nothing happening. Adding the SAME target on the other side
    // is the same story: the unique key holds one row per target, so asking to exclude
    // something the hub collects flips it rather than failing.
    if (existing.enabled && existing.exclude === source.exclude) return { hubId, added: false };

    // 🔴 A flip crosses between the two lists, so it faces the DESTINATION's checks —
    // its cap, and the same usability rules a create gets. Returning here without them
    // made this branch a door around both: fifty sources flipped one at a time put
    // fifty exclusions on a hub whose stated limit is twenty, and since flipping also
    // empties the positive side, the cycle repeated without bound. That matters beyond
    // the number, because the exclusion expansion deliberately never truncates.
    await assertHubSourceFits({ hub, source, userId, ignoreId: existing.id });

    // Owner-scoped on the write as well as in the read above, per the argument this
    // file makes for `removeUserHubSource`: id-addressing is safe only while a source
    // row cannot change hubs, and that is not a property anything enforces.
    await dbWrite.userHubSource.updateMany({
      where: { id: existing.id, hub: { userId } },
      data: { enabled: true, exclude: source.exclude },
    });
    return { hubId, added: true };
  }

  await assertHubSourceFits({ hub, source, userId });

  try {
    await dbWrite.userHubSource.create({
      data: {
        hubId,
        type: source.type,
        targetId: source.targetId,
        alias: source.alias ?? null,
        exclude: source.exclude,
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
    // The summary shape, not the detail one: the rail renders a name and what the hub
    // holds, and joining the owner — or the sources themselves — costs a payload
    // nothing on this surface reads.
    select: { hub: { select: hubSummarySelect } },
    orderBy: { hub: { name: 'asc' } },
    take: hubLimits.followedHubs,
  });

  const counts = await hubSourceCounts(follows.map((follow) => follow.hub.id));
  return follows.map((follow) => toHubSummary(follow.hub, counts.get(follow.hub.id), userId));
}

/**
 * Where one target already sits across the caller's own hubs. The "add to hub" modal
 * used to derive this from every hub's full source list; it needs three facts per hub
 * and this ships exactly those.
 *
 * `exclude` is the one that cannot be dropped: a hub that keeps this target OUT must
 * render locked rather than unticked, or ticking it deletes the owner's keep-out from
 * a modal that never showed the exclusion existed.
 */
export async function getHubSourceState({
  type,
  targetId,
  userId,
}: HubSourceTargetInput & { userId: number }) {
  return dbRead.userHubSource.findMany({
    where: { type, targetId, hub: { userId } },
    select: { hubId: true, enabled: true, exclude: true },
  });
}

const hubTemplateNames: Record<HubTemplate, string> = {
  'my-models': 'Images on my models',
  following: 'Creators I follow',
  bookmarks: 'Models I bookmarked',
};

/**
 * What a template gathers. Capped at `sourcesPerHub` here rather than left to
 * `assertSourceCounts`, because overrunning the cap is the expected case for the
 * users these templates are for — a prolific creator gets their newest 50 models and
 * a hub, not a refusal.
 */
async function hubTemplateSources({
  template,
  userId,
  isModerator,
}: {
  template: HubTemplate;
  userId: number;
  isModerator?: boolean;
}): Promise<UserHubSourceInput[]> {
  if (template === 'my-models') {
    const models = await dbRead.model.findMany({
      where: { userId, status: ModelStatus.Published, deletedAt: null },
      select: { id: true, name: true },
      orderBy: { createdAt: 'desc' },
      take: hubLimits.sourcesPerHub,
    });
    return models.map((model, index) => ({
      type: UserHubSourceType.Model,
      targetId: model.id,
      alias: model.name,
      enabled: true,
      exclude: false,
      index,
    }));
  }

  if (template === 'bookmarks') {
    // Same flag as the Bookmarked tab reads with, so "Add 50" collects what the rows
    // above it are showing.
    const models = await bookmarkedModels({
      userId,
      isModerator,
      take: hubLimits.sourcesPerHub,
    });
    return models.map((model, index) => ({
      type: UserHubSourceType.Model,
      targetId: model.id,
      alias: model.name,
      enabled: true,
      exclude: false,
      index,
    }));
  }

  // Read wider than the cap, because the deleted accounts are dropped AFTER this
  // window: at exactly the cap, 50 dead follows report "you are not following
  // anyone" to someone who follows hundreds.
  const follows = await dbRead.userEngagement.findMany({
    where: { userId, type: UserEngagementType.Follow },
    select: { targetUserId: true },
    orderBy: { createdAt: 'desc' },
    take: hubLimits.sourcesPerHub * 3,
  });

  const users = await dbRead.user.findMany({
    where: { id: { in: follows.map((follow) => follow.targetUserId) }, deletedAt: null },
    select: { id: true, username: true },
  });
  const byId = new Map(users.map((user) => [user.id, user.username]));

  return follows
    .map((follow) => ({ id: follow.targetUserId, username: byId.get(follow.targetUserId) }))
    .filter((user): user is { id: number; username: string } => !!user.username)
    .slice(0, hubLimits.sourcesPerHub)
    .map((user, index) => ({
      type: UserHubSourceType.User,
      targetId: user.id,
      alias: user.username,
      enabled: true,
      exclude: false,
      index,
    }));
}

/**
 * Drops the sources whose alias the content scan refuses, rather than letting one
 * refuse the whole template.
 *
 * A template's aliases are OTHER people's usernames and the caller's stored model
 * names — text this user did not write here and cannot edit from this screen. Passed
 * straight to `upsertUserHub`, one match refuses the create outright, and the message
 * names neither which of 50 follows caused it nor any way to drop it.
 *
 * Scanned as a batch first because that is the normal answer; the per-alias pass runs
 * only to find the offenders. `userHubTemplate` rather than `userHub` so the staged
 * enforcement rollout can tell text a user typed from text a template gathered.
 */
async function withoutBlockedAliases(
  sources: UserHubSourceInput[],
  { isModerator, surface }: { isModerator?: boolean; surface: string }
) {
  const options = { isModerator, surface };
  try {
    await throwOnBlockedUserContent(
      sources.map((source) => source.alias),
      options
    );
    return sources;
  } catch (error) {
    if (!isBlockedContentError(error)) throw error;

    const scrubbed: UserHubSourceInput[] = [];
    for (const source of sources) {
      try {
        await throwOnBlockedUserContent(source.alias, options);
        scrubbed.push(source);
      } catch (perAlias) {
        if (!isBlockedContentError(perAlias)) throw perAlias;
        // The source stays — the person chose it — but its label does not. It falls
        // back to the target id, which is unlovely and vanishingly rare.
        scrubbed.push({ ...source, alias: null });
      }
    }
    return scrubbed;
  }
}

/**
 * Did the scan REFUSE this text, or did it fail to run?
 *
 * 🔴 The difference is the whole guard. `getBlocklistDTO` reads Redis and the replica
 * unguarded, so a blip throws from inside the scan — and a bare `catch` reads that as
 * "blocked", which would strip the label off every source on the list and report
 * success. A refusal is a BAD_REQUEST raised by the scan itself; anything else is
 * infrastructure and belongs to the caller.
 */
function isBlockedContentError(error: unknown) {
  return error instanceof TRPCError && error.code === 'BAD_REQUEST';
}

/**
 * What a starting point would put in a hub: the sources, and how many there were to
 * choose from. It creates NOTHING — the modal opens holding these and the ordinary
 * save path writes them, so nobody gets a hub they have not seen.
 *
 * `total` is the count before the cap, which is what lets the editor say "your 50
 * most recent follows — 518 more did not fit". That shortfall reaches nobody today.
 */
export async function getHubSourceCandidates({
  template,
  userId,
  isModerator,
}: GetHubSourceCandidatesInput & { userId: number; isModerator?: boolean }) {
  const [gathered, total] = await Promise.all([
    hubTemplateSources({ template, userId, isModerator }),
    countHubTemplateCandidates({ template, userId }),
  ]);

  return {
    name: hubTemplateNames[template],
    sources: await withoutBlockedAliases(gathered, { surface: 'userHubTemplate' }),
    total,
  };
}

// Counted apart from the gather, which stops at the cap: the two numbers together are
// the point — what fits, and what there was.
async function countHubTemplateCandidates({
  template,
  userId,
}: GetHubSourceCandidatesInput & { userId: number }) {
  if (template === 'my-models')
    return dbRead.model.count({
      where: { userId, status: ModelStatus.Published, deletedAt: null },
    });

  if (template === 'bookmarks') return bookmarkedModelIds(userId).then((ids) => ids.length);

  return dbRead.userEngagement.count({ where: { userId, type: UserEngagementType.Follow } });
}

/**
 * Models this viewer kept but did not make: the bookmark collection and the bell,
 * which the "favourite" button sets together. Their OWN models are excluded — those
 * are their own group, and a creator seeing their catalogue twice was the complaint.
 */
/**
 * 🔴 BOUNDED, and the bound is load-bearing. Both arms were unbounded, and measured on
 * the prod replica 2026-09-18 the heaviest account holds 257,115 bell rows and 264,730
 * bookmark rows: one call was ~390ms and ~1.3GB of buffer traffic, half a million ints
 * over the wire, deduped on the request thread. The distribution is p50 2-3, p90 44-58,
 * p99 ~800, so the window below is exact for all but a handful of accounts — past it
 * the count reads as a floor rather than a total, which is the right trade for a
 * picker that can only add 50 of them.
 */
const BOOKMARK_WINDOW = 2000;

async function bookmarkedModelIds(userId: number) {
  const bookmarkCollection = await dbRead.collection.findFirst({
    where: { userId, type: CollectionType.Model, mode: CollectionMode.Bookmark },
    select: { id: true },
  });

  const [engaged, bookmarked] = await Promise.all([
    dbRead.modelEngagement.findMany({
      where: { userId, type: ModelEngagementType.Notify },
      select: { modelId: true },
      orderBy: { createdAt: 'desc' },
      take: BOOKMARK_WINDOW,
    }),
    bookmarkCollection
      ? dbRead.collectionItem.findMany({
          where: { collectionId: bookmarkCollection.id, modelId: { not: null } },
          select: { modelId: true },
          orderBy: { id: 'desc' },
          take: BOOKMARK_WINDOW,
        })
      : Promise.resolve([]),
  ]);

  return [
    ...new Set([
      ...engaged.map((row) => row.modelId),
      ...bookmarked.flatMap((row) => (row.modelId ? [row.modelId] : [])),
    ]),
  ];
}

async function bookmarkedModels({
  userId,
  take,
  term,
  isModerator,
}: {
  userId: number;
  take: number;
  term?: string;
  isModerator?: boolean;
}) {
  return bookmarkedModelsByIds({
    ids: await bookmarkedModelIds(userId),
    userId,
    term,
    take,
    isModerator,
  });
}

async function bookmarkedModelsByIds({
  ids,
  userId,
  take,
  term,
  isModerator,
}: {
  ids: number[];
  userId: number;
  take: number;
  term?: string;
  isModerator?: boolean;
}) {
  if (!ids.length) return [];

  const models = await dbRead.model.findMany({
    // A bookmark or a bell outlives the model going private or back to draft, and the
    // owner's own models belong to the group above this one.
    //
    // `isModerator` because this list and the paste-a-link path have to answer the
    // same question the same way: a moderator who can resolve a model by URL but
    // cannot see it in their own bookmarks is reading one rule from two places. The
    // write path gates neither — it validates tags and collections only — so this is
    // the browse half of that pair, not a permission.
    where: {
      id: { in: ids },
      userId: { not: userId },
      ...visibleModel(userId, isModerator),
      ...(term ? { name: { contains: term, mode: 'insensitive' as const } } : {}),
    },
    select: modelRowSelect,
    take,
  });

  const position = new Map(ids.map((id, index) => [id, index]));
  return models.sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));
}

// `ModelMetric` is keyed on `modelId` alone in the generated client — one row per
// model, already the all-time rollup — so there is no timeframe to ask for.
const modelRowSelect = Prisma.validator<Prisma.ModelSelect>()({
  id: true,
  name: true,
  metrics: { select: { imageCount: true }, take: 1 },
});

type ModelRow = Prisma.ModelGetPayload<{ select: typeof modelRowSelect }>;

const asModelSources = (models: ModelRow[]) =>
  models.map((model) => ({
    type: UserHubSourceType.Model,
    targetId: model.id,
    alias: model.name,
    // All-time, because the row answers "is this worth adding", not "what is it doing
    // this week".
    imageCount: model.metrics[0]?.imageCount,
  }));

/**
 * A creator's face, so a row reads as a person rather than a string.
 *
 * Through the two shared caches rather than a `findMany` of its own — this now runs on
 * every debounced keystroke of the Creators tab, and `profilePictureCache` is also what
 * carries `nsfwLevel` and `ingestion` to the client, which is what lets the row render
 * through `UserAvatar` instead of re-deriving the gate.
 *
 * Their images are NOT counted: nothing stores that per user — `UserMetric.uploadCount`
 * is models, not images — and a plausible wrong number is worse than none.
 */
async function withFaces(items: { type: UserHubSourceType; targetId: number; alias: string }[]) {
  if (!items.length) return [];

  const ids = items.map((item) => item.targetId);
  const [basic, pictures] = await Promise.all([
    getBasicDataForUsers(ids),
    getProfilePicturesForUsers(ids),
  ]);

  return items.map((item) => ({
    ...item,
    username: basic[item.targetId]?.username ?? null,
    deletedAt: basic[item.targetId]?.deletedAt ?? null,
    image: basic[item.targetId]?.image ?? null,
    profilePicture: pictures[item.targetId] ?? null,
  }));
}

async function ownedModels({
  userId,
  term,
  take,
}: {
  userId: number;
  term?: string;
  take: number;
}) {
  return dbRead.model.findMany({
    where: {
      userId,
      status: ModelStatus.Published,
      deletedAt: null,
      ...(term ? { name: { contains: term, mode: 'insensitive' as const } } : {}),
    },
    select: modelRowSelect,
    orderBy: { createdAt: 'desc' },
    take,
  });
}

/**
 * One tab's worth of the picker: what it holds, how much of it there is, and — when a
 * search inside it finds nothing — where the matches actually were.
 *
 * That last part is what a scoped search owes the person using it. Typing a creator's
 * name under "My models" finds nothing and says nothing, and the reason ("you are
 * looking in the wrong drawer") is invisible from the inside.
 */
export async function getHubSourceScope({
  scope,
  query,
  userId,
  isModerator,
}: GetHubSourceScopeInput & { userId: number; isModerator?: boolean }) {
  const trimmed = query?.trim();
  const term = trimmed && trimmed.length >= MIN_SEARCH_TERM ? trimmed : undefined;

  const { items, total } = await readHubSourceScope({ scope, term, userId, isModerator });

  return {
    items,
    total,
    // Only when a SCOPED drawer came up empty on a real search: the other counts are
    // three more queries answering a question nobody asked until then. Never for
    // 'all', which has already read all four — re-running them is ~17 round trips to
    // rebuild a result that is empty by construction.
    elsewhere:
      items.length || !term || scope === 'all'
        ? []
        : await matchesElsewhere({ scope, term, userId, isModerator }),
  };
}

// Annotated because the scope reader now calls ITSELF — 'all' fans out over the
// others — and TypeScript cannot infer a recursive return.
type HubScopeItem = {
  type: UserHubSourceType;
  targetId: number;
  alias: string;
  image?: string | null;
  // 🔴 The WHOLE row, not just its url. `UserAvatar` decides whether a face may be
  // shown from `nsfwLevel` and `ingestion`; narrowing this to `{ url }` is what had the
  // picker hand-rolling an avatar with no gate on it.
  profilePicture?: ProfileImage | null;
  username?: string | null;
  deletedAt?: Date | null;
  imageCount?: number | null;
};

async function readHubSourceScope({
  scope,
  term,
  userId,
  isModerator,
}: {
  scope: HubSourceScope;
  term?: string;
  userId: number;
  isModerator?: boolean;
}): Promise<{ items: HubScopeItem[]; total: number }> {
  // No tabs above it, so nothing has narrowed the question: the keep-out box asks
  // every scope at once and answers with whatever matched. Empty until typed, like
  // the tags scope, because there is no "everything of yours" worth listing.
  if (scope === 'all') {
    if (!term) return { items: [], total: 0 };

    const found = await Promise.all(
      browsableScopes.map((other) =>
        readHubSourceScope({ scope: other, term, userId, isModerator })
      )
    );
    const items = found.flatMap((result) => result.items);
    return { items, total: items.length };
  }

  if (scope === 'tags') {
    // Nothing of yours to browse: the site's biggest tags are not a list anybody
    // should add from with one click, so this stays empty until asked.
    const items = term ? await searchHubTags(term) : [];
    return { items, total: items.length };
  }

  if (scope === 'my-models') {
    const [models, total] = await Promise.all([
      ownedModels({ userId, term, take: SUGGESTIONS_LIMIT }),
      // Counted only at rest. The header shows "N matches" while searching and the
      // bulk button is hidden, so the count query would be work nobody reads —
      // measured at 21ms/105MB of buffers on the largest catalogue.
      term ? Promise.resolve(0) : countHubTemplateCandidates({ template: 'my-models', userId }),
    ]);
    return { items: asModelSources(models), total };
  }

  if (scope === 'bookmarks') {
    // ONE id read, shared. Fetching the models and counting them separately called
    // this twice, and at the top of the distribution one call is ~390ms and 1.3GB of
    // buffers — see the cap on the read itself.
    const ids = await bookmarkedModelIds(userId);
    const models = await bookmarkedModelsByIds({
      ids,
      userId,
      term,
      isModerator,
      take: SUGGESTIONS_LIMIT,
    });
    return { items: asModelSources(models), total: term ? 0 : ids.length };
  }

  const [followed, exact, total] = await Promise.all([
    followedCreatorSuggestions({ userId, query: term }),
    // The whole-site reach this drawer would otherwise lack: someone you have never
    // followed, by exact username. Pattern matching is not available — see
    // `findCreatorByUsername`.
    term ? findCreatorByUsername(term) : Promise.resolve(undefined),
    term ? Promise.resolve(0) : countHubTemplateCandidates({ template: 'following', userId }),
  ]);

  const merged = [...followed];
  if (exact && !merged.some((item) => item.targetId === exact.targetId)) merged.unshift(exact);

  return { items: await withFaces(merged), total };
}

async function matchesElsewhere({
  scope,
  term,
  userId,
  isModerator,
}: {
  scope: HubSourceScope;
  term: string;
  userId: number;
  isModerator?: boolean;
}) {
  const others = browsableScopes.filter((other) => other !== scope);

  const counts = await Promise.all(
    others.map(async (other) => ({
      scope: other,
      count: (await readHubSourceScope({ scope: other, term, userId, isModerator })).items.length,
    }))
  );

  return counts.filter((entry) => entry.count > 0);
}

export async function followUserHub({ key, userId }: { key: string; userId: number }) {
  // Addressed by the encoded key, like every other public hub verb: an int here is a
  // second address for the same row, and this one returns through `getFollowed`,
  // which carries `key`.
  const hubId = decodeHubId(key);
  if (!hubId) throw throwNotFoundError('Hub not found');

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

export async function unfollowUserHub({ key, userId }: { key: string; userId: number }) {
  const hubId = decodeHubId(key);
  if (!hubId) throw throwNotFoundError('Hub not found');

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

/**
 * A row's tag-group key, or undefined when it is not in a group. Only Tag rows group:
 * every other kind is its own OR-arm in the feed filter, so a `groupKey` on one is
 * inert and must not pull anything with it.
 */
const tagGroupKey = (source: HubSourceRow) =>
  source.type === UserHubSourceType.Tag && source.groupKey != null
    ? hubTagGroupKey({ exclude: source.exclude, groupKey: source.groupKey })
    : undefined;

/** The columns `resolveHubSources` reads off a hub's source rows. */
type HubSourceRow = {
  type: UserHubSourceType;
  targetId: number;
  exclude: boolean;
  groupKey: number | null;
};

export type ResolvedHubSources = {
  userIds: number[];
  modelVersionIds: number[];
  collectionIds: number[];
  /**
   * Image tags, as AND-groups. Unlike a Model source these need no expansion and no
   * budget: the ids ARE what the index is filtered on.
   *
   * Each inner array is ANDed and the groups are ORed, so `[[1,2],[3]]` reads
   * "(1 and 2) or 3". A hub with no groups set resolves to one id per array, which
   * is the pre-`groupKey` behaviour.
   */
  tagGroups: number[][];
  /** True when a Model source expanded past the id cap and was trimmed. */
  truncated: boolean;
  /** The hub's stored browsing-level cap. 0 means the hub imposes none. */
  forcedBrowsingLevel: number;
  /**
   * What the hub refuses. Never truncated, unlike the positive sets above: a
   * trimmed inclusion shows less than the owner asked for, where a trimmed
   * exclusion shows content they said to keep out. `exclusionsPerHub` is what
   * bounds this instead.
   */
  excluded: { userIds: number[]; modelVersionIds: number[]; tagGroups: number[][] };
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
      sources: {
        // ⚠️ Nothing constrains a GROUP's members to share `enabled`, so a half-enabled
        // group resolves to an AND-set of only the enabled half — a WIDER feed than the
        // card describes. Benign only because the editor's single control switches the
        // whole group and only the owner can persist `enabled`. It stops being benign
        // the day any non-owner surface can write that column, at which point it is the
        // same widening the session-toggle sweep below exists to prevent, by another
        // door. Constrain it there, not here.
        where: { enabled: true },
        select: { type: true, targetId: true, exclude: true, groupKey: true },
      },
    },
  });
  if (!hub) return null;

  // A viewer of someone else's hub toggles sources off for their own session, and
  // that never reaches the owner's row — subtask 868kwp5gt. Applied here rather
  // than in the filter builders because this is the one place the id sets exist,
  // and because subtracting can only ever NARROW the feed: a forged exclusion
  // removes content from the forger, and can add none.
  //
  // 🔴 That claim is what makes this list safe to accept from the client, and a tag
  // AND-group is the one thing that can break it. Dropping ONE member turns `A AND B`
  // into `A`, which matches a SUPERSET — so a toggle landing on any member takes the
  // whole group with it. That is also what the editor's own switch does, since a
  // half-enabled group filters on fewer tags than its card shows.
  //
  // 🔴 Applied to the POSITIVE sources only. A session toggle reaching the negative
  // ones would let a viewer switch off somebody else's exclusion, which is the one
  // direction this list must never be able to move the feed: forging it would ADD
  // content the owner refused, where forging a positive toggle only removes their
  // own.
  const sessionExcluded = new Set((excludedSources ?? []).map(hubSourceKey));
  const negativeSources = hub.sources.filter((s) => s.exclude);
  const positive = hub.sources.filter((s) => !s.exclude);
  // Only tags group, so only a tag's key can pull its siblings out with it. Keyed
  // through `hubTagGroupKey` rather than on the bare int: these rows are all positive
  // today, so the polarity is constant — but that is a property of the filter three
  // lines up, and keying on the int would make this correct only while that holds.
  const toggledOffGroups = new Set(
    positive
      .filter((s) => sessionExcluded.has(hubSourceKey(s)))
      .map(tagGroupKey)
      .filter((key): key is string => !!key)
  );
  const positiveSources = positive.filter((s) => {
    if (sessionExcluded.has(hubSourceKey(s))) return false;
    const group = tagGroupKey(s);
    return !group || !toggledOffGroups.has(group);
  });

  const byType = (type: UserHubSourceType) =>
    positiveSources.filter((s) => s.type === type).map((s) => s.targetId);

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

  // Started before the positive expansion below rather than awaited after it: both
  // are independent reads on the same hot path, and a hub carrying a Model source on
  // each side would otherwise pay for them end to end before the first Meili call.
  const excludedPromise = resolveExcludedSources(negativeSources);

  // 🔴 Nothing outside this function reads `truncated`, and that is a decision rather
  // than an oversight — Justin's call, 2026-09-18. A hub past the budget serves a
  // partial feed silently, so the flag was traced and a field on the feed response
  // costed; it was left alone because no hub is near the line. Measured that day:
  // of 1,034 hubs holding model sources, ZERO exceed the 750 budget, the worst sums
  // to 476 versions and the average is 22.4.
  //
  // Revisit when that stops being true — the model source cap rising, or one very
  // large catalogue — because the failure is invisible from the outside: a feed that
  // is quietly missing content looks exactly like a feed.
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

  const excluded = await excludedPromise;
  const allVersionIds = [...new Set([...explicitVersionIds, ...versionIdsOfModels])];
  const modelVersionIds = allVersionIds.slice(0, hubLimits.resolvedVersionIds);
  if (allVersionIds.length > modelVersionIds.length) truncated = true;

  return {
    userIds: byType(UserHubSourceType.User),
    modelVersionIds,
    truncated,
    collectionIds: byType(UserHubSourceType.Collection),
    tagGroups: groupTagIds(positiveSources),
    forcedBrowsingLevel: hub.forcedBrowsingLevel,
    excluded,
  };
}

/**
 * The id sets a hub's negative sources become. An excluded Model expands to ALL of
 * its versions — no per-model budget and no trimming, unlike the positive path,
 * because a trimmed exclusion is a permissive failure: the content the owner said
 * to keep out comes back, and nothing anywhere reports it.
 *
 * What keeps it affordable is `assertExcludedModelsFit`, which refuses the ADD when
 * a hub's excluded models would expand past `hubLimits.excludedVersionIds`. The cap
 * on source COUNT does not bound this on its own — the expansion factor is a
 * property of the data, not of the code.
 */
async function resolveExcludedSources(
  sources: HubSourceRow[]
): Promise<ResolvedHubSources['excluded']> {
  const byType = (type: UserHubSourceType) =>
    sources.filter((s) => s.type === type).map((s) => s.targetId);

  const modelIds = byType(UserHubSourceType.Model);
  const versionIds = byType(UserHubSourceType.ModelVersion);

  if (modelIds.length) {
    const rows = await dbRead.modelVersion.findMany({
      where: { modelId: { in: modelIds } },
      select: { id: true },
    });
    versionIds.push(...rows.map((row) => row.id));
  }

  return {
    userIds: byType(UserHubSourceType.User),
    modelVersionIds: [...new Set(versionIds)],
    tagGroups: groupTagIds(sources),
  };
}

/**
 * The hub's tag rows as AND-groups: rows sharing a `groupKey` must ALL match, and a
 * null key is a group of one. An include group 3 and an exclude group 3 are different
 * groups — scoped by `exclude` being part of the map key, NOT by this happening to be
 * called once per polarity, so folding the two calls into one cannot quietly merge a
 * kept-out tag into the hub's own AND-set. `groupHubSources` in hub.utils.ts states
 * the same rule over display values.
 *
 * Exported for `user-hub.service.test.ts`, which calls it with a MIXED list. Through
 * `resolveHubSources` the polarity scoping is unreachable — the two calls are already
 * split by polarity, so a test there passes with or without `exclude` in the key, and
 * would read as coverage of a guard it cannot see.
 *
 * Groups keep first-appearance order, and a one-member group is indistinguishable from
 * an ungrouped tag. That is what leaves every hub predating the column unchanged.
 */
export function groupTagIds(sources: HubSourceRow[]) {
  const groups: number[][] = [];
  const byKey = new Map<string, number[]>();
  for (const source of sources) {
    if (source.type !== UserHubSourceType.Tag) continue;
    if (source.groupKey == null) {
      groups.push([source.targetId]);
      continue;
    }
    const key = hubTagGroupKey({ ...source, groupKey: source.groupKey });
    const held = byKey.get(key);
    if (held) {
      held.push(source.targetId);
      continue;
    }
    const group = [source.targetId];
    byKey.set(key, group);
    groups.push(group);
  }
  return groups;
}

/**
 * The hub's own content cap, intersected with whatever the viewer was already
 * allowed. Returns 0 for "this viewer can see nothing in this hub", which callers
 * must serve as an empty page rather than as an uncapped one.
 *
 * Extracted because both Meilisearch filter builders apply it, and a cap missing
 * from one of them is a hub quietly serving past its own setting.
 */
export function hubBrowsingLevel(browsingLevel: number | undefined, sources: ResolvedHubSources) {
  if (!sources.forcedBrowsingLevel) return browsingLevel;
  // An absent level means PG here, exactly as it does in the level block each
  // caller runs next. Defaulting to "every level" instead would let a hub's cap
  // WIDEN a request that asked for no level at all, which is the opposite of what
  // a cap is for.
  return (browsingLevel || NsfwLevel.PG) & sources.forcedBrowsingLevel;
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
  await assertHubTagsUsable(sources);

  // A Collection cannot be a NEGATIVE source: `resolveExcludedSources` has no
  // collection arm, so the row would store, read as an exclusion in the editor, and
  // filter nothing. Refused rather than quietly ignored, and refused ahead of the
  // feature flag below so that flipping the flag on does not turn this into the
  // silent case — whoever flips it will be exercising the positive path.
  if (sources.some((s) => s.type === UserHubSourceType.Collection && s.exclude))
    throw throwBadRequestError('A collection cannot be excluded from a hub.');

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

/**
 * Whether a hub's excluded models still fit the filter the feed has to build.
 *
 * Checked HERE, at the write, because the read cannot fix it: trimming the expansion
 * is the permissive failure this whole path is shaped to avoid, so the only honest
 * options are refusing the add or serving a filter that grows without bound. The
 * caller passes the ids the hub would hold AFTER the write, so it also covers a
 * source flipped from collected to excluded.
 */
async function assertExcludedModelsFit(modelIds: number[]) {
  if (!modelIds.length) return;

  const versions = await dbRead.modelVersion.findMany({
    where: { modelId: { in: modelIds } },
    select: { modelId: true },
  });
  if (versions.length <= hubLimits.excludedVersionIds) return;

  // Names the model that costs the most, because "you have excluded too much" is not
  // something a user can act on without knowing which one to drop.
  const perModel = new Map<number, number>();
  for (const { modelId } of versions) perModel.set(modelId, (perModel.get(modelId) ?? 0) + 1);
  const [worst] = [...perModel.entries()].sort((a, b) => b[1] - a[1]);
  const model = await dbRead.model.findFirst({
    where: { id: worst[0] },
    select: { name: true },
  });

  throw throwBadRequestError(
    `Excluding these models covers ${versions.length} versions, more than a hub can filter on (${hubLimits.excludedVersionIds}). ` +
      `"${model?.name ?? worst[0]}" alone accounts for ${worst[1]}.`
  );
}

/**
 * Which tags a hub may be keyed on, in either direction. The tag table is not a
 * vocabulary of subjects — it also carries the moderation labels the scanners write
 * and the system tags the site runs on, and a hub addressed by id would otherwise
 * reach every one of them.
 *
 * Moderation labels are part of that vocabulary as of 2026-09-17; System tags are not.
 * `HUB_TAG_SOURCE_FILTER` carries the reasoning for both.
 */
/**
 * The vocabulary rule as a `where` fragment, so the add path and the paste-a-link
 * path cannot disagree about what a hub may be keyed on. `HUB_TAG_SOURCE_FILTER` is
 * the values; this is the query that applies them.
 */
const hubTagWhere = {
  unlisted: false,
  adminOnly: false,
  target: { hasEvery: [...HUB_TAG_SOURCE_FILTER.entityType] },
  type: { in: [...HUB_TAG_SOURCE_FILTER.types] },
};

async function assertHubTagsUsable(sources: UserHubSourceInput[]) {
  const tagIds = sources
    .filter((source) => source.type === UserHubSourceType.Tag)
    .map((source) => source.targetId);
  if (!tagIds.length) return;

  const [tags, replacedTagIds] = await Promise.all([
    // Filtered in the QUERY, by the same fragment `resolveHubSourceFromUrl` uses to
    // look one up by name. Re-deriving the rule from selected columns here would be
    // a second spelling of it, and the two would drift the first time the vocabulary
    // moved.
    dbRead.tag.findMany({
      where: { id: { in: tagIds }, ...hubTagWhere },
      select: { id: true },
    }),
    // A replaced tag still exists and still reads as browsable, but the index carries
    // its REPLACEMENT's id — so as a source it matches nothing, and as an exclusion it
    // keeps nothing out, which is the permissive direction. `getTags` drops these, so
    // the picker never offers one; the URL input and the raw API reach here without it.
    getReplacedTagIds(),
  ]);
  const replaced = new Set(replacedTagIds);
  const usable = new Set(tags.map((tag) => tag.id));

  for (const id of tagIds) {
    // A tag that fails the rule is a not-found rather than a refusal naming it: this
    // is an id-addressed lookup over a dense id space, so an error that distinguishes
    // "no such tag" from "that one is a moderation label" enumerates the moderation
    // vocabulary for anyone willing to count.
    if (!usable.has(id) || replaced.has(id)) throw throwNotFoundError(`Tag ${id} not found`);
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

  if (ref.type === 'tag' || ref.type === 'tagId') {
    // Plain equals, never `mode: 'insensitive'`: measured on the prod replica, this
    // is an Index Scan on `Tag_name_cover_idx` at 0.04ms over 567,616 rows, and the
    // vocabulary clauses ride as a filter over the single row the unique index
    // returns. 🔴 What carries that is the BIND being citext, not the column — force
    // the same predicate to `text` and the plan collapses to a parallel seq scan at
    // 77ms. Prisma leaves the parameter type to the server, which infers citext.
    //
    // Note /tag/<name> is the MODEL tag page, and this rule requires an Image-targeted
    // tag — so a model-only tag resolves to null here, which is correct (it would
    // match nothing in an image feed) but means the by-name arm succeeds only for
    // dual-targeted tags.
    const [tag, replacedTagIds] = await Promise.all([
      dbRead.tag.findFirst({
        where:
          ref.type === 'tag'
            ? { name: { equals: ref.tagname }, ...hubTagWhere }
            : { id: ref.tagId, ...hubTagWhere },
        select: { id: true, name: true },
      }),
      getReplacedTagIds(),
    ]);
    // Null for a moderation label exactly as for a tag that does not exist. This
    // endpoint answers before anything is saved, so a distinguishable refusal here
    // would be a name oracle over the vocabulary the add path hides.
    if (!tag || replacedTagIds.includes(tag.id)) return null;

    return { type: UserHubSourceType.Tag, targetId: tag.id, alias: tag.name };
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

/**
 * Every scope that holds something to browse — `all` is the fan-out over them, not one
 * of them. Derived so a fifth kind added to the schema reaches the keep-out search and
 * the "the matches are over there" count without a second edit: missing one of those is
 * invisible, because it produces "no results", which is a legal answer.
 */
const browsableScopes = hubSourceScopeSchema.options.filter(
  (scope): scope is Exclude<HubSourceScope, 'all'> => scope !== 'all'
);

const SUGGESTIONS_LIMIT = 25;

// How much of the viewer's relationship list a bare suggestion LIST reads. The name
// filter is not expressed as a relation filter because that does NOT bound the work:
// Prisma emits it as a subquery, the planner walks every one of the viewer's rows
// probing the target table, and `take` only stops it early when matches are dense.
// Measured on the prod replica: a viewer following 130,006 people paid 4.8s and
// ~4.85GB of buffers for a term matching none of them — worst exactly for the rare
// term that makes a type-ahead worth having.
//
// So the relationship list drives, bounded, and the name filter runs over the ids it
// returns. Which makes the window the searchable SET, not a page size — see
// SUGGESTIONS_SEARCH_WINDOW.
const SUGGESTIONS_WINDOW = 500;

// What a SEARCH reads instead, because it has to reach the whole relationship list
// rather than the recent end of it: a viewer following 2,738 creators had the one
// they were looking for at position 1,905, so the 500-row window meant the type-ahead
// could never return them.
//
// 🔴 Raising this is close to FREE, and lowering it buys nothing — measured on the
// prod replica at both windows, per arm, worst case (term matching nothing):
//
//   follows, 118,609 rows   500 -> 444 ms / 165,001 buffers ; 5000 -> 181 ms warm,
//                           723 ms cold / 48,212 buffers
//   Notify, 250,491 rows    identical plan and ~130,800 buffers at BOTH windows;
//                           283 ms warm, 1.56 s cold
//   bookmarks, 258,105      identical at both; ~86 ms / 32k buffers
//   15,000-id union + ILIKE 34.5 ms / 19.4k buffers (477 index searches, not 15,000)
//
// Every arm orders by a column no composite index covers, so the viewer's WHOLE
// relationship list is read either way and the `take` only sizes the top-N heap. At
// 500 the follows arm picks a worse plan off the global createdAt index. The real
// cost of this endpoint is the unindexed `ORDER BY createdAt` on ModelEngagement, at
// any window; an index on (userId, type, createdAt DESC) INCLUDE (modelId) is what
// would move it.
//
// Only 57 accounts follow more than this and 1,066 watch more models than this, so
// above the window a search is still partial; closing that needs a trigram index so
// the term can drive instead of the relationship list.
const SUGGESTIONS_SEARCH_WINDOW = 5000;

// A one-character term matches most of the window and costs the same relationship
// read as a useful one, so it is treated as no term at all: the viewer gets their
// most recent relationships, which is what one character was going to show anyway.
const MIN_SEARCH_TERM = 2;

// A margin over the page size, because the name queries filter deleted rows AFTER the
// id restriction: slicing to exactly `SUGGESTIONS_LIMIT` returns a short page whenever
// one of the ids has since been deleted (measured on prod: 2 of 500 on one account).
const SUGGESTIONS_SLICE = SUGGESTIONS_LIMIT * 2;

// How far back the relationship queries read. Every one of them orders most-recent
// first, so this is a recency cut — keep it that way when adding an arm, or the
// widened window becomes an arbitrary slice that moves between keystrokes.
function suggestionWindow(term: string | undefined) {
  return term ? SUGGESTIONS_SEARCH_WINDOW : SUGGESTIONS_WINDOW;
}

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
/**
 * The whole-site reach the Creators tab would otherwise lack, and it is an EQUALITY
 * match on purpose. That tab searches who you follow, so a creator you have never
 * followed is invisible to it — which made typing an exact username find nothing.
 *
 * Pattern matching is not available here: `User.username` is `citext`, so neither
 * `ILIKE '%x%'` nor even `ILIKE 'x%'` can use an index. Measured on the prod replica
 * 2026-09-17 over 13.2M rows: both seq-scan, 5.7s and 4.6s. Equality uses the unique
 * index and answers in 0.2ms.
 *
 * So typing a username in full finds anyone; typing part of one finds who you follow.
 * Partial matching site-wide needs a trigram index on the column — a deliberate
 * migration, not something to slip into a keystroke path.
 */
async function findCreatorByUsername(term: string) {
  const user = await dbRead.user.findFirst({
    where: { username: term, deletedAt: null },
    select: { id: true, username: true },
  });
  if (!user?.username) return undefined;

  return { type: UserHubSourceType.User, targetId: user.id, alias: user.username };
}

async function searchHubTags(term: string) {
  const [tags, replacedTagIds] = await Promise.all([
    dbRead.tag.findMany({
      where: { name: { contains: term, mode: 'insensitive' }, ...hubTagWhere },
      select: {
        id: true,
        name: true,
        metrics: {
          where: { timeframe: MetricTimeframe.AllTime },
          select: { imageCount: true },
          take: 1,
        },
      },
      // Read wide and rank below rather than ordering here: `TagMetric` is keyed by
      // timeframe, so Prisma can only order by how MANY metric rows a tag has, which
      // is not a measure of anything.
      take: SUGGESTIONS_LIMIT * 5,
    }),
    getReplacedTagIds(),
  ]);

  const replaced = new Set(replacedTagIds);
  return (
    tags
      .filter((tag) => !replaced.has(tag.id))
      .map((tag) => ({
        type: UserHubSourceType.Tag,
        targetId: tag.id,
        alias: tag.name,
        imageCount: tag.metrics[0]?.imageCount ?? 0,
      }))
      // By USE, not by name: alphabetically, "swimsuit bottom" outranks "swimsuit" and
      // the tag someone meant falls off the end of the page. A tag is worth offering in
      // proportion to what it would actually collect — which is also the number the row
      // shows, so the order and the column agree.
      .sort((a, b) => b.imageCount - a.imageCount)
      .slice(0, SUGGESTIONS_LIMIT)
  );
}

/**
 * Creators this viewer follows, optionally narrowed by name.
 *
 * Models and collections used to be arms of this same function, reachable only
 * through a tRPC procedure no client called. Both are gone; the scopes in
 * `readHubSourceScope` are the only way in.
 */
async function followedCreatorSuggestions({ userId, query }: { userId: number; query?: string }) {
  const trimmed = query?.trim();
  const term = trimmed && trimmed.length >= MIN_SEARCH_TERM ? trimmed : undefined;

  const follows = await dbRead.userEngagement.findMany({
    where: { userId, type: UserEngagementType.Follow },
    select: { targetUserId: true },
    orderBy: { createdAt: 'desc' },
    take: suggestionWindow(term),
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
