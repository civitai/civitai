import type { Prisma } from '@prisma/client';
import { throwOnBlockedUserContent } from '~/server/services/blocklist.service';
import { dbRead, dbWrite } from '~/server/db/client';
import type {
  AnnouncementMetaSchema,
  UpsertCreatorAnnouncementSchema,
} from '~/server/schema/announcement.schema';
import { CREATOR_ANNOUNCEMENT_CONTENT_MAX } from '~/server/schema/announcement.schema';
import { getAnnouncementAllowance } from '~/server/services/announcement-allowance.service';
import {
  activeAnnouncementWhere,
  announcementWindowOverlapsWhere,
} from '~/server/services/announcement-window';
import { resolveCoverImageId } from '~/server/services/cover-image.service';
import { isImageOwner } from '~/server/services/util.service';
import {
  amIBlockedByUser,
  getCosmeticsForUsers,
  getProfilePicturesForUsers,
} from '~/server/services/user.service';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import { registerCounterWithLabels, registerGaugeWithLabels } from '~/server/prom/client';
import { getAllServerHosts } from '~/server/utils/server-domain';
import { createKeyedTtlMemo } from '~/server/utils/ttl-memoize';
import { isDefined } from '~/utils/type-guards';
import { throwAuthorizationError, throwBadRequestError } from '~/server/utils/errorHandling';
import { DomainColor, UserEngagementType } from '~/shared/utils/prisma/enums';

// Two-arg classed form, as free-placement uses: the one-arg form shares an int4 keyspace
// with `article.service.ts`, which locks on a bare articleId, so a hashed key could collide
// with an unrelated article's lock.
const ANNOUNCEMENT_LOCK_CLASS = 0x414e0001;

const creatorAnnouncementSelect = {
  id: true,
  title: true,
  content: true,
  emoji: true,
  color: true,
  domain: true,
  startsAt: true,
  endsAt: true,
  disabled: true,
  profileOnly: true,
  coverId: true,
  createdAt: true,
  metadata: true,
  userId: true,
  cover: {
    select: {
      id: true,
      url: true,
      nsfwLevel: true,
      width: true,
      height: true,
      type: true,
      name: true,
      // MediaHash renders this while a cover is blurred; without it a blurred cover is an
      // empty box rather than a placeholder.
      hash: true,
    },
  },
  user: { select: { id: true, username: true, image: true, deletedAt: true } },
  // `satisfies`, not `as const`: a standalone object literal gets no excess-property
  // check when it is passed to Prisma later, so a column that does not exist typechecks
  // clean and 500s at runtime on every read and write. This is the check that catches it.
} satisfies Prisma.AnnouncementSelect;

type RawCreatorAnnouncement = {
  metadata: unknown;
  cover: { nsfwLevel: number } | null;
};

/**
 * `Announcement` has no nsfwLevel of its own, so the cover's level IS the announcement's —
 * text carries no rating here. Surfaced as a top-level field anyway so callers gate on one
 * number and cannot forget the cover, which is the only thing that can be mature.
 */
function toCreatorAnnouncementDTO<T extends RawCreatorAnnouncement>(announcement: T) {
  return {
    ...announcement,
    // Parsed here, as the sitewide DTO does, so the client reads metadata.actions
    // without a cast rather than being trusted to know the shape.
    metadata: (announcement.metadata ?? {}) as AnnouncementMetaSchema,
    nsfwLevel: announcement.cover?.nsfwLevel ?? 0,
  };
}

/**
 * Cosmetics and the profile-picture row are not columns on `User`, so the select cannot
 * reach them; both already live in caches every other card-shaped surface reads, and the
 * author set on one page of announcements is a handful of ids. Attached to the author here
 * so a creator announcement renders with the same identity the rest of the site gives them
 * — a byline that is only a name is what the reader has to tell apart from Civitai's own.
 */
async function withAuthorIdentity<T extends { user: { id: number } | null }>(
  announcements: T[],
  { hydrate }: { hydrate: boolean }
) {
  const userIds = hydrate
    ? [...new Set(announcements.map((x) => x.user?.id).filter(isDefined))]
    : [];
  const [profilePictures, cosmetics] = userIds.length
    ? await Promise.all([getProfilePicturesForUsers(userIds), getCosmeticsForUsers(userIds)])
    : [{}, {}];

  return announcements.map((announcement) => ({
    ...announcement,
    user: announcement.user
      ? {
          ...announcement.user,
          profilePicture: profilePictures[announcement.user.id] ?? null,
          cosmetics: cosmetics[announcement.user.id] ?? [],
        }
      : null,
  }));
}

/**
 * Creator-authored announcements only. Every query here pins `userId` to a real author, so
 * a platform row (`userId: null`) can never be read, edited or deleted through this path —
 * the mirror of the sitewide caches, which select on null.
 */
export async function getCreatorAnnouncements({
  userId,
  limit = 10,
  includeHidden = false,
  domain,
  viewerId,
}: {
  userId: number;
  limit?: number;
  includeHidden?: boolean;
  domain?: DomainColor;
  viewerId?: number;
}) {
  const now = new Date();

  // After the migration this text IS the profile banner, and the banner is already
  // withheld from a blocked viewer (`user-profile.controller.ts`). A public read on an
  // arbitrary userId would otherwise hand it back.
  if (
    viewerId &&
    viewerId !== userId &&
    (await amIBlockedByUser({ userId: viewerId, targetUserId: userId }))
  )
    return [];

  const announcements = await dbRead.announcement.findMany({
    where: {
      userId,
      // The migrated SFW banners exist precisely so a green visitor does not see the
      // other one. Without this the profile shows both, which is a browsing-boundary
      // leak rather than a double-render.
      ...(domain ? { domain: { hasSome: [DomainColor.all, domain] } } : {}),
      // The shared live window, as an AND member rather than spread: a spread brings its own
      // `AND` key, which any later `AND` here would silently replace.
      ...(includeHidden ? {} : { AND: [activeAnnouncementWhere(now)] }),
    },
    select: creatorAnnouncementSelect,
    orderBy: [{ startsAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
    take: limit,
  });

  // `hydrate: false` — the profile carousel renders no byline (see `CreatorAnnouncement`'s
  // `withAuthor`), so fetching the author's picture and cosmetics here would be two cache
  // fan-outs and several KB per row, duplicated across rows that all share one author, for
  // fields nothing reads. The FIELDS are still present so both queries have one DTO shape.
  // If a byline is ever added to the profile, flip this — do not remove the argument.
  return withAuthorIdentity(announcements.map(toCreatorAnnouncementDTO), { hydrate: false });
}

/*
 * The live-author short-circuit for the followed feed (behind CREATOR_FEED_SHORTCIRCUIT).
 *
 * The feed query filters through the author relation with correlated subqueries, and the bell
 * runs it on every signed-in page load — for most viewers to find that nobody they follow has a
 * live announcement. So the feed first asks two cheap questions: which authors have a feedable
 * announcement at all (a small read per domain per pod each time the cached set expires — the memo
 * does not dedupe in flight, so requests that miss together each read once), and which of those this viewer
 * follows (a primary-key range read on UserEngagement). An empty answer to either ends the call;
 * otherwise the feed query runs exactly as before, with `userId IN (that intersection)` added.
 *
 * Why the results are the same rows: the added filter can only drop rows whose author is not in
 * the intersection, and the feed query itself requires both halves of it — the author follows
 * relation (`engagedUsers some Follow`) and a non-profileOnly, non-disabled row in the live
 * window for the domain. The author set is a SUPERSET of the authors that are live at any moment
 * inside its TTL: it looks ahead past `startsAt` by twice the TTL, looks back past `endsAt` by one
 * TTL (so a request whose own clock reading came before the set's still finds an author whose only
 * row ended in between), and keeps rows whose `endsAt` passes during its life. The feed query
 * re-applies the exact window. Every viewer predicate —
 * mutes, blocks both ways, hides — stays in the feed query, untouched.
 *
 * Where it can differ: an author who becomes live in a way the lookahead cannot foresee — a new
 * announcement, an edit that moves a row into the window or the domain, a disabled row re-enabled
 * — is absent from a set built before that write until the set refreshes, on this pod or any
 * other: up to LIVE_AUTHORS_TTL_MS (plus replica lag) late for that author's followers. Removals
 * (delete, disable, profileOnly) only shrink the true set, which a superset absorbs. That bounded
 * delay is the accepted cost, and why this sits behind a switch.
 */
const LIVE_AUTHORS_TTL_MS = 30_000;
// Twice the TTL, so a row whose start falls inside a cached set's lifetime is already in it even
// when the read that built the set was slow (the memo's expiry is stamped after the read).
const LIVE_AUTHORS_LOOKAHEAD_MS = 2 * LIVE_AUTHORS_TTL_MS;
// One TTL back. The feed reads its `now` before it asks for the set, and a cold set is built a
// little later, by this or another request; a row that ended in that gap is live for the feed
// query and must not be missing from the set. Requests take far less than a TTL.
const LIVE_AUTHORS_LOOKBACK_MS = LIVE_AUTHORS_TTL_MS;
const ANY_DOMAIN = 'any';

/** Exported for tests only. One increment per short-circuit decision, by what it decided. */
export const creatorFeedShortcircuitCounter = registerCounterWithLabels({
  name: 'creator_feed_shortcircuit_total',
  help: 'Followed creator feed short-circuit outcomes: empty_set, no_follows, narrowed, fallback.',
  labelNames: ['outcome'] as const,
});

/** Exported for tests only. Size of the live-author set at its last build, per domain key. */
export const creatorFeedLiveAuthorsGauge = registerGaugeWithLabels({
  name: 'creator_feed_live_authors',
  help: 'Authors in the followed creator feed live-author set at its last build, per domain.',
  labelNames: ['domain'] as const,
});

const liveAuthorIdsMemo = createKeyedTtlMemo<number[]>(
  async (domainKey) => {
    const now = Date.now();
    const rows = await dbRead.announcement.findMany({
      where: {
        profileOnly: false,
        userId: { not: null },
        ...(domainKey !== ANY_DOMAIN
          ? { domain: { hasSome: [DomainColor.all, domainKey as DomainColor] } }
          : {}),
        // The shared "is this announcement showing" window (enabled, open-ended start and end),
        // widened: one TTL back past `endsAt`, two ahead past `startsAt`. The feed query uses
        // the same helper at its exact `now`, so the set is a superset of it by construction.
        // An AND member, never spread: see `followedAnnouncementsWhere`.
        AND: [
          announcementWindowOverlapsWhere(
            new Date(now - LIVE_AUTHORS_LOOKBACK_MS),
            new Date(now + LIVE_AUTHORS_LOOKAHEAD_MS)
          ),
        ],
      },
      select: { userId: true },
    });
    const authors = [...new Set(rows.map((x) => x.userId).filter(isDefined))];
    creatorFeedLiveAuthorsGauge.set({ domain: domainKey }, authors.length);
    return authors;
  },
  LIVE_AUTHORS_TTL_MS,
  () => Date.now(),
  // One array served to every request on the pod for the TTL.
  { freeze: true }
);

/** Exported for tests only. */
export function resetLiveAuthorCache() {
  liveAuthorIdsMemo.clear();
}

/**
 * The authors this viewer follows who may have a feedable announcement, or `undefined` when the
 * feed should run unnarrowed (switch off, or the narrowing read failed — the feed query then
 * answers as it always has). An empty array means the feed is empty.
 */
async function resolveFollowedLiveAuthors({
  userId,
  domain,
}: {
  userId: number;
  domain?: DomainColor;
}): Promise<number[] | undefined> {
  if (!(await isFlipt(FLIPT_FEATURE_FLAGS.CREATOR_FEED_SHORTCIRCUIT))) return undefined;

  try {
    const candidates = await liveAuthorIdsMemo(domain ?? ANY_DOMAIN);
    if (!candidates.length) {
      creatorFeedShortcircuitCounter.inc({ outcome: 'empty_set' });
      return [];
    }

    const follows = await dbRead.userEngagement.findMany({
      where: { userId, type: UserEngagementType.Follow, targetUserId: { in: [...candidates] } },
      select: { targetUserId: true },
    });
    creatorFeedShortcircuitCounter.inc({ outcome: follows.length ? 'narrowed' : 'no_follows' });
    return follows.map((x) => x.targetUserId);
  } catch (error) {
    // Falls back to the unnarrowed feed query, which answers as it did before the switch: the
    // viewer sees no difference, so this counter and log are the only sign it happened.
    creatorFeedShortcircuitCounter.inc({ outcome: 'fallback' });
    logToAxiom({
      name: 'creator-feed-shortcircuit-fallback',
      type: 'warning',
      message: 'Live-author narrowing failed; ran the unnarrowed followed feed query',
      details: {
        errorName: error instanceof Error ? error.name : typeof error,
        error: error instanceof Error ? error.message : String(error),
        domain: domain ?? ANY_DOMAIN,
      },
    }).catch(() => undefined);
    return undefined;
  }
}

function followedAnnouncementsWhere({
  userId,
  domain,
  authorIds,
  now,
}: {
  userId: number;
  domain?: DomainColor;
  authorIds?: number[];
  now: Date;
}) {
  return {
    profileOnly: false,
    userId: authorIds ? { in: authorIds } : { not: null },
    user: {
      // engagedUsers = rows where this author is the TARGET, i.e. their followers.
      // engagingUsers is the other direction (follows the author made) and would
      // return a plausible, wrong feed.
      announcementMutesReceived: { none: { userId } },
      // Blocks both ways, mirroring `notBlockedBetween` exactly — the asymmetry is
      // deliberate there: the viewer's Block OR Hide of the author hides it, while the
      // author's side hides it only on Block. A follow predates the block that
      // followed it, so the follow edge alone is not consent to keep appearing.
      engagingUsers: { none: { targetUserId: userId, type: UserEngagementType.Block } },
      // Both conditions are on engagedUsers, so they go in AND rather than as two keys
      // of the same object. A repeated key here is TS1117 and would not compile; the
      // hazard is the sibling `where`, where a spread between two keys makes the same
      // mistake legal and silent.
      AND: [
        { engagedUsers: { some: { userId, type: UserEngagementType.Follow } } },
        {
          engagedUsers: {
            none: {
              userId,
              type: { in: [UserEngagementType.Block, UserEngagementType.Hide] },
            },
          },
        },
      ],
    },
    ...(domain ? { domain: { hasSome: [DomainColor.all, domain] } } : {}),
    // The shared live window — the same helper the live-author set widens, so the set stays a
    // superset of this query by construction. An AND member, never spread: the helper carries
    // its own `AND` key, and a spread followed by another `AND` here would silently drop the
    // window. As a literal key, a second `AND` is TS1117 and does not compile.
    ...activeAnnouncementWhere(now),
    ...{ AND: [{ profileOnly: false }] },
  } satisfies Prisma.AnnouncementWhereInput;
}

const followedAnnouncementsOrderBy = [
  { startsAt: { sort: 'desc', nulls: 'last' } },
  { id: 'desc' },
] satisfies Prisma.AnnouncementOrderByWithRelationInput[];

/**
 * The *Creators* chip: live announcements from authors the caller follows.
 *
 * Muted creators are absent entirely, not merely demoted — leaving their posts in the feed
 * would not be the escape hatch the ticket asked for.
 *
 * Profile-only rows never appear here; that is what profile-only means.
 */
export async function getFollowedAnnouncements({
  userId,
  limit = 20,
  cursor,
  domain,
}: {
  userId: number;
  limit?: number;
  cursor?: number;
  domain?: DomainColor;
}) {
  const now = new Date();

  const authorIds = await resolveFollowedLiveAuthors({ userId, domain });
  if (authorIds && !authorIds.length) return { items: [], nextCursor: undefined };

  const announcements = await dbRead.announcement.findMany({
    where: followedAnnouncementsWhere({ userId, domain, authorIds, now }),
    select: creatorAnnouncementSelect,
    orderBy: followedAnnouncementsOrderBy,
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const items = await withAuthorIdentity(
    announcements.slice(0, limit).map(toCreatorAnnouncementDTO),
    { hydrate: true }
  );

  return {
    items,
    nextCursor: announcements.length > limit ? items[items.length - 1]?.id : undefined,
  };
}

/**
 * `isModerator` widens this to any *authored* announcement — never to a platform row, which
 * has its own moderator tooling. Matches what moderators can already do to the profile
 * message this feature replaces: remove it in place, from wherever it is shown.
 */
async function assertOwnedAnnouncement(id: number, userId: number, isModerator = false) {
  const existing = await dbRead.announcement.findFirst({
    where: isModerator ? { id, userId: { not: null } } : { id, userId },
    select: {
      id: true,
      coverId: true,
      profileOnly: true,
      startsAt: true,
      content: true,
      metadata: true,
    },
  });
  if (!existing) throw throwAuthorizationError('Announcement not found');
  return existing;
}

/**
 * A link to one of our own domains becomes a path, so the button resolves on whichever
 * domain the reader is on — a creator pasting a civitai.com URL should not send every
 * civitai.red reader across to the other site.
 *
 * Server-side rather than in the zod schema on purpose: the host list comes from
 * `getAllServerHosts`, which reads server env, and the announcement schema is imported by
 * client components.
 *
 * Anything not ours is left exactly as typed.
 */
export function toDomainRelativeLink(link: string) {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return link; // already a path; the schema has checked its shape
  }

  const host = url.host.toLowerCase();
  const ours = getAllServerHosts().some((h) => h.toLowerCase() === host);
  if (!ours) return link;

  return `${url.pathname}${url.search}${url.hash}` || '/';
}

/**
 * Enforces the content limit on new writing without trapping the rows that predate it.
 *
 * A migrated profile banner can be longer than the limit through no act of its owner, and
 * refusing every save would leave them unable to edit their own card at all. Shortening is
 * always allowed; growing past the limit never is.
 */
export function assertContentLength(content: string, previousContent?: string) {
  if (content.length <= CREATOR_ANNOUNCEMENT_CONTENT_MAX) return;
  if (previousContent && content.length <= previousContent.length) return;

  throw throwBadRequestError(
    `Announcements are limited to ${CREATOR_ANNOUNCEMENT_CONTENT_MAX} characters.`
  );
}

/**
 * More than one link button is a member feature. A row that already carries more — saved while its
 * author was a member — may still be edited with up to as many as it has, so a lapsed membership
 * does not lock the author out of fixing a typo; it can never gain one.
 */
function assertActionCount(
  count: number,
  { isMember, previousCount = 0 }: { isMember: boolean; previousCount?: number }
) {
  if (count <= 1 || isMember || count <= previousCount) return;

  throw throwAuthorizationError('More than one link button is a membership feature.');
}

export const MIN_ANNOUNCEMENT_DURATION_MS = 60 * 60 * 1000;

const MINUTE_MS = 60_000;
const sameMinute = (a: Date, b: Date) =>
  Math.floor(a.getTime() / MINUTE_MS) === Math.floor(b.getTime() / MINUTE_MS);

/**
 * The picker is wall-clock: a creator who selects "in two minutes" then spends five writing submits
 * a start that is already past. Refusing that is a dead end, so the start moves up to now and the
 * end out to clear it by an hour.
 *
 * 🔴 A start the creator did not touch is left alone even when past. Re-stamping it would
 * republish a running announcement to the top of every follower's feed on a typo fix —
 * `getFollowedAnnouncements` orders by `startsAt` desc.
 *
 * "Did not touch" is compared at MINUTE granularity, not by exact timestamp. The composer
 * round-trips a stored start through a `datetime-local`, whose `YYYY-MM-DDTHH:mm` IS a
 * floor-to-the-minute — so a value derived that way always lands in the same bucket as the value it
 * came from, whatever produced the original. That is a property of the transform, not of the
 * widget, and it is what stops a row stamped `new Date()` (every row crossing into notifying) from
 * reading as rescheduled on an edit that changed nothing.
 *
 * REST and tRPC accept arbitrary instants, so two starts under a minute apart CAN read as
 * unchanged there. That direction leaves the start alone, which is the safe one.
 */
export function clampAnnouncementWindow({
  startsAt,
  endsAt,
  previousStartsAt,
  now,
}: {
  startsAt?: Date | null;
  endsAt?: Date | null;
  previousStartsAt?: Date | null;
  now: Date;
}): { startsAt: Date | null; endsAt: Date | null } {
  const untouched = !!startsAt && !!previousStartsAt && sameMinute(startsAt, previousStartsAt);

  const start =
    startsAt && !untouched && startsAt.getTime() < now.getTime() ? now : startsAt ?? null;

  const earliestEnd = (start ?? now).getTime() + MIN_ANNOUNCEMENT_DURATION_MS;
  const end = endsAt && endsAt.getTime() < earliestEnd ? new Date(earliestEnd) : endsAt ?? null;

  return { startsAt: start, endsAt: end };
}

export async function upsertCreatorAnnouncement({
  userId,
  isModerator = false,
  isMember = false,
  ...input
}: UpsertCreatorAnnouncementSchema & {
  userId: number;
  isModerator?: boolean;
  isMember?: boolean;
}) {
  const existing = input.id ? await assertOwnedAnnouncement(input.id, userId) : undefined;
  const actions = input.actions ?? (input.action ? [input.action] : []);

  // Push, not pull: this text is delivered to every follower rather than waiting to be visited.
  //
  // AFTER the ownership check, deliberately — same rule as the two creator-shop updates. The
  // rejection names the matched entry, so running it first answers "does this text match the
  // list" for a caller holding an id they do not own, in place of the authorization failure they
  // should get. This is the router's only gate; the procedure passes straight through.
  await throwOnBlockedUserContent(
    [input.title, input.content, ...actions.flatMap((a) => [a.linkText, a.link])],
    { isModerator, surface: 'creatorAnnouncement' }
  );

  assertActionCount(actions.length, {
    isMember,
    previousCount: (existing?.metadata as AnnouncementMetaSchema | null)?.actions?.length,
  });

  // An announcement costs a slot when it starts notifying, not when it is created.
  // profileOnly rows notify nobody, so they are free — but flipping one to profileOnly:
  // false is the moment it gains an audience, and it must pay then. Checking only
  // `!existing` let a creator mint free rows and flip them.
  const willNotify = !input.profileOnly;
  const wasNotifying = existing ? !existing.profileOnly : false;
  const spendsAllowance = willNotify && !wasNotifying;

  const coverId = input.coverImage
    ? await resolveCoverImageId({
        coverImage: input.coverImage,
        userId,
        currentCoverId: existing?.coverId,
        assertOwnership: async (imageId) => {
          if (imageId === existing?.coverId) return;
          const owner = await isImageOwner({ userId, isModerator, imageId });
          if (!owner) throw throwAuthorizationError('Invalid cover image');
        },
      })
    : undefined;

  const metadata: AnnouncementMetaSchema = {
    dismissible: true,
    ...(actions.length
      ? {
          actions: actions.map((action) => ({
            type: 'button' as const,
            link: toDomainRelativeLink(action.link),
            linkText: action.linkText,
          })),
        }
      : {}),
  };

  assertContentLength(input.content, existing?.content);

  const schedule = clampAnnouncementWindow({
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    previousStartsAt: existing?.startsAt,
    now: new Date(),
  });

  const data = {
    title: input.title,
    content: input.content,
    emoji: input.emoji,
    color: input.color ?? 'blue',
    domain: input.domain,
    startsAt: schedule.startsAt,
    endsAt: schedule.endsAt,
    // Never written on an update. A creator cannot set `disabled` at all (the schema has
    // no such field), so a row a moderator took down stays down through any edit.
    ...(existing ? {} : { disabled: false }),
    profileOnly: input.profileOnly,
    metadata,
    ...(coverId !== undefined ? { coverId } : {}),
  };

  if (!spendsAllowance) {
    // The author is set here and never read from input, so this path cannot write a row
    // attributed to anyone else.
    return existing
      ? dbWrite.announcement.update({
          where: { id: existing.id },
          data,
          select: creatorAnnouncementSelect,
        })
      : dbWrite.announcement.create({
          data: { ...data, userId },
          select: creatorAnnouncementSelect,
        });
  }

  const allowance = await getAnnouncementAllowance(userId);
  if (!allowance.eligible)
    throw throwAuthorizationError(
      `Broadcasting an announcement requires a creator score of ${allowance.minScore.toLocaleString()}.`
    );

  return dbWrite.$transaction(async (tx) => {
    // Serialises this creator's spend checks against each other. Without it the check is
    // read-then-write and two concurrent creates both see the same free slot.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ANNOUNCEMENT_LOCK_CLASS}::int, ${userId}::int)`;

    // Re-read the row on the WRITER inside the lock. `existing` came from dbRead, and
    // within replica lag it still says profileOnly, so a second save would compute
    // wasNotifying=false and charge the same announcement twice.
    const current = existing
      ? await tx.announcement.findUnique({
          where: { id: existing.id },
          select: { profileOnly: true, spends: { select: { id: true }, take: 1 } },
        })
      : null;
    if (current && (!current.profileOnly || current.spends.length > 0)) {
      return tx.announcement.update({
        where: { id: existing!.id },
        data,
        select: creatorAnnouncementSelect,
      });
    }

    const windowStart = new Date(Date.now() - allowance.windowDays * 24 * 60 * 60 * 1000);
    const spent = await tx.announcementSpend.count({
      where: { userId, createdAt: { gte: windowStart } },
    });

    if (spent >= allowance.limit)
      throw throwBadRequestError(
        allowance.nextAvailableAt
          ? `You have used all ${
              allowance.limit
            } of your broadcasts for this period. Next one ${allowance.nextAvailableAt.toDateString()}.`
          : 'You have used all your broadcasts for this period.'
      );

    const announcement = existing
      ? await tx.announcement.update({
          where: { id: existing.id },
          // A row crossing into notifying starts its life now. `getFollowedAnnouncements` orders
          // by startsAt desc NULLS LAST, so a draft that keeps a null start is charged a slot and
          // then lands at the bottom of every follower's feed.
          data: { ...data, startsAt: data.startsAt ?? new Date() },
          select: creatorAnnouncementSelect,
        })
      : await tx.announcement.create({
          data: { ...data, userId },
          select: creatorAnnouncementSelect,
        });

    await tx.announcementSpend.create({ data: { userId, announcementId: announcement.id } });

    return announcement;
  });
}

export async function deleteCreatorAnnouncement({
  id,
  userId,
  isModerator = false,
}: {
  id: number;
  userId: number;
  isModerator?: boolean;
}) {
  await assertOwnedAnnouncement(id, userId, isModerator);
  return dbWrite.announcement.delete({ where: { id }, select: { id: true } });
}

export async function toggleAnnouncementMute({
  userId,
  creatorId,
  muted,
}: {
  userId: number;
  creatorId: number;
  muted: boolean;
}) {
  if (userId === creatorId) throw throwBadRequestError('You cannot mute yourself');

  // `changed` says whether this call moved the row, and the caller records an analytics
  // event only when it did. Without it a client that re-sends the state it is already in
  // — a double-tap, a retry, a stale toggle — writes a second mute event for one muter,
  // and the creator's chart counts people who never changed their mind.
  //
  // `createMany` with `skipDuplicates` rather than a read-then-create: it reports whether
  // a row appeared, and two concurrent mutes cannot both believe they were first.
  let changed: boolean;
  if (muted) {
    const { count } = await dbWrite.userAnnouncementMute.createMany({
      data: { userId, creatorId },
      skipDuplicates: true,
    });
    changed = count > 0;
  } else {
    const { count } = await dbWrite.userAnnouncementMute.deleteMany({
      where: { userId, creatorId },
    });
    changed = count > 0;
  }

  return { muted, changed };
}

export async function isAnnouncementCreatorMuted({
  userId,
  creatorId,
}: {
  userId: number;
  creatorId: number;
}) {
  const row = await dbRead.userAnnouncementMute.findUnique({
    where: { userId_creatorId: { userId, creatorId } },
    select: { userId: true },
  });
  return !!row;
}

export async function getMutedAnnouncementCreators(userId: number) {
  const rows = await dbRead.userAnnouncementMute.findMany({
    where: { userId },
    select: { creatorId: true },
  });
  return rows.map((x) => x.creatorId);
}
