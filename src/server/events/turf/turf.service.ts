import { chunk } from 'lodash-es';
import { isFliptOnForTesters } from '~/server/flipt/tester-segment';
import { getFeatureFliptKey } from '~/server/services/feature-flags.service';
import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { loadKyselyDb } from '~/server/db/kyselyDb.lazy';
import { isPgInt4, queryPrismaSql } from '~/server/db/prisma-sql-kysely';
import { flagAudienceAmong } from '~/server/events/event-access';
import { eventPlayerEligibleSql } from '~/server/events/player-eligibility';
import { loadEvents } from '~/server/events/load-events';
import { decodeHat, eventPointKeys } from '~/server/events/points/keys';
import { isEventPointsEnabled } from '~/server/events/points/enabled';
import { getTeamPoints } from '~/server/events/points/read';
import {
  applyTurfOverride,
  DEFAULT_DRAW_CEILING,
  turfConfigKey,
  type EventTurfConfig,
} from '~/server/events/turf/config';
import {
  catchUpMultiplier,
  nextStickerAt,
  refillStock,
  scaleCredited,
  scaleSupply,
  stepAt,
  stickerLiveAfter,
  type CatchUpStep,
} from '~/server/events/turf/schedule';
import {
  capTurfMap,
  computeImageTurf,
  decodeTurfEntry,
  encodeTurfEntry,
  turfKeys,
  turfRankScore,
  type TurfCounts,
  type TurfEntry,
  type TurfStickerRow,
} from '~/server/events/turf/turf-map';
import { markTurfWatched, pushTurfCounts, type TurfPush } from '~/server/events/turf/turf-watch';
import { readFlagRaceConfig, type FlagsConfig } from '~/server/events/scoring/award-results';
import { imageVisible, ownerActive } from '~/server/events/turf/turf-sql';
import {
  FLAG_KIND,
  currentFlagDay,
  flagCrucibleTag,
  flagPot,
  flagSummaryKey,
  flagTally,
  flagWinners,
  swapFlagDay,
  type FlagTally,
} from '~/server/events/turf/flag-day';
import { logToAxiom } from '~/server/logging/client';
import { logSysRedisFailOpen } from '~/server/redis/fail-open-log';
import { withDistributedLock } from '~/server/utils/distributed-lock';
import { withSysReadDeadline } from '~/server/redis/sys-read-deadline';
import { assertCanPlace } from '~/server/services/placement-moderation.service';
import { REDIS_SUB_KEYS, REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import type { TurfHatArt, TurfStickerData, TurfStickersCursor } from '~/server/schema/turf.schema';
import { TURF_FEED_STICKERS } from '~/server/schema/turf.schema';
import {
  isPrismaUniqueViolation,
  throwAuthorizationError,
  throwBadRequestError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';

// The opt-in lives in User.settings, per event name: placing needs it (see inTurf).
export const TURF_SETTING = 'eventTurfOptIn';
// Per event name, an owner's "keep Hat Turf off my images". Only a user not in Hat Turf may set it.
export const TURF_OWNER_OFF_SETTING = 'eventTurfOwnerOff';

/**
 * Whether the user aliased `alias` is in Hat Turf for `event`: never while they keep Hat Turf off
 * their own images (a player cannot wall theirs off); otherwise only an explicit opt-in counts.
 * Placing a hat does not opt anyone in; Hat Turf was announced as opt-in only.
 */
export const inTurf = (alias: string, event: string) => {
  const u = Prisma.raw(`"${alias}"`);
  return Prisma.sql`CASE WHEN (${u}.settings -> ${TURF_OWNER_OFF_SETTING} ->> ${event}) = 'true'
    THEN false ELSE COALESCE((${u}.settings -> ${TURF_SETTING} ->> ${event}) = 'true', false) END`;
};

/**
 * The owner of image `i` is neither banned nor deleted, and has not kept Hat Turf off their images.
 * Otherwise their images take no new stickers, and those already placed are neither drawn nor
 * counted; turning the switch back on (or lifting a ban) restores them.
 */
const ownerAllowsTurf = (event: string) => Prisma.sql`EXISTS (SELECT 1 FROM "User" ow
  WHERE ow.id = i."userId" AND ow."bannedAt" IS NULL AND ow."deletedAt" IS NULL
    AND (ow.settings -> ${TURF_OWNER_OFF_SETTING} ->> ${event}) IS DISTINCT FROM 'true')`;

const CONFIG_TTL_MS = 30_000;
const TEAM_POINTS_TTL_MS = 60_000;
const MAP_LOG_MAX = 50_000;
const RECONCILE_IMAGE_BATCH = 2_000;

type LoadedEvents = Awaited<ReturnType<typeof loadEvents>>;
type EventDef = LoadedEvents[number];
export type TurfEvent = EventDef & { turf: EventTurfConfig };

// A sticker's hat art, drawn as the sticker itself: the cosmetic's image and where its visible
// pixels sit in it (the fit's canvas and bounds only; its outline is not needed to draw).
const hatArt = (cosmeticId: Prisma.Sql) => Prisma.sql`(SELECT CASE WHEN hc.data ->> 'url' IS NULL
    THEN NULL ELSE jsonb_build_object('url', hc.data ->> 'url',
      'canvas', hc.data -> 'fit' -> 'canvas', 'bounds', hc.data -> 'fit' -> 'bounds') END
  FROM "Cosmetic" hc WHERE hc.id = ${cosmeticId})`;

// Hat counts beside contest entries could sway judging: no Hat Turf on an image in any contest,
// entered in one of the event's flag Crucibles while it runs, or one of today's flags (a flag takes
// flag hats only, so its old Turf hats neither show nor earn until the next swap). Both subqueries
// are uncorrelated, so each runs once per query: CrucibleEntry has no imageId index, and the latest
// FlagDay is one index read.
const contestEntry = (imageId: Prisma.Sql, event: string) => Prisma.sql`(EXISTS (
  SELECT 1 FROM "CollectionItem" ci JOIN "Collection" c ON c.id = ci."collectionId"
  WHERE ci."imageId" = ${imageId} AND c.mode = 'Contest'
) OR ${imageId} IN (
  SELECT ce."imageId" FROM "Crucible" cr JOIN "CrucibleEntry" ce ON ce."crucibleId" = cr.id
  WHERE cr.status = 'Active'::"CrucibleStatus"
    AND cr."eventTags" @> ARRAY[${flagCrucibleTag(event)}]::text[] AND ce."imageId" IS NOT NULL
) OR ${imageId} = ANY(COALESCE((
  SELECT f."imageIds" FROM "FlagDay" f WHERE f.event = ${event} ORDER BY f."startsAt" DESC LIMIT 1
), '{}'::int[])))`;

/**
 * FROM and WHERE for the stickers the feed draws, narrowed by `and`: live, placed by an active user,
 * on an image anyone may see whose owner allows turf, not a contest entry. Aliases s, u, i and p.
 */
function drawnStickers(event: TurfEvent, now: Date, and: Prisma.Sql) {
  return Prisma.sql`FROM "EventTurfSticker" s
    JOIN "User" u ON u.id = s."userId"
    JOIN "Image" i ON i.id = s."imageId"
    JOIN "Post" p ON p.id = i."postId"
    WHERE s.event = ${event.name} AND ${and}
      AND s."removedAt" IS NULL ${unexpired(event, now)} AND ${imageVisible}
      AND u."bannedAt" IS NULL AND u."deletedAt" IS NULL
      AND NOT ${contestEntry(Prisma.sql`s."imageId"`, event.name)} AND ${ownerAllowsTurf(
    event.name
  )}`;
}

/** FROM and WHERE for `userId`'s own stickers the feed draws (drawnStickers). */
export function ownDrawnStickers(event: TurfEvent, userId: number, now: Date) {
  return drawnStickers(event, now, Prisma.sql`s."userId" = ${userId}`);
}

/**
 * Only stickers still counting at `now` (schedule.ts stickerLiveAfter): an expired sticker is neither
 * counted, credited nor drawn. Empty while none has expired.
 */
function unexpired(event: TurfEvent, now: Date) {
  const after = stickerLiveAfter(event.turf, now);
  return after ? Prisma.sql`AND s."createdAt" > ${after}` : Prisma.empty;
}

const configCache = new Map<string, { at: number; config: EventTurfConfig }>();

/** The event with its turf config, live override applied. Undefined when it has no turf. */
export async function getTurfEvent(name: string, now = new Date()): Promise<TurfEvent | undefined> {
  const def = (await loadEvents()).find((e) => e.name === name);
  if (!def?.turf || !def.scoring || !def.teams.length) return undefined;
  const cached = configCache.get(name);
  if (cached && now.getTime() - cached.at < CONFIG_TTL_MS) return { ...def, turf: cached.config };
  const raw = await sysRedis.get(turfConfigKey(name)).catch(() => null);
  const { config, invalid } = applyTurfOverride(def.turf, raw);
  if (invalid)
    void logToAxiom({
      type: 'warning',
      name: 'event-turf',
      message: 'override ignored',
      event: name,
    });
  configCache.set(name, { at: now.getTime(), config });
  return { ...def, turf: config };
}

export const isRunning = (event: TurfEvent, now: Date) =>
  event.turf.mode !== 'off' && now >= event.startDate && now < event.endDate;

// #region supply
// Live team totals per event, as the standings read them. One read per server per TTL, shared by
// every concurrent caller; a failed read means no catch-up until the next one.
const teamPointsCache = new Map<
  string,
  { at: number; points: Promise<Record<string, number> | null> }
>();

function cachedTeamPoints(event: TurfEvent, now: Date) {
  const cached = teamPointsCache.get(event.name);
  if (cached && now.getTime() - cached.at < TEAM_POINTS_TTL_MS) return cached.points;
  const points = getTeamPoints(event, now).catch((error: unknown) => {
    logSysRedisFailOpen('read-degraded', 'turf.cachedTeamPoints', error, { event: event.name });
    return null;
  });
  teamPointsCache.set(event.name, { at: now.getTime(), points });
  return points;
}

/**
 * Each team's multiplier on the catch-up curve `steps` now. 1 for every team when no step is in
 * force (no points read) or the points cannot be read, and for a name that is not one of the event's.
 */
async function teamCatchUp(event: TurfEvent, steps: CatchUpStep[] | undefined, now: Date) {
  const step = stepAt(steps ?? [], now);
  const points = step ? await cachedTeamPoints(event, now) : null;
  return (team: string) => {
    const own = event.teams.find((t) => t.toLowerCase() === team.toLowerCase());
    if (!step || !points || !own) return 1;
    const total = event.teams.reduce((sum, t) => sum + (points[t] ?? 0), 0);
    return catchUpMultiplier(step, points[own] ?? 0, total / event.teams.length);
  };
}

/** The supply multiplier for `team` now (see teamCatchUp). */
export async function turfCatchUpAt(event: TurfEvent, team: string | null | undefined, now: Date) {
  if (!team) return 1;
  return (await teamCatchUp(event, event.turf.catchUp, now))(team);
}

/**
 * Per event team, how many of its stickerers an action on an image it leads credits now: the
 * creditedPlayers step scaled by the team's creditedCatchUp, so a team far ahead credits fewer.
 * Forward-only: each ledger row keeps the players credited when the action happened.
 */
export async function turfCreditedByTeam(event: TurfEvent, now: Date) {
  const base = stepAt(event.turf.creditedPlayers, now)?.players ?? 0;
  const multiplier = await teamCatchUp(event, event.turf.creditedCatchUp, now);
  return Object.fromEntries(event.teams.map((t) => [t, scaleCredited(base, multiplier(t))]));
}

/**
 * A player's stock at `now`. `multiplier` (their team's catch-up, see turfCatchUpAt) scales every
 * step's rate and cap for the whole time since the last refill. A stock above a lowered cap is kept.
 */
export function turfSupplyAt(
  event: TurfEvent,
  row: { stock: number; refilledAt: Date } | null,
  now: Date,
  multiplier = 1
) {
  const supply = scaleSupply(event.turf.supply, multiplier);
  const step = stepAt(supply, now);
  const stock = row ? refillStock(row.stock, row.refilledAt, now, supply) : step?.cap ?? 0;
  return {
    stock,
    available: Math.floor(stock),
    nextAt: nextStickerAt(stock, now, step),
    perHour: step?.perHour ?? 0,
    cap: step?.cap ?? 0,
    creditedPlayers: stepAt(event.turf.creditedPlayers, now)?.players ?? 0,
  };
}

export async function getTurfStock(eventName: string, userId: number, now = new Date()) {
  const event = await getTurfEvent(eventName, now);
  if (!event) throw throwNotFoundError('This event has no turf');
  // Read only when a team's numbers can differ from another's.
  const scaled = [event.turf.catchUp, event.turf.creditedCatchUp].some((steps) =>
    stepAt(steps ?? [], now)
  );
  const userTeam = scaled ? event.getUserTeam(userId).catch(() => null) : null;
  const catchUp =
    userTeam && stepAt(event.turf.catchUp ?? [], now)
      ? userTeam.then((team) => turfCatchUpAt(event, team, now))
      : 1;
  const { kyselyRead } = await loadKyselyDb();
  const [row, [user], multiplier, creditedByTeam, team] = await Promise.all([
    dbRead.eventTurfStock.findUnique({
      where: { event_userId: { event: event.name, userId } },
      select: { stock: true, refilledAt: true },
    }),
    // Through Kysely, not Prisma's `$queryRaw` (see queryPrismaSql). Booleans and an int4 count.
    queryPrismaSql<{
      optedIn: boolean | null;
      left: boolean | null;
      ownerOff: boolean | null;
      liveHats: number | null;
    }>(
      kyselyRead,
      Prisma.sql`
      SELECT ${inTurf('u', event.name)} AS "optedIn",
        (u.settings -> ${TURF_SETTING} ->> ${event.name}) = 'false' AS "left",
        (u.settings -> ${TURF_OWNER_OFF_SETTING} ->> ${event.name}) = 'true' AS "ownerOff",
        (SELECT count(*)::int ${ownDrawnStickers(event, userId, now)}) AS "liveHats"
      FROM "User" u WHERE u.id = ${userId}
    `
    ),
    catchUp,
    turfCreditedByTeam(event, now),
    userTeam,
  ]);
  const { stock: _, ...supply } = turfSupplyAt(event, row, now, multiplier);
  const ownTeam = team && event.teams.find((t) => t.toLowerCase() === team.toLowerCase());
  return {
    ...supply,
    /** Per team, the stickerers an action on an image it leads credits; the badge reads the leader's. */
    creditedByTeam,
    /** The viewer's team's entry in creditedByTeam; the unscaled step for a viewer on no team. */
    creditedPlayers: ownTeam ? creditedByTeam[ownTeam] : supply.creditedPlayers,
    /** How long a sticker counts, so the viewer's own can show its time left (stickerExpiresAt). */
    expiry: event.turf.ttlHours
      ? { ttlHours: event.turf.ttlHours, rolloutAt: event.turf.rolloutAt ?? null }
      : null,
    /** The team's catch-up now: above 1 a trailing team refills faster and holds more, below 1 a leading one slower. */
    multiplier,
    mode: event.turf.mode,
    optedIn: !!user?.optedIn,
    /** Joined once and then left: they rejoin from the button, unprompted. */
    left: !!user?.left,
    ownerOff: !!user?.ownerOff,
    /** The viewer's hats still drawn (ownDrawnStickers): the event page links to them in the feed. */
    liveHats: user?.liveHats ?? 0,
  };
}
// #endregion

// #region place / remove
export type PlaceTurfStickerInput = {
  event: string;
  userId: number;
  imageId: number;
  cosmeticId: number;
  data: TurfStickerData;
  source?: 'feed' | 'image-detail';
};

/**
 * The checks every hat placement makes of the placer: Turf open to them, opted in, on a team, the
 * hat theirs and their team's. Returns the event, the team and its supply multiplier now.
 */
async function resolvePlacer(
  input: { event: string; userId: number; cosmeticId: number },
  now: Date
) {
  const event = await getTurfEvent(input.event, now);
  if (!event || !isRunning(event, now)) throw throwBadRequestError("Turf isn't open right now");
  const { userId } = input;
  if (event.turf.mode === 'shadow') {
    const testers = await flagAudienceAmong(event.turf.testerFlag, [userId]);
    if (!testers.has(userId)) throw throwAuthorizationError("Turf isn't open to you yet");
  }

  const [placer] = await dbWrite.$queryRaw<{ optedIn: boolean | null; team: string | null }[]>`
    SELECT ${inTurf('u', event.name)} AS "optedIn",
      (SELECT c.data ->> 'team' FROM "UserCosmetic" uc JOIN "Cosmetic" c ON c.id = uc."cosmeticId"
        WHERE uc."userId" = u.id AND uc."cosmeticId" = ${input.cosmeticId}
          AND c.type = 'ContentDecoration' AND c.data ->> 'event' = ${event.name}
        LIMIT 1) AS team
    FROM "User" u WHERE u.id = ${userId}
  `;
  if (!placer?.optedIn) throw throwBadRequestError('Join Hat Turf to place hat stickers');
  if (!placer.team) throw throwBadRequestError("You don't have that hat");
  const team = await event.getUserTeam(userId, { strict: true });
  if (!team) throw throwBadRequestError("You aren't on a team yet");
  // The art is the sticker, so it must be the team it scores for.
  // Case-insensitive, so a cosmetic spelled 'blue' still matches the event's 'Blue'.
  if (placer.team.toLowerCase() !== team.toLowerCase())
    throw throwBadRequestError("That hat isn't your team's");
  const multiplier = await turfCatchUpAt(event, team, now);
  return { event, team, multiplier };
}

/**
 * Locks the player's stock row inside `tx` and checks it holds `count` stickers, so two placements
 * never both spend the same sticker. A first placement creates the bucket full, so there is always a
 * row to lock. Throws when the stock is short. Returns `spend`, to call once the placement is
 * written: a placement refused on its insert has then spent nothing, whatever the transaction does.
 */
async function lockStock(
  tx: Prisma.TransactionClient,
  event: TurfEvent,
  userId: number,
  multiplier: number,
  now: Date,
  count = 1
) {
  const { stock: full } = turfSupplyAt(event, null, now, multiplier);
  await tx.$executeRaw`
    INSERT INTO "EventTurfStock" (event, "userId", stock, "refilledAt")
    VALUES (${event.name}, ${userId}, ${full}, ${now})
    ON CONFLICT (event, "userId") DO NOTHING
  `;
  const [row] = await tx.$queryRaw<{ stock: number; refilledAt: Date }[]>`
    SELECT stock, "refilledAt" FROM "EventTurfStock"
    WHERE event = ${event.name} AND "userId" = ${userId}
    FOR UPDATE
  `;
  const { stock } = turfSupplyAt(event, row ?? null, now, multiplier);
  if (stock < 1) throw throwBadRequestError('Out of hat stickers. They refill over time');
  if (stock < count) throw throwBadRequestError(`You have ${Math.floor(stock)} hat stickers left`);
  return {
    spend: () => tx.$executeRaw`
      UPDATE "EventTurfStock" SET stock = ${stock - count}, "refilledAt" = ${now}
      WHERE event = ${event.name} AND "userId" = ${userId}
    `,
  };
}

export async function placeTurfSticker(input: PlaceTurfStickerInput, now = new Date()) {
  const { event, team, multiplier } = await resolvePlacer(input, now);
  const { userId, imageId } = input;
  // Only while the Flag Race runs, so a normal placement pays no flag lookup otherwise.
  const { flags } = await readFlagRaceConfig(event.name);
  const flagDay = flags?.on ? await currentFlagDay(event.name, now) : undefined;
  if (flagDay?.imageIds.includes(imageId))
    throw throwBadRequestError('This image is a flag today: add hats with its flag buttons');

  const [image] = await dbWrite.$queryRaw<
    {
      ownerId: number;
      visible: boolean;
      contest?: boolean;
      ownerActive: boolean;
      ownerAllows: boolean;
    }[]
  >`
    SELECT i."userId" AS "ownerId",
      COALESCE(p.id IS NOT NULL AND ${imageVisible}, false) AS visible,
      ${contestEntry(Prisma.sql`i.id`, event.name)} AS contest,
      ${ownerActive} AS "ownerActive",
      ${ownerAllowsTurf(event.name)} AS "ownerAllows"
    FROM "Image" i JOIN "User" o ON o.id = i."userId"
    LEFT JOIN "Post" p ON p.id = i."postId"
    WHERE i.id = ${imageId}
  `;
  if (!image) throw throwNotFoundError('Image not found');
  if (!image.visible)
    throw throwBadRequestError('Hat stickers only go on images in a published post');
  if (image.contest) throw throwBadRequestError("Hat stickers don't go on contest entries");
  if (!image.ownerActive) throw throwBadRequestError("You can't put hat stickers on this image");
  if (!image.ownerAllows)
    throw throwBadRequestError('This creator keeps Hat Turf off their images');
  // The same refusals as a regular sticker: a block either way, or a suspended placer. Neither
  // applies to an owner's own image.
  if (image.ownerId !== userId)
    await assertCanPlace({ ownerId: image.ownerId, placerId: userId }).catch(() => {
      throw throwBadRequestError("You can't put hat stickers on this image");
    });

  try {
    await dbWrite.$transaction(async (tx) => {
      const { spend } = await lockStock(tx, event, userId, multiplier, now);
      const data = input.source ? { ...input.data, source: input.source } : input.data;
      // One sticker per player per image: an expired one is placed again in its row. A live or
      // removed one is left, and the create below refuses on the unique key.
      const liveAfter = stickerLiveAfter(event.turf, now);
      const renewed = liveAfter
        ? await tx.$executeRaw`
            UPDATE "EventTurfSticker"
            SET team = ${team}, "cosmeticId" = ${input.cosmeticId},
              data = ${JSON.stringify(data)}::jsonb, "createdAt" = ${now}
            WHERE event = ${event.name} AND "imageId" = ${imageId} AND "userId" = ${userId}
              AND "removedAt" IS NULL AND "createdAt" <= ${liveAfter}
          `
        : 0;
      if (!renewed)
        await tx.eventTurfSticker.create({
          data: {
            event: event.name,
            imageId,
            userId,
            team,
            cosmeticId: input.cosmeticId,
            data,
            createdAt: now,
          },
        });
      await spend();
    });
  } catch (error) {
    if (isPrismaUniqueViolation(error))
      throw throwBadRequestError("You've already put a hat sticker on this image");
    throw error;
  }
  void requestTurfSync(event, imageId).catch(logSyncError);
}

export const FLAG_HAT_COUNTS = [1, 5, 10] as const;

/**
 * Spends `count` hats on one of today's flags. Flags stack without limit and take hats on every
 * image, even one whose owner keeps Hat Turf off (entering the Crucible was the owner's consent).
 * Hats on a flag are spent for good and never count toward normal Turf. Refused after the cut.
 */
export async function placeFlagHats(
  input: {
    event: string;
    userId: number;
    isModerator?: boolean;
    imageId: number;
    cosmeticId: number;
    count: number;
  },
  now = new Date()
) {
  // Testers (and mods) only until the flag goes public at launch.
  const fliptKey = getFeatureFliptKey('flagRace');
  const open =
    !!fliptKey &&
    (await isFliptOnForTesters(fliptKey, { id: input.userId, isModerator: input.isModerator }));
  if (!open) throw throwBadRequestError("The Flag Race isn't open right now");
  if (!(FLAG_HAT_COUNTS as readonly number[]).includes(input.count))
    throw throwBadRequestError('Add 1, 5 or 10 hats at a time');
  const { flags } = await readFlagRaceConfig(input.event);
  if (!flags?.on) throw throwBadRequestError("The Flag Race isn't open right now");
  const { event, team, multiplier } = await resolvePlacer(input, now);
  const { userId, imageId, count } = input;
  const day = await currentFlagDay(event.name, now);
  if (!day?.imageIds.includes(imageId)) throw throwBadRequestError("This image isn't a flag today");
  if (now >= day.cutAt) throw throwBadRequestError('This flag has closed');
  // Only players eligible for event points count on a flag (flagTally): refuse the rest rather than
  // take hats that count for nobody.
  const [placer] = await dbWrite.$queryRaw<{ eligible: boolean }[]>`
    SELECT ${eventPlayerEligibleSql(
      event.startDate
    )} AS eligible FROM "User" u WHERE u.id = ${userId}
  `;
  if (!placer?.eligible) throw throwBadRequestError("Your account can't add hats to flags yet");

  const [image] = await dbWrite.$queryRaw<
    { ownerId: number; visible: boolean; ownerActive: boolean }[]
  >`
    SELECT i."userId" AS "ownerId",
      COALESCE(p.id IS NOT NULL AND ${imageVisible}, false) AS visible,
      ${ownerActive} AS "ownerActive"
    FROM "Image" i JOIN "User" o ON o.id = i."userId"
    LEFT JOIN "Post" p ON p.id = i."postId"
    WHERE i.id = ${imageId}
  `;
  if (!image?.visible || !image.ownerActive)
    throw throwBadRequestError("You can't put hats on this flag");
  if (image.ownerId !== userId)
    await assertCanPlace({ ownerId: image.ownerId, placerId: userId }).catch(() => {
      throw throwBadRequestError("You can't put hats on this flag");
    });

  await dbWrite.$transaction(async (tx) => {
    const { spend } = await lockStock(tx, event, userId, multiplier, now, count);
    await tx.$executeRaw`
      INSERT INTO "EventTurfFlagSticker"
        (event, "flagDayId", "imageId", "userId", team, "cosmeticId", count, "createdAt")
      VALUES (${event.name}, ${day.id}, ${imageId}, ${userId}, ${team}, ${input.cosmeticId},
        ${count}, ${now})
    `;
    await spend();
  });
  // The placer's own view: fresh, where the shared summary may lag by its TTL.
  const tally = await flagTally(event, day, dbWrite, imageId);
  return flagStanding(imageId, tally, flags.pot, now, false);
}

// Short: a placement doesn't clear it (on a busy flag it would never be warm), and the placer gets
// their flag's fresh counts back from the placement itself.
const FLAG_SUMMARY_TTL_S = 10;
// A frozen day never changes again, and the next swap clears the key.
const FLAG_SUMMARY_FROZEN_TTL_S = 300;

export type FlagStanding = {
  imageId: number;
  hatsByTeam: Record<string, number>;
  players: number;
  pot: number;
  // Once closed: the team or tied teams with the most hats at the cut, which the freeze pays.
  winners: string[];
};

export type FlagSummary = {
  flagDayId: number;
  closed: boolean;
  // Only once passed: before the cut, nobody may know when it falls.
  cutAt: Date | null;
  // The cut falls in the hour before this.
  closesAt: Date;
  flags: FlagStanding[];
};

// Cached with the cut beside it, so a hit is checked in memory: an open summary must not outlive
// the cut, and a hit must not cost a database read.
type CachedFlagSummary = { summary: FlagSummary; cutAtMs: number };

function flagStanding(
  imageId: number,
  tally: FlagTally,
  pot: FlagsConfig['pot'],
  at: Date,
  closed: boolean
): FlagStanding {
  const hatsByTeam = tally.hats.get(imageId) ?? {};
  const players = tally.players.get(imageId) ?? 0;
  return {
    imageId,
    hatsByTeam,
    players,
    pot: flagPot(pot, players, at).pot,
    winners: closed ? flagWinners(hatsByTeam) : [],
  };
}

/** Per flag of a frozen day, the teams its freeze paid (none when nobody placed); empty if not frozen. */
async function frozenFlagWinners(event: string, flagDayId: number) {
  const rows = await dbWrite.$queryRaw<{ sourceId: string; team: string | null }[]>`
    SELECT "sourceId", team FROM "EventAwardResult"
    WHERE event = ${event} AND kind = ${FLAG_KIND} AND "sourceId" LIKE ${`flag:${flagDayId}:%`}
  `;
  const winners = new Map<number, string[]>();
  for (const r of rows) {
    const imageId = Number(r.sourceId.split(':')[2]);
    const list = winners.get(imageId) ?? [];
    if (r.team) list.push(r.team);
    winners.set(imageId, list.sort());
  }
  return winners;
}

/**
 * Today's flags with their hat counts, for the home row's badges: the same for every viewer, so it
 * is cached briefly here and at the edge. The counts are flagTally's, which the freeze pays from.
 */
export async function getFlagSummary(
  eventName: string,
  now = new Date()
): Promise<FlagSummary | null> {
  const { flags: config } = await readFlagRaceConfig(eventName);
  if (!config?.on) return null;
  const key = flagSummaryKey(eventName);
  const fresh = async () => {
    const raw = await sysRedis.get(key).catch(() => null);
    if (!raw) return undefined;
    const cached = JSON.parse(raw) as CachedFlagSummary;
    return cached.summary.closed || now.getTime() < cached.cutAtMs ? cached.summary : undefined;
  };
  const hit = await fresh();
  if (hit) return hit;
  // One server rebuilds it at a time: the rest wait for its result rather than each running the
  // whole day's tally. A server that can't get the lock in time builds it itself.
  const locked = await withDistributedLock(
    { key: `flag-race-summary:${eventName}`, ttl: 5, retryDelay: 100, maxRetries: 10 },
    async () => ({
      summary: (await fresh()) ?? (await buildFlagSummary(eventName, config, key, now)),
    })
  );
  if (locked) return locked.summary;
  return (await fresh()) ?? buildFlagSummary(eventName, config, key, now);
}

async function buildFlagSummary(
  eventName: string,
  config: FlagsConfig,
  key: ReturnType<typeof flagSummaryKey>,
  now: Date
): Promise<FlagSummary | null> {
  const [event, day] = await Promise.all([
    getTurfEvent(eventName, now),
    currentFlagDay(eventName, now),
  ]);
  if (!event || !day) return null;
  const closed = now >= day.cutAt;
  // Closed, it must agree with the freeze: read the primary, as the freeze does, and name the teams
  // the freeze paid once it has run.
  const tally = await flagTally(event, day, closed ? dbWrite : dbRead);
  const paid = closed ? await frozenFlagWinners(eventName, day.id) : undefined;
  const at = closed ? day.cutAt : now;
  const summary: FlagSummary = {
    flagDayId: day.id,
    closed,
    cutAt: closed ? day.cutAt : null,
    closesAt: day.closesAt,
    flags: day.imageIds.map((imageId) => {
      const standing = flagStanding(imageId, tally, config.pot, at, closed);
      const frozen = paid?.get(imageId);
      return frozen ? { ...standing, winners: frozen } : standing;
    }),
  };
  const value: CachedFlagSummary = { summary, cutAtMs: day.cutAt.getTime() };
  const frozen = !!paid?.size;
  await sysRedis
    .set(key, JSON.stringify(value), {
      EX: frozen ? FLAG_SUMMARY_FROZEN_TTL_S : FLAG_SUMMARY_TTL_S,
    })
    .catch((error) =>
      logSysRedisFailOpen('write-degraded', 'turf.getFlagSummary', error, { event: eventName })
    );
  return summary;
}

// Longest the reactionEarns answer (a running sync and two Redis reads) takes before answering false.
export const REACTION_EARNS_MS = 1_500;

/**
 * Whether the viewer reacting to this image now would pay their team: what the reaction nudge shows
 * on, asked after a placement. Only drives the nudge, so a failed or slow read answers false.
 */
export async function getReactionEarns(
  { event: name, imageId, userId }: { event: string; imageId: number; userId: number },
  now = new Date(),
  { deadlineMs = REACTION_EARNS_MS } = {}
) {
  return withSysReadDeadline(
    (async () => {
      const event = await getTurfEvent(name, now);
      if (!event || !isRunning(event, now)) return false;
      // Shadow turf answers only its testers, as only they can place.
      if (event.turf.mode === 'shadow') {
        const testers = await flagAudienceAmong(event.turf.testerFlag, [userId]);
        if (!testers.has(userId)) return false;
      }
      // strict: a failed read of a hand-set team throws rather than answering for a guessed one.
      const team = await event.getUserTeam(userId, { strict: true });
      return reactionPaysTeam(event, imageId, userId, team);
    })(),
    deadlineMs
  ).catch((error) => {
    void logToAxiom({ type: 'error', name: 'event-turf', fn: 'getReactionEarns', error }).catch(
      () => undefined
    );
    return false;
  });
}

/**
 * Whether the placer reacting to this image would pay their own team, decided from what the award
 * reads (points/award.ts awardOne, awardTurf): a worn hat pays its owner's team unless the reactor
 * owns it; otherwise live turf pays the turf map entry's credited players, never the reactor. Read
 * from the map, not the stickers: until a sync writes it, a reaction scores on the old map, which
 * may name another team. Ignores the daily per-owner cap.
 */
async function reactionPaysTeam(event: TurfEvent, imageId: number, userId: number, team: string) {
  const rule = event.scoring?.types?.reaction;
  if (!rule?.entities.includes('Image') || !(await isEventPointsEnabled())) return false;
  const key = `Image:${imageId}`;
  const sameTeam = (other: string) => other.toLowerCase() === team.toLowerCase();
  const rawHat = await sysRedis.hGet(eventPointKeys(event.name).hats, key);
  const hat = rawHat ? decodeHat(rawHat) : undefined;
  if (hat) return sameTeam(hat.team) && hat.ownerId !== userId;
  if (event.turf.mode !== 'live') return false;
  // A sync still running on this server first, so a lead the placement just took is in the map. A
  // failed sync leaves the old map, which is still what a reaction scores on.
  await syncing.get(`${event.name}:${imageId}`)?.done.catch(() => undefined);
  const rawEntry = await sysRedis.hGet(turfKeys(event.name).map, key);
  const entry = rawEntry ? decodeTurfEntry(rawEntry) : undefined;
  return !!entry && sameTeam(entry.team) && entry.players.some((p) => p !== userId);
}

/** A moderator takes a sticker off. Final: the player cannot place on that image again. */
export async function removeTurfSticker(id: bigint, moderatorId: number) {
  const sticker = await dbWrite.eventTurfSticker.findUnique({
    where: { id },
    select: { event: true, imageId: true, removedAt: true },
  });
  if (!sticker) throw throwNotFoundError('Sticker not found');
  if (!sticker.removedAt)
    await dbWrite.eventTurfSticker.update({
      where: { id },
      data: { removedAt: new Date(), removedById: moderatorId },
    });
  const event = await getTurfEvent(sticker.event);
  if (event) void requestTurfSync(event, sticker.imageId).catch(logSyncError);
}

export async function setTurfOptIn(eventName: string, userId: number, optedIn: boolean) {
  const event = await getTurfEvent(eventName);
  if (!event) throw throwNotFoundError('This event has no turf');
  // A player cannot keep Hat Turf off their own images: joining needs the owner switch back on.
  if (optedIn) {
    const [user] = await dbWrite.$queryRaw<{ ownerOff: boolean | null }[]>`
      SELECT (settings -> ${TURF_OWNER_OFF_SETTING} ->> ${event.name}) = 'true' AS "ownerOff"
      FROM "User" WHERE id = ${userId}
    `;
    if (user?.ownerOff)
      throw throwBadRequestError('Let people play Hat Turf on your images to join');
  }
  // Only a real change writes, and `changed` says so: the opt-in analytics count each change once.
  const changed = await dbWrite.$executeRaw`
    UPDATE "User"
    SET settings = jsonb_set(
      COALESCE(settings, '{}'::jsonb) || jsonb_build_object(${TURF_SETTING}::text,
        COALESCE(settings -> ${TURF_SETTING}, '{}'::jsonb)),
      ARRAY[${TURF_SETTING}::text, ${event.name}::text], to_jsonb(${optedIn}::boolean))
    WHERE id = ${userId}
      AND (settings -> ${TURF_SETTING} ->> ${event.name}) IS DISTINCT FROM ${String(optedIn)}
  `;
  return { changed: changed > 0, event: event.name };
}

/**
 * The owner's "keep Hat Turf off my images" (`off`). Turning it off is refused while the user is in
 * Hat Turf, both up front for the message and in the write itself; turning it back on is always allowed.
 */
export async function setTurfOwnerOff(eventName: string, userId: number, off: boolean) {
  const event = await getTurfEvent(eventName);
  if (!event) throw throwNotFoundError('This event has no turf');
  const notJoined = off ? Prisma.sql`AND NOT ${inTurf('u', event.name)}` : Prisma.empty;
  if (off) {
    const [user] = await dbWrite.$queryRaw<{ optedIn: boolean | null }[]>`
      SELECT ${inTurf('u', event.name)} AS "optedIn" FROM "User" u WHERE u.id = ${userId}
    `;
    if (user?.optedIn) throw throwBadRequestError('Leave Hat Turf first');
  }
  const changed = await dbWrite.$executeRaw`
    UPDATE "User" u
    SET settings = jsonb_set(
      COALESCE(u.settings, '{}'::jsonb) || jsonb_build_object(${TURF_OWNER_OFF_SETTING}::text,
        COALESCE(u.settings -> ${TURF_OWNER_OFF_SETTING}, '{}'::jsonb)),
      ARRAY[${TURF_OWNER_OFF_SETTING}::text, ${event.name}::text], to_jsonb(${off}::boolean))
    WHERE u.id = ${userId}
      AND (u.settings -> ${TURF_OWNER_OFF_SETTING} ->> ${event.name}) IS DISTINCT FROM ${String(
    off
  )}
      ${notJoined}
  `;
  // Counts, the scoring map and pushes follow at once, not at the next reconcile. The switch is saved
  // by now, so a failed sync is logged and left to the reconcile, not reported as a failed save.
  if (changed > 0) await syncOwnerImages(event, userId).catch(logSyncError);
  return { changed: changed > 0, event: event.name };
}

/** Rewrites turf for every image of `ownerId` that has a live sticker, a batch at a time. */
async function syncOwnerImages(event: TurfEvent, ownerId: number) {
  for (let after = 0; ; ) {
    const rows = await dbWrite.$queryRaw<{ imageId: number }[]>`
      SELECT DISTINCT s."imageId" FROM "EventTurfSticker" s
      JOIN "Image" i ON i.id = s."imageId"
      WHERE s.event = ${event.name} AND i."userId" = ${ownerId} AND s."removedAt" IS NULL
        AND s."imageId" > ${after}
      ORDER BY s."imageId" LIMIT ${RECONCILE_IMAGE_BATCH}
    `;
    if (!rows.length) return;
    const ids = rows.map((row) => row.imageId);
    await syncTurfImages(event, ids);
    after = ids[ids.length - 1];
    if (rows.length < RECONCILE_IMAGE_BATCH) return;
  }
}
// #endregion

// #region map
type StickerRow = TurfStickerRow & {
  imageId: number;
  id: bigint;
  data: Prisma.JsonValue;
  art: TurfHatArt | null;
  // The feed draws it: the placer is not banned or deleted (getTurfStickersForImages' rule).
  drawable: boolean;
  // A contest entry: its stickers still score, but no push carries them or its counts.
  contest?: boolean;
};

// The live stickers (not removed, not expired) on images anyone may see (imageVisible) whose owner
// allows turf (ownerAllowsTurf), oldest first per image. The placer's opt-in is not read here: a
// placer who opts out leaves what they placed counting. A placer earns when eventPlayerEligibleSql
// says so. Read when the map is written, so credit is forward-only: a newly eligible placer
// counts from the next map write, and never for an action already recorded, since each ledger row
// names the players credited when the action happened.
function liveStickers(
  event: TurfEvent,
  where: Prisma.Sql,
  db: typeof dbRead | typeof dbWrite,
  now: Date
) {
  return db.$queryRaw<StickerRow[]>`
    SELECT s."imageId", s.id, s."userId", s.team, s."cosmeticId", s.data, s."createdAt",
      ${hatArt(Prisma.sql`s."cosmeticId"`)} AS art,
      (u."bannedAt" IS NULL AND u."deletedAt" IS NULL) AS drawable,
      ${contestEntry(Prisma.sql`s."imageId"`, event.name)} AS contest,
      ${eventPlayerEligibleSql(event.startDate)} AS eligible
    FROM "EventTurfSticker" s
    JOIN "User" u ON u.id = s."userId"
    JOIN "Image" i ON i.id = s."imageId"
    JOIN "Post" p ON p.id = i."postId"
    WHERE s.event = ${event.name} AND s."removedAt" IS NULL ${unexpired(event, now)}
      AND ${where} AND ${imageVisible} AND ${ownerAllowsTurf(event.name)}
    ORDER BY s."imageId", s."createdAt", s.id
  `;
}

async function teamCosmetics(event: TurfEvent) {
  const ids = new Map<string, number>();
  for (const team of event.teams) {
    const id = await event.getTeamCosmetic(team);
    if (id) ids.set(team, id);
  }
  return ids;
}

function computeImages(
  rows: StickerRow[],
  cosmetics: Map<string, number>,
  creditedByTeam: Record<string, number>,
  // Which images' feed stickers to pick: only a changed image is pushed.
  pickFor: (key: string, counts: TurfCounts) => boolean = () => true
) {
  const credited = (team: string) => creditedByTeam[team] ?? 0;
  const byImage = new Map<number, StickerRow[]>();
  for (const r of rows) {
    const list = byImage.get(r.imageId) ?? [];
    list.push(r);
    byImage.set(r.imageId, list);
  }
  const entries = new Map<string, TurfEntry>();
  const counts = new Map<string, TurfCounts>();
  const stickers = new Map<string, FeedSticker[]>();
  for (const [imageId, list] of byImage) {
    const key = `Image:${imageId}`;
    const result = computeImageTurf(list, credited, (team) => cosmetics.get(team));
    counts.set(key, result.counts);
    if (pickFor(key, result.counts)) stickers.set(key, pickFeedStickers(list));
    if (result.entry) entries.set(key, result.entry);
  }
  return { entries, counts, stickers };
}

// Per image (ARGV: ticket, then field, map value, counts value, rank value; '' = none): writes the map
// entry and counts only when the ticket is above the image's stamp, so an older read never lands after
// a newer one. Returns a code per image: 1 map changed, 2 counts changed, 4 stale (nothing written).
// The feed indexes (KEYS 4 on: hatted, rank total, then each team's rank in event.teams order) are
// rewritten on every write that lands, changed or not, so they hold what the counts hold and a
// reconcile, which writes every image in either, repairs them. The rank value is encodeTurfRank's; it carries the scores as strings, so the
// script does no arithmetic.
const WRITE_TURF_SCRIPT = `
local ticket = tonumber(ARGV[1])
local teams = #KEYS - 5
local out = {}
for i = 2, #ARGV, 4 do
  local f, mv, cv, rv = ARGV[i], ARGV[i + 1], ARGV[i + 2], ARGV[i + 3]
  local code = 0
  if ticket > tonumber(redis.call('HGET', KEYS[3], f) or '0') then
    redis.call('HSET', KEYS[3], f, ARGV[1])
    for j, v in ipairs({ mv, cv }) do
      local cur = redis.call('HGET', KEYS[j], f)
      if v == '' then
        if cur then redis.call('HDEL', KEYS[j], f) code = code + j end
      elseif cur ~= v then
        redis.call('HSET', KEYS[j], f, v) code = code + j
      end
    end
    local id = string.sub(f, 7)
    local hatted, ranks = false, {}
    for tok in string.gmatch(rv, '[^,]+') do
      if tok == 'h' then
        hatted = true
      else
        local k, score = string.match(tok, '^(%w+)=(%d+)$')
        if k then ranks[k] = score end
      end
    end
    if hatted then redis.call('SADD', KEYS[4], id) else redis.call('SREM', KEYS[4], id) end
    for t = 0, teams do
      local k = t == 0 and 't' or tostring(t)
      if ranks[k] then redis.call('ZADD', KEYS[5 + t], ranks[k], id)
      else redis.call('ZREM', KEYS[5 + t], id) end
    end
  else
    code = 4
  end
  out[#out + 1] = code
end
return out`;

/**
 * An image's feed index entry for WRITE_TURF_SCRIPT: `h` when it shows any live sticker, `t=` its
 * rank over every team's counted stickers, `<n>=` its rank for event.teams[n - 1]. Empty for a contest
 * entry, which the feed never ranks or filters on, since its viewers are shown no Hat Turf.
 */
export function encodeTurfRank(
  imageId: number,
  counts: TurfCounts | undefined,
  contest: boolean,
  teams: readonly string[]
) {
  if (!counts || contest) return '';
  const tokens: string[] = [];
  if (Object.values(counts.shown).some((n) => n > 0)) tokens.push('h');
  let total = 0;
  for (const [team, n] of Object.entries(counts.counted)) {
    if (n <= 0) continue;
    total += n;
    const index = teams.findIndex((t) => t.toLowerCase() === team.toLowerCase());
    if (index >= 0) tokens.push(`${index + 1}=${turfRankScore(n, imageId)}`);
  }
  if (total > 0) tokens.push(`t=${turfRankScore(total, imageId)}`);
  return tokens.join(',');
}

/**
 * Writes images' map entries, counts and feed indexes under one ticket (see WRITE_TURF_SCRIPT),
 * then logs the map changes: hash first, then the log, as the hat map does, since followers re-read
 * the hash for each logged key. Returns the keys whose map and whose counts changed.
 */
async function writeTurf(
  event: TurfEvent,
  ticket: number,
  fields: string[],
  map: Map<string, string>,
  counts: Map<string, string>,
  ranks: Map<string, string>
) {
  const keys = turfKeys(event.name);
  const mapChanged: string[] = [];
  const countsChanged: string[] = [];
  for (const part of chunk(fields, 500)) {
    const codes = (await sysRedis.eval(WRITE_TURF_SCRIPT, {
      keys: [
        keys.map,
        keys.counts,
        keys.stamp,
        keys.hatted,
        keys.rankTotal,
        ...event.teams.map((team) => keys.rankTeam(team)),
      ],
      arguments: [
        String(ticket),
        ...part.flatMap((k) => [k, map.get(k) ?? '', counts.get(k) ?? '', ranks.get(k) ?? '']),
      ],
    })) as number[];
    part.forEach((k, i) => {
      if (codes[i] & 1) mapChanged.push(k);
      if (codes[i] & 2) countsChanged.push(k);
    });
  }
  for (const part of chunk(mapChanged, 500))
    await Promise.all(part.map((k) => sysRedis.xAdd(keys.log, '*', { k, v: map.get(k) ?? '' })));
  if (mapChanged.length)
    await sysRedis.xTrim(keys.log, 'MAXLEN', MAP_LOG_MAX, { strategyModifier: '~' });
  return { mapChanged, countsChanged };
}

const turfRanks = (event: TurfEvent, counts: Map<string, TurfCounts>, contest: Set<number>) =>
  new Map(
    [...counts].map(([k, c]) => {
      const imageId = imageIdOf(k);
      return [k, encodeTurfRank(imageId, c, contest.has(imageId), event.teams)];
    })
  );

/** A ticket for a sync or reconcile about to read: one taken later reads newer stickers. */
const takeTicket = (event: TurfEvent) => sysRedis.incr(turfKeys(event.name).seq);

/** Recomputes some images' turf from their stickers and writes it through. */
export async function syncTurfImages(event: TurfEvent, imageIds: number[], now = new Date()) {
  if (!imageIds.length) return;
  const ticket = await takeTicket(event);
  // The primary: read right after a placement or removal, a lagging replica would miss it.
  const rows = await liveStickers(
    event,
    Prisma.sql`s."imageId" = ANY(${imageIds}::int[])`,
    dbWrite,
    now
  );
  const { entries, counts, stickers } = computeImages(
    rows,
    await teamCosmetics(event),
    await turfCreditedByTeam(event, now)
  );
  // Scoring keeps a contest entry's stickers; its viewers are told nothing.
  const contest = new Set(rows.filter((row) => row.contest).map((row) => row.imageId));
  const { countsChanged } = await writeTurf(
    event,
    ticket,
    imageIds.map((id) => `Image:${id}`),
    new Map([...entries].map(([k, e]) => [k, encodeTurfEntry(e)])),
    new Map([...counts].map(([k, c]) => [k, JSON.stringify(c)])),
    turfRanks(event, counts, contest)
  );
  const changes: TurfPush[] = countsChanged.map((k) => {
    const imageId = imageIdOf(k);
    const hidden = contest.has(imageId);
    return {
      imageId,
      counts: hidden ? null : counts.get(k) ?? null,
      stickers: hidden ? [] : stickers.get(k) ?? [],
    };
  });
  await pushTurfCounts(event.name, changes);
}

const imageIdOf = (k: string) => Number(k.slice('Image:'.length));

// One sync per image per pod: a request during one marks it dirty for a single re-run, which reads
// after every commit that asked. N concurrent placements on a hot image cost two reads, not N.
const syncing = new Map<string, { dirty: boolean; done: Promise<void> }>();

// A run that never settles would hold its image's entry forever, and every later request would
// wait on it. A timed-out run counts as failed; if it writes later, its older ticket is refused.
export const TURF_SYNC_TIMEOUT_MS = 30_000;
function withSyncTimeout(run: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('turf sync timed out')), TURF_SYNC_TIMEOUT_MS);
  });
  return Promise.race([run, timeout]).finally(() => clearTimeout(timer));
}

/** Syncs one image after a placement or removal, coalesced with any sync of it already running. */
export function requestTurfSync(event: TurfEvent, imageId: number): Promise<void> {
  const key = `${event.name}:${imageId}`;
  const running = syncing.get(key);
  if (running) {
    running.dirty = true;
    return running.done;
  }
  const state = { dirty: false, done: Promise.resolve() };
  syncing.set(key, state);
  state.done = (async () => {
    try {
      do {
        state.dirty = false;
        try {
          await withSyncTimeout(syncTurfImages(event, [imageId]));
        } catch (error) {
          // A request that arrived during the failed run still needs its re-run.
          if (!state.dirty) throw error;
          logSyncError(error);
        }
      } while (state.dirty);
    } finally {
      syncing.delete(key);
    }
  })();
  return state.done;
}

/** Rebuilds the whole turf map and counts for an event: hides, bans, expiry and cap changes. */
export async function reconcileTurf(event: TurfEvent, now = new Date()) {
  // First, so it pairs with `now`: each batch reads expiry at now + the time since (see below).
  const startedAt = Date.now();
  const cosmetics = await teamCosmetics(event);
  const creditedByTeam = await turfCreditedByTeam(event, now);
  const entries = new Map<string, TurfEntry>();
  const counts = new Map<string, TurfCounts>();
  const stickers = new Map<string, FeedSticker[]>();
  const contest = new Set<number>();
  const keys = turfKeys(event.name);
  // A snapshot only to choose which images to pick for; the write decides what is pushed. An
  // image that moved since did so by a sync, which pushed its stickers itself.
  const before = (await sysRedis.hGetAll(keys.counts)) ?? {};
  const changed = (key: string, c: TurfCounts) => JSON.stringify(c) !== before[key];
  // Each batch's ticket is taken just before its reads and covers its id range, so a sync that
  // started before that read loses to it (bans and hides land only here), and one after wins.
  const batches: { upTo: number; ticket: number }[] = [];
  let lastTicket = 0;
  let after = 0;
  // Each batch reads expiry at its own time, right after its ticket: with `now` fixed, a later
  // ticket could read an older cutoff than a sync written before it, and put back a sticker that
  // sync had dropped as expired.
  for (;;) {
    lastTicket = await takeTicket(event);
    const readAt = new Date(now.getTime() + Date.now() - startedAt);
    // Keyset over image ids through the live-sticker index, never a scan of Image. An image left
    // with only expired stickers is not read: it is cleared below, with every other gone field.
    const ids = await dbRead.$queryRaw<{ imageId: number }[]>`
      SELECT DISTINCT s."imageId" FROM "EventTurfSticker" s
      WHERE s.event = ${event.name} AND s."removedAt" IS NULL ${unexpired(event, readAt)}
        AND s."imageId" > ${after}
      ORDER BY s."imageId" LIMIT ${RECONCILE_IMAGE_BATCH}
    `;
    if (!ids.length) break;
    after = ids[ids.length - 1].imageId;
    batches.push({ upTo: after, ticket: lastTicket });
    const rows = await liveStickers(
      event,
      Prisma.sql`s."imageId" = ANY(${ids.map((r) => r.imageId)}::int[])`,
      dbRead,
      readAt
    );
    for (const row of rows) if (row.contest) contest.add(row.imageId);
    const part = computeImages(rows, cosmetics, creditedByTeam, changed);
    part.entries.forEach((v, k) => entries.set(k, v));
    part.counts.forEach((v, k) => counts.set(k, v));
    part.stickers.forEach((v, k) => stickers.set(k, v));
  }
  const { kept, dropped } = capTurfMap(entries, event.turf.mapMaxEntries);
  if (dropped)
    void logToAxiom({
      type: 'warning',
      name: 'event-turf',
      message: 'map at cap',
      dropped,
      event: event.name,
    });
  const desired = new Map([...kept].map(([k, e]) => [k, encodeTurfEntry(e)]));
  const desiredCounts = new Map([...counts].map(([k, c]) => [k, JSON.stringify(c)]));
  const ranks = turfRanks(event, counts, contest);
  // Read now, not at the start: an image a sync added during the reads is cleared if it has gone.
  // The feed indexes too, so an entry with no counts (written by an older script during a deploy)
  // is cleared as well.
  const indexed = [
    ...((await sysRedis.sMembers(keys.hatted)) ?? []),
    ...((await sysRedis.zRange(keys.rankTotal, 0, -1)) ?? []),
  ].map((id) => `Image:${String(id)}`);
  const fields = new Set([
    ...Object.keys((await sysRedis.hGetAll(keys.counts)) ?? {}),
    ...Object.keys((await sysRedis.hGetAll(keys.map)) ?? {}),
    ...indexed,
    ...desired.keys(),
    ...desiredCounts.keys(),
  ]);
  // Past the last batch, the final empty read's ticket.
  const ticketOf = (k: string) => batches.find((b) => imageIdOf(k) <= b.upTo)?.ticket ?? lastTicket;
  const byTicket = new Map<number, string[]>();
  for (const k of fields) {
    const t = ticketOf(k);
    const group = byTicket.get(t);
    if (group) group.push(k);
    else byTicket.set(t, [k]);
  }
  const mapChanged: string[] = [];
  const countsChanged: string[] = [];
  for (const [ticket, part] of byTicket) {
    const written = await writeTurf(event, ticket, part, desired, desiredCounts, ranks);
    mapChanged.push(...written.mapChanged);
    countsChanged.push(...written.countsChanged);
  }
  await pushTurfCounts(
    event.name,
    countsChanged.map((k) => {
      const imageId = imageIdOf(k);
      const c = counts.get(k);
      if (!c || contest.has(imageId)) return { imageId, counts: null, stickers: [] };
      return { imageId, counts: c, stickers: stickers.get(k) ?? null };
    })
  );
  const set = mapChanged.filter((k) => desired.has(k)).length;
  return { images: counts.size, turf: kept.size, dropped, set, removed: mapChanged.length - set };
}

// Apart from the reconcile so a failed swap can't stop the turf pass, and the next pass retries it.
async function swapFlagDayFor(event: TurfEvent, now: Date) {
  try {
    const { flags } = await readFlagRaceConfig(event.name);
    if (!flags) return;
    const before = await currentFlagDay(event.name, now);
    const day = await swapFlagDay(event, flags, now);
    // Today's flags lose their Turf (contestEntry) and yesterday's get it back: resync both now
    // rather than at the next reconcile, so no old hat earns on a flag in between.
    if (day)
      await syncTurfImages(
        event,
        [...new Set([...day.imageIds, ...(before?.imageIds ?? [])])],
        now
      );
  } catch (error) {
    void logToAxiom({ type: 'error', name: 'flag-race-swap', event: event.name, error }).catch(
      () => null
    );
  }
}

/**
 * Swaps in each running event's next flag day as soon as its flag Crucible has finished. Called by
 * the every-minute Crucible finalize job as well as the turf reconcile; a swap already made is a
 * no-op.
 */
export async function swapAllFlagDays(now = new Date()) {
  for (const def of await loadEvents()) {
    if (!def.turf || now < def.startDate || now >= def.endDate) continue;
    const event = await getTurfEvent(def.name, now);
    if (event) await swapFlagDayFor(event, now);
  }
}

/** Every event whose turf may still change: running, or in the finalize window after it. */
export async function reconcileAllTurf(now = new Date()) {
  const results = [];
  // Each event reconciles from when its turn comes, not when the run began (see reconcileTurf).
  const startedAt = Date.now();
  for (const def of await loadEvents()) {
    if (!def.turf || !def.scoring) continue;
    if (now < def.startDate || now > new Date(def.endDate.getTime() + def.scoring.finalizeAfterMs))
      continue;
    const event = await getTurfEvent(def.name, now);
    if (!event || event.turf.mode === 'off') continue;
    const at = new Date(now.getTime() + Date.now() - startedAt);
    const began = Date.now();
    const result = { event: def.name, ...(await reconcileTurf(event, at)), ms: 0 };
    result.ms = Date.now() - began;
    await swapFlagDayFor(event, at);
    // How long a pass takes as the event grows: it writes every image's feed indexes too.
    void logToAxiom({ type: 'info', name: 'event-turf', message: 'reconciled', ...result });
    results.push(result);
  }
  return results;
}
// #endregion

// #region reads
/**
 * Per-image counts and leader for a batch of images, plus the viewer's team. `hatted`: an event hat
 * protects the image, so its stickers earn nothing until the hat comes off; `hattedTeam` is that hat's
 * team. `open`: for every image asked about, whether it can take a new sticker now (visible; the
 * owner need not be in Hat Turf); owners may sticker their own. `mine`: whether the viewer has a
 * live or removed sticker on it, so cannot place again (an expired one is placed again). `hidden`: contest
 * entries, which show no Hat Turf at all (no counts, closed).
 */
export async function getTurfSummaries(
  eventName: string,
  askedIds: number[],
  viewerId?: number,
  now = new Date()
) {
  // Caller ids, bound as `int[]`: one past int4 would fail the whole statement (see isPgInt4). No
  // image has such an id, so it is answered like one never asked about.
  const imageIds = askedIds.filter(isPgInt4);
  const event = await getTurfEvent(eventName, now);
  if (!event || event.turf.mode === 'off' || !imageIds.length)
    return { team: null, images: {}, open: {}, mine: {}, hidden: {} };
  const keys = imageIds.map((id) => `Image:${id}`);
  const liveAfter = stickerLiveAfter(event.turf, now);
  const mineStillBlocks = liveAfter
    ? Prisma.sql`AND (s."removedAt" IS NOT NULL OR s."createdAt" > ${liveAfter})`
    : Prisma.empty;
  const { kyselyRead } = await loadKyselyDb();
  const [counts, hats, flags] = await Promise.all([
    sysRedis.hmGet(turfKeys(event.name).counts, keys),
    sysRedis.hmGet(eventPointKeys(event.name).hats, keys),
    // One statement for what were three (open, mine, contest entry), each answered per asked id by
    // the same predicate the separate reads applied, and through Kysely rather than Prisma's
    // `$queryRaw` (see queryPrismaSql). `mine` counts removed stickers too, since placing again
    // refuses them, but not expired ones, which placing renews.
    queryPrismaSql<{ id: number; open: boolean; mine: boolean; contest: boolean }>(
      kyselyRead,
      Prisma.sql`
      SELECT x.id,
        EXISTS (
          SELECT 1 FROM "Image" i
          JOIN "Post" p ON p.id = i."postId"
          WHERE i.id = x.id AND ${imageVisible} AND ${ownerAllowsTurf(event.name)}
        ) AS open,
        ${
          viewerId
            ? Prisma.sql`EXISTS (
          SELECT 1 FROM "EventTurfSticker" s
          WHERE s.event = ${event.name} AND s."userId" = ${viewerId}
            AND s."imageId" = x.id ${mineStillBlocks}
        )`
            : Prisma.sql`false`
        } AS mine,
        ${contestEntry(Prisma.sql`x.id`, event.name)} AS contest
      FROM unnest(${imageIds}::int[]) AS x(id)
    `
    ),
  ]);
  const hiddenIds = new Set(flags.filter((r) => r.contest).map((r) => r.id));
  const hidden = Object.fromEntries([...hiddenIds].map((id) => [id, true]));
  const mineIds = new Set(flags.filter((r) => r.mine).map((r) => r.id));
  const mine = Object.fromEntries(imageIds.map((id) => [id, mineIds.has(id)]));
  const openIds = new Set(flags.filter((r) => r.open).map((r) => r.id));
  const open = Object.fromEntries(
    imageIds.map((id) => [id, openIds.has(id) && !hiddenIds.has(id)])
  );
  const images: Record<number, TurfCounts & { hatted: boolean; hattedTeam: string | null }> = {};
  imageIds.forEach((id, i) => {
    if (counts[i] && !hiddenIds.has(id))
      images[id] = {
        ...(JSON.parse(counts[i]!) as TurfCounts),
        hatted: !!hats[i],
        hattedTeam: hats[i] ? decodeHat(hats[i]!)?.team ?? null : null,
      };
  });
  const team = viewerId ? await event.getUserTeam(viewerId).catch(() => null) : null;
  return { team: team ?? null, images, open, mine, hidden };
}

type DrawnSticker = {
  id: bigint;
  userId: number;
  team: string;
  cosmeticId: number;
  data: Prisma.JsonValue;
  art: TurfHatArt | null;
  createdAt: Date;
};

/**
 * One image's live stickers to draw: the most recent `renderLimit`, plus the viewer's own. Nothing
 * for an image outside a published post, and no sticker from a banned or deleted placer. `before`
 * pages back from a previous page's `nextCursor`; later pages leave `mine` null.
 */
export async function getTurfStickers(
  eventName: string,
  imageId: number,
  viewerId?: number,
  before?: { createdAt: string; id: bigint },
  now = new Date()
) {
  const event = await getTurfEvent(eventName, now);
  if (!event || event.turf.mode === 'off')
    return { stickers: [], mine: null, nextCursor: null, drawCeiling: DEFAULT_DRAW_CEILING };
  const rows = (only: Prisma.Sql, limit: number) => dbRead.$queryRaw<DrawnSticker[]>`
    SELECT s.id, s."userId", s.team, s."cosmeticId", s.data,
      ${hatArt(Prisma.sql`s."cosmeticId"`)} AS art, s."createdAt"
    FROM "EventTurfSticker" s
    JOIN "User" u ON u.id = s."userId"
    JOIN "Image" i ON i.id = s."imageId"
    JOIN "Post" p ON p.id = i."postId"
    WHERE s.event = ${event.name} AND s."imageId" = ${imageId} AND s."removedAt" IS NULL
      ${unexpired(event, now)}
      AND ${imageVisible} AND u."bannedAt" IS NULL AND u."deletedAt" IS NULL ${only}
      AND NOT ${contestEntry(Prisma.sql`s."imageId"`, event.name)} AND ${ownerAllowsTurf(
    event.name
  )}
    ORDER BY s."createdAt" DESC, s.id DESC
    LIMIT ${limit}
  `;
  const limit = event.turf.renderLimit;
  const at = before && new Date(before.createdAt);
  const olderThanCursor = before
    ? Prisma.sql`AND (s."createdAt", s.id) < (${at}::timestamptz, ${before.id}::bigint)`
    : Prisma.empty;
  const [page, mine] = await Promise.all([
    // One extra row says whether another page exists.
    rows(olderThanCursor, limit + 1),
    viewerId && !before ? rows(Prisma.sql`AND s."userId" = ${viewerId}`, 1) : [],
  ]);
  const stickers = page.slice(0, limit);
  const last = stickers[stickers.length - 1];
  const nextCursor: TurfStickersCursor | null =
    page.length > limit && last
      ? { createdAt: last.createdAt.toISOString(), id: last.id.toString() }
      : null;
  const drawCeiling = event.turf.drawCeiling ?? DEFAULT_DRAW_CEILING;
  return { stickers, mine: mine[0] ?? null, nextCursor, drawCeiling };
}

export type FeedSticker = {
  id: string;
  userId: number;
  team: string;
  cosmeticId: number;
  data: Prisma.JsonValue;
  art: TurfHatArt | null;
  // When it was placed, so a push reveals in placement order as a read does.
  createdAt: Date;
};

/**
 * getTurfStickersForImages' pick over one image's rows already read, so a push can carry what a feed
 * card would read back: drawable only, ranked as that SQL ranks. Change both or neither.
 */
export function pickFeedStickers(
  rows: readonly Pick<
    StickerRow,
    'id' | 'userId' | 'team' | 'cosmeticId' | 'data' | 'art' | 'createdAt' | 'drawable'
  >[],
  perImage = TURF_FEED_STICKERS
): FeedSticker[] {
  const newestFirst = rows
    .filter((r) => r.drawable)
    .sort(
      (a, b) =>
        b.createdAt.getTime() - a.createdAt.getTime() || (b.id > a.id ? 1 : b.id < a.id ? -1 : 0)
    );
  const seen = new Map<string, number>();
  const ranked = newestFirst.map((row) => {
    const teamRank = (seen.get(row.team) ?? 0) + 1;
    seen.set(row.team, teamRank);
    return { row, teamRank };
  });
  // sort is stable, so within one teamRank the newest-first order above stands.
  return ranked
    .filter((r) => r.teamRank <= perImage)
    .sort((a, b) => a.teamRank - b.teamRank)
    .slice(0, perImage)
    .map(({ row }) => ({
      id: String(row.id),
      userId: row.userId,
      team: row.team,
      cosmeticId: row.cosmeticId,
      data: row.data,
      art: row.art,
      createdAt: row.createdAt,
    }));
}

/**
 * Stickers to draw on a page of feed cards: per image, the latest sticker of each team first, then
 * the next most recent, up to `perImage`. Same visibility and placer rules as getTurfStickers.
 */
export async function getTurfStickersForImages(
  eventName: string,
  imageIds: number[],
  perImage: number,
  now = new Date()
) {
  const event = await getTurfEvent(eventName, now);
  if (!event || event.turf.mode === 'off' || !imageIds.length) return {};
  const rows = await dbRead.$queryRaw<(DrawnSticker & { imageId: number })[]>`
    WITH ranked AS (
      SELECT s.id, s."imageId", s."userId", s.team, s."cosmeticId", s.data, s."createdAt",
        row_number() OVER (PARTITION BY s."imageId", s.team ORDER BY s."createdAt" DESC, s.id DESC)
          AS "teamRank"
      ${drawnStickers(event, now, Prisma.sql`s."imageId" = ANY(${imageIds}::int[])`)}
    ), picked AS (
      SELECT id, "imageId", "userId", team, "cosmeticId", data, "createdAt", row_number() OVER (
        PARTITION BY "imageId" ORDER BY "teamRank", "createdAt" DESC, id DESC
      ) AS n
      FROM ranked
      WHERE "teamRank" <= ${perImage}
    )
    SELECT id, "imageId", "userId", team, "cosmeticId", data,
      ${hatArt(Prisma.sql`picked."cosmeticId"`)} AS art, "createdAt"
    FROM picked WHERE n <= ${perImage}
    ORDER BY "imageId", n
  `;
  const byImage: Record<number, DrawnSticker[]> = {};
  for (const { imageId, ...sticker } of rows) (byImage[imageId] ??= []).push(sticker);
  return byImage;
}

/** Marks images as on a viewer's screen, so changes to their counts are pushed (turf-watch.ts). */
export async function watchTurfImages(eventName: string, imageIds: number[]) {
  const event = await getTurfEvent(eventName);
  if (!event || event.turf.mode === 'off') return 0;
  const endsAt = new Date(event.endDate.getTime() + (event.scoring?.finalizeAfterMs ?? 0));
  return markTurfWatched({ name: event.name, endsAt }, imageIds);
}

/**
 * The event hats a player can use as sticker art: those they own of their current team (placing
 * refuses another team's, since the art is the sticker), with how often and when they last used
 * each, for "last used" and "most used" ordering.
 */
export async function getMyStickerHats(eventName: string, userId: number) {
  const event = await getTurfEvent(eventName);
  if (!event) throw throwNotFoundError('This event has no turf');
  // Strict, as placing is: a failed team lookup errors rather than offering a guessed team's hats.
  const team = await event.getUserTeam(userId, { strict: true });
  if (!team) return [];
  return dbRead.$queryRaw<
    { cosmeticId: number; art: TurfHatArt | null; usageCount: number; lastUsedAt: Date | null }[]
  >`
    SELECT uc."cosmeticId", ${hatArt(Prisma.sql`uc."cosmeticId"`)} AS art,
      count(s.id)::int AS "usageCount", max(s."createdAt") AS "lastUsedAt"
    FROM "UserCosmetic" uc
    JOIN "Cosmetic" c ON c.id = uc."cosmeticId"
    LEFT JOIN "EventTurfSticker" s
      ON s.event = ${event.name} AND s."userId" = uc."userId" AND s."cosmeticId" = uc."cosmeticId"
    WHERE uc."userId" = ${userId} AND c.type = 'ContentDecoration' AND c.data ->> 'event' = ${
    event.name
  }
      AND lower(c.data ->> 'team') = lower(${team})
    GROUP BY uc."cosmeticId"
    ORDER BY "lastUsedAt" DESC NULLS LAST, "usageCount" DESC, uc."cosmeticId"
  `;
}
// #endregion

function logSyncError(error: unknown) {
  void logToAxiom({ type: 'error', name: 'event-turf', fn: 'syncTurfImages', error }).catch(
    () => undefined
  );
}
