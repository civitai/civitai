import { chunk } from 'lodash-es';
import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { flagAudienceAmong } from '~/server/events/event-access';
import { loadEvents } from '~/server/events/load-events';
import { eventPointKeys } from '~/server/events/points/keys';
import { diffHats } from '~/server/events/points/sync';
import {
  applyTurfOverride,
  turfConfigKey,
  TURF_SCORE_TIER_KEY,
  type EventTurfConfig,
} from '~/server/events/turf/config';
import { refillStock, stepAt } from '~/server/events/turf/schedule';
import {
  capTurfMap,
  computeImageTurf,
  encodeTurfEntry,
  turfKeys,
  type TurfCounts,
  type TurfEntry,
  type TurfStickerRow,
} from '~/server/events/turf/turf-map';
import { markTurfWatched, pushTurfCounts, type TurfPush } from '~/server/events/turf/turf-watch';
import { logToAxiom } from '~/server/logging/client';
import { assertCanPlace } from '~/server/services/placement-moderation.service';
import { sysRedis } from '~/server/redis/client';
import type { TurfStickerData, TurfStickersCursor } from '~/server/schema/turf.schema';
import {
  isPrismaUniqueViolation,
  throwAuthorizationError,
  throwBadRequestError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';

// The opt-in lives in User.settings, per event name: placing needs it, and only images of owners
// who have it are turf.
export const TURF_SETTING = 'eventTurfOptIn';

const CONFIG_TTL_MS = 30_000;
const MAP_LOG_MAX = 50_000;
const RECONCILE_IMAGE_BATCH = 2_000;

type LoadedEvents = Awaited<ReturnType<typeof loadEvents>>;
type EventDef = LoadedEvents[number];
export type TurfEvent = EventDef & { turf: EventTurfConfig };

// An image anyone may see: in a published, non-private post, scanned and not held or blocked.
// Placement and the sticker read both require it, so nothing is placed where it cannot be drawn.
const imageVisible = Prisma.sql`p."publishedAt" <= now() AND p.availability <> 'Private'
  AND i.ingestion = 'Scanned' AND NOT i."tosViolation" AND i."needsReview" IS NULL
  AND i."blockedFor" IS NULL`;

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

const isRunning = (event: TurfEvent, now: Date) =>
  event.turf.mode !== 'off' && now >= event.startDate && now < event.endDate;

// #region supply
export function turfSupplyAt(
  event: TurfEvent,
  row: { stock: number; refilledAt: Date } | null,
  now: Date
) {
  const step = stepAt(event.turf.supply, now);
  const stock = row
    ? refillStock(row.stock, row.refilledAt, now, event.turf.supply)
    : step?.cap ?? 0;
  return {
    stock,
    available: Math.floor(stock),
    perHour: step?.perHour ?? 0,
    cap: step?.cap ?? 0,
    creditedPlayers: stepAt(event.turf.creditedPlayers, now)?.players ?? 0,
  };
}

export async function getTurfStock(eventName: string, userId: number, now = new Date()) {
  const event = await getTurfEvent(eventName, now);
  if (!event) throw throwNotFoundError('This event has no turf');
  const [row, [user]] = await Promise.all([
    dbRead.eventTurfStock.findUnique({
      where: { event_userId: { event: event.name, userId } },
      select: { stock: true, refilledAt: true },
    }),
    dbRead.$queryRaw<{ optedIn: boolean | null }[]>`
      SELECT (settings -> ${TURF_SETTING} ->> ${event.name}) = 'true' AS "optedIn"
      FROM "User" WHERE id = ${userId}
    `,
  ]);
  const { stock: _, ...supply } = turfSupplyAt(event, row, now);
  return { ...supply, mode: event.turf.mode, optedIn: !!user?.optedIn };
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

export async function placeTurfSticker(input: PlaceTurfStickerInput, now = new Date()) {
  const event = await getTurfEvent(input.event, now);
  if (!event || !isRunning(event, now)) throw throwBadRequestError("Turf isn't open right now");
  const { userId, imageId } = input;
  if (event.turf.mode === 'shadow') {
    const testers = await flagAudienceAmong(event.turf.testerFlag, [userId]);
    if (!testers.has(userId)) throw throwAuthorizationError("Turf isn't open to you yet");
  }

  const [placer] = await dbWrite.$queryRaw<{ optedIn: boolean | null; team: string | null }[]>`
    SELECT (u.settings -> ${TURF_SETTING} ->> ${event.name}) = 'true' AS "optedIn",
      (SELECT c.data ->> 'team' FROM "UserCosmetic" uc JOIN "Cosmetic" c ON c.id = uc."cosmeticId"
        WHERE uc."userId" = u.id AND uc."cosmeticId" = ${input.cosmeticId}
          AND c.type = 'ContentDecoration' AND c.data ->> 'event' = ${event.name}
        LIMIT 1) AS team
    FROM "User" u WHERE u.id = ${userId}
  `;
  if (!placer?.optedIn)
    throw throwBadRequestError('Turn on "accept team hat stickers" to place hat stickers');
  if (!placer.team) throw throwBadRequestError("You don't have that hat");
  const team = await event.getUserTeam(userId, { strict: true });
  if (!team) throw throwBadRequestError("You aren't on a team yet");

  const [image] = await dbWrite.$queryRaw<
    { ownerId: number; visible: boolean; ownerOptedIn: boolean | null }[]
  >`
    SELECT i."userId" AS "ownerId",
      COALESCE(p.id IS NOT NULL AND ${imageVisible}, false) AS visible,
      (o.settings -> ${TURF_SETTING} ->> ${event.name}) = 'true' AS "ownerOptedIn"
    FROM "Image" i JOIN "User" o ON o.id = i."userId"
    LEFT JOIN "Post" p ON p.id = i."postId"
    WHERE i.id = ${imageId}
  `;
  if (!image) throw throwNotFoundError('Image not found');
  if (!image.visible)
    throw throwBadRequestError('Hat stickers only go on images in a published post');
  if (!image.ownerOptedIn) throw throwBadRequestError("This creator doesn't accept hat stickers");
  // The same refusals as a regular sticker: a block either way, or a suspended placer. Neither
  // applies to an owner's own image.
  if (image.ownerId !== userId)
    await assertCanPlace({ ownerId: image.ownerId, placerId: userId }).catch(() => {
      throw throwBadRequestError("You can't put hat stickers on this image");
    });

  try {
    await dbWrite.$transaction(async (tx) => {
      // A first placement creates the bucket full, so there is always a row to lock: two placements
      // must not both spend the same sticker.
      const { stock: full } = turfSupplyAt(event, null, now);
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
      const { stock } = turfSupplyAt(event, row ?? null, now);
      if (stock < 1) throw throwBadRequestError('Out of hat stickers. They refill over time');
      await tx.eventTurfSticker.create({
        data: {
          event: event.name,
          imageId,
          userId,
          team,
          cosmeticId: input.cosmeticId,
          data: input.source ? { ...input.data, source: input.source } : input.data,
          createdAt: now,
        },
      });
      await tx.$executeRaw`
        UPDATE "EventTurfStock" SET stock = ${stock - 1}, "refilledAt" = ${now}
        WHERE event = ${event.name} AND "userId" = ${userId}
      `;
    });
  } catch (error) {
    if (isPrismaUniqueViolation(error))
      throw throwBadRequestError("You've already put a hat sticker on this image");
    throw error;
  }
  void syncTurfImages(event, [imageId]).catch(logSyncError);
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
  if (event) void syncTurfImages(event, [sticker.imageId]).catch(logSyncError);
}

export async function setTurfOptIn(eventName: string, userId: number, optedIn: boolean) {
  const event = await getTurfEvent(eventName);
  if (!event) throw throwNotFoundError('This event has no turf');
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
// #endregion

// #region map
type StickerRow = TurfStickerRow & { imageId: number };

// The live stickers on images anyone may see (imageVisible), oldest first per image. The owner's opt-in only gates
// new placements: an opt-out leaves what was placed counting. A placer earns with an account from
// before the event start, or one that has since reached the Spark tier's threshold, read from its
// CreatorMilestone row so the tier stays the one source (compared as
// creatorScoreFromMeta: `meta.scores.total`, absent or non-numeric as 0), and is not banned, deleted
// or excluded. Read when the map is written, so credit is forward-only: a newly eligible placer
// counts from the next map write, and never for an action already recorded, since each ledger row
// names the players credited when the action happened.
function liveStickers(event: TurfEvent, where: Prisma.Sql, db: typeof dbRead | typeof dbWrite) {
  return db.$queryRaw<StickerRow[]>`
    SELECT s."imageId", s."userId", s.team, s."cosmeticId", s."createdAt",
      COALESCE(((u."createdAt" < ${event.startDate}
          OR CASE WHEN jsonb_typeof(u.meta -> 'scores' -> 'total') = 'number'
            THEN (u.meta -> 'scores' ->> 'total')::numeric ELSE 0 END >= (
              SELECT threshold FROM "CreatorMilestone" WHERE key = ${TURF_SCORE_TIER_KEY}
            ))
        AND u."bannedAt" IS NULL AND u."deletedAt" IS NULL
        AND NOT u."excludeFromLeaderboards"), false) AS eligible
    FROM "EventTurfSticker" s
    JOIN "User" u ON u.id = s."userId"
    JOIN "Image" i ON i.id = s."imageId"
    JOIN "Post" p ON p.id = i."postId"
    WHERE s.event = ${event.name} AND s."removedAt" IS NULL AND ${where} AND ${imageVisible}
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
  event: TurfEvent,
  rows: StickerRow[],
  cosmetics: Map<string, number>,
  now: Date
) {
  const credited = stepAt(event.turf.creditedPlayers, now)?.players ?? 0;
  const byImage = new Map<number, StickerRow[]>();
  for (const r of rows) {
    const list = byImage.get(r.imageId) ?? [];
    list.push(r);
    byImage.set(r.imageId, list);
  }
  const entries = new Map<string, TurfEntry>();
  const counts = new Map<string, TurfCounts>();
  for (const [imageId, list] of byImage) {
    const key = `Image:${imageId}`;
    const result = computeImageTurf(list, credited, (team) => cosmetics.get(team));
    counts.set(key, result.counts);
    if (result.entry) entries.set(key, result.entry);
  }
  return { entries, counts };
}

// Hash first, then the log, as the hat map does: followers re-read the hash for each logged key.
async function writeMap(
  event: TurfEvent,
  current: Record<string, string>,
  desired: Map<string, string>
) {
  const keys = turfKeys(event.name);
  const { set, remove } = diffHats(current, desired);
  for (const part of chunk(set, 500))
    await Promise.all(part.map(([k, v]) => sysRedis.hSet(keys.map, k, v)));
  for (const part of chunk(remove, 500))
    await Promise.all(part.map((k) => sysRedis.hDel(keys.map, k)));
  for (const part of chunk([...set, ...remove.map((k) => [k, ''] as const)], 500))
    await Promise.all(part.map(([k, v]) => sysRedis.xAdd(keys.log, '*', { k, v })));
  if (set.length || remove.length)
    await sysRedis.xTrim(keys.log, 'MAXLEN', MAP_LOG_MAX, { strategyModifier: '~' });
  return { set: set.length, removed: remove.length };
}

/** Recomputes some images' turf from their stickers and writes it through. */
export async function syncTurfImages(event: TurfEvent, imageIds: number[], now = new Date()) {
  if (!imageIds.length) return;
  // The primary: read right after a placement or removal, a lagging replica would miss it.
  const rows = await liveStickers(
    event,
    Prisma.sql`s."imageId" = ANY(${imageIds}::int[])`,
    dbWrite
  );
  const { entries, counts } = computeImages(event, rows, await teamCosmetics(event), now);
  const keys = imageIds.map((id) => `Image:${id}`);
  const values = await sysRedis.hmGet(turfKeys(event.name).map, keys);
  const current: Record<string, string> = {};
  keys.forEach((k, i) => {
    if (values[i]) current[k] = values[i]!;
  });
  const desired = new Map([...entries].map(([k, e]) => [k, encodeTurfEntry(e)]));
  await writeMap(event, current, desired);
  const countsKey = turfKeys(event.name).counts;
  const before = await sysRedis.hmGet(countsKey, keys);
  const changes: TurfPush[] = [];
  for (const [i, k] of keys.entries()) {
    const c = counts.get(k);
    const value = c ? JSON.stringify(c) : null;
    if (value === before[i]) continue;
    if (value) await sysRedis.hSet(countsKey, k, value);
    else await sysRedis.hDel(countsKey, k);
    changes.push({ imageId: imageIds[i], counts: c ?? null });
  }
  await pushTurfCounts(event.name, changes);
}

/** Rebuilds the whole turf map and counts for an event: hides, bans, opt-outs and cap changes. */
export async function reconcileTurf(event: TurfEvent, now = new Date()) {
  const cosmetics = await teamCosmetics(event);
  const entries = new Map<string, TurfEntry>();
  const counts = new Map<string, TurfCounts>();
  let after = 0;
  for (;;) {
    // Keyset over image ids through the live-sticker index, never a scan of Image.
    const ids = await dbRead.$queryRaw<{ imageId: number }[]>`
      SELECT DISTINCT "imageId" FROM "EventTurfSticker"
      WHERE event = ${event.name} AND "removedAt" IS NULL AND "imageId" > ${after}
      ORDER BY "imageId" LIMIT ${RECONCILE_IMAGE_BATCH}
    `;
    if (!ids.length) break;
    after = ids[ids.length - 1].imageId;
    const rows = await liveStickers(
      event,
      Prisma.sql`s."imageId" = ANY(${ids.map((r) => r.imageId)}::int[])`,
      dbRead
    );
    const part = computeImages(event, rows, cosmetics, now);
    part.entries.forEach((v, k) => entries.set(k, v));
    part.counts.forEach((v, k) => counts.set(k, v));
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
  const keys = turfKeys(event.name);
  const current = (await sysRedis.hGetAll(keys.map)) ?? {};
  const desired = new Map([...kept].map(([k, e]) => [k, encodeTurfEntry(e)]));
  const written = await writeMap(event, current, desired);
  const currentCounts = (await sysRedis.hGetAll(keys.counts)) ?? {};
  const desiredCounts = new Map([...counts].map(([k, c]) => [k, JSON.stringify(c)]));
  const countDiff = diffHats(currentCounts, desiredCounts);
  for (const part of chunk(countDiff.set, 500))
    await Promise.all(part.map(([k, v]) => sysRedis.hSet(keys.counts, k, v)));
  for (const part of chunk(countDiff.remove, 500))
    await Promise.all(part.map((k) => sysRedis.hDel(keys.counts, k)));
  const imageIdOf = (k: string) => Number(k.slice('Image:'.length));
  await pushTurfCounts(event.name, [
    ...countDiff.set.map(([k]) => ({ imageId: imageIdOf(k), counts: counts.get(k) ?? null })),
    ...countDiff.remove.map((k) => ({ imageId: imageIdOf(k), counts: null })),
  ]);
  return { images: counts.size, turf: kept.size, dropped, ...written };
}

/** Every event whose turf may still change: running, or in the finalize window after it. */
export async function reconcileAllTurf(now = new Date()) {
  const results = [];
  for (const def of await loadEvents()) {
    if (!def.turf || !def.scoring) continue;
    if (now < def.startDate || now > new Date(def.endDate.getTime() + def.scoring.finalizeAfterMs))
      continue;
    const event = await getTurfEvent(def.name, now);
    if (!event || event.turf.mode === 'off') continue;
    results.push({ event: def.name, ...(await reconcileTurf(event, now)) });
  }
  return results;
}
// #endregion

// #region reads
/**
 * Per-image counts and leader for a batch of images, plus the viewer's team. `hatted`: an event hat
 * protects the image, so its stickers earn nothing until the hat comes off. `open`: for every image
 * asked about, whether it can take a new sticker now (visible, owner opted in); owners may sticker
 * their own. `mine`: whether the viewer has already stickered it, so cannot again.
 */
export async function getTurfSummaries(eventName: string, imageIds: number[], viewerId?: number) {
  const event = await getTurfEvent(eventName);
  if (!event || event.turf.mode === 'off' || !imageIds.length)
    return { team: null, images: {}, open: {}, mine: {} };
  const keys = imageIds.map((id) => `Image:${id}`);
  const [counts, hats, openRows, mineRows] = await Promise.all([
    sysRedis.hmGet(turfKeys(event.name).counts, keys),
    sysRedis.hmGet(eventPointKeys(event.name).hats, keys),
    dbRead.$queryRaw<{ id: number }[]>`
      SELECT i.id FROM "Image" i
      JOIN "Post" p ON p.id = i."postId"
      JOIN "User" o ON o.id = i."userId"
      WHERE i.id = ANY(${imageIds}::int[]) AND ${imageVisible}
        AND (o.settings -> ${TURF_SETTING} ->> ${event.name}) = 'true'
    `,
    // Removed ones too: the unique key refuses a second sticker either way.
    viewerId
      ? dbRead.$queryRaw<{ imageId: number }[]>`
          SELECT "imageId" FROM "EventTurfSticker"
          WHERE event = ${event.name} AND "userId" = ${viewerId}
            AND "imageId" = ANY(${imageIds}::int[])
        `
      : [],
  ]);
  const mineIds = new Set(mineRows.map((r) => r.imageId));
  const mine = Object.fromEntries(imageIds.map((id) => [id, mineIds.has(id)]));
  const openIds = new Set(openRows.map((r) => r.id));
  const open = Object.fromEntries(imageIds.map((id) => [id, openIds.has(id)]));
  const images: Record<number, TurfCounts & { hatted: boolean }> = {};
  imageIds.forEach((id, i) => {
    if (counts[i]) images[id] = { ...(JSON.parse(counts[i]!) as TurfCounts), hatted: !!hats[i] };
  });
  const team = viewerId ? await event.getUserTeam(viewerId).catch(() => null) : null;
  return { team: team ?? null, images, open, mine };
}

type DrawnSticker = {
  id: bigint;
  userId: number;
  team: string;
  cosmeticId: number;
  data: Prisma.JsonValue;
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
  before?: { createdAt: string; id: bigint }
) {
  const event = await getTurfEvent(eventName);
  if (!event || event.turf.mode === 'off') return { stickers: [], mine: null, nextCursor: null };
  const rows = (only: Prisma.Sql, limit: number) => dbRead.$queryRaw<DrawnSticker[]>`
    SELECT s.id, s."userId", s.team, s."cosmeticId", s.data, s."createdAt"
    FROM "EventTurfSticker" s
    JOIN "User" u ON u.id = s."userId"
    JOIN "Image" i ON i.id = s."imageId"
    JOIN "Post" p ON p.id = i."postId"
    WHERE s.event = ${event.name} AND s."imageId" = ${imageId} AND s."removedAt" IS NULL
      AND ${imageVisible} AND u."bannedAt" IS NULL AND u."deletedAt" IS NULL ${only}
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
  return { stickers, mine: mine[0] ?? null, nextCursor };
}

/**
 * Stickers to draw on a page of feed cards: per image, the latest sticker of each team first, then
 * the next most recent, up to `perImage`. Same visibility and placer rules as getTurfStickers.
 */
export async function getTurfStickersForImages(
  eventName: string,
  imageIds: number[],
  perImage: number
) {
  const event = await getTurfEvent(eventName);
  if (!event || event.turf.mode === 'off' || !imageIds.length) return {};
  const rows = await dbRead.$queryRaw<(DrawnSticker & { imageId: number })[]>`
    WITH ranked AS (
      SELECT s.id, s."imageId", s."userId", s.team, s."cosmeticId", s.data, s."createdAt",
        row_number() OVER (PARTITION BY s."imageId", s.team ORDER BY s."createdAt" DESC, s.id DESC)
          AS "teamRank"
      FROM "EventTurfSticker" s
      JOIN "User" u ON u.id = s."userId"
      JOIN "Image" i ON i.id = s."imageId"
      JOIN "Post" p ON p.id = i."postId"
      WHERE s.event = ${event.name} AND s."imageId" = ANY(${imageIds}::int[])
        AND s."removedAt" IS NULL AND ${imageVisible}
        AND u."bannedAt" IS NULL AND u."deletedAt" IS NULL
    ), picked AS (
      SELECT id, "imageId", "userId", team, "cosmeticId", data, "createdAt", row_number() OVER (
        PARTITION BY "imageId" ORDER BY "teamRank", "createdAt" DESC, id DESC
      ) AS n
      FROM ranked
      WHERE "teamRank" <= ${perImage}
    )
    SELECT id, "imageId", "userId", team, "cosmeticId", data, "createdAt"
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
 * The event hats a player can use as sticker art (any they own; the team cap is one), with how often
 * and when they last used each, for "last used" and "most used" ordering.
 */
export async function getMyStickerHats(eventName: string, userId: number) {
  const event = await getTurfEvent(eventName);
  if (!event) throw throwNotFoundError('This event has no turf');
  return dbRead.$queryRaw<{ cosmeticId: number; usageCount: number; lastUsedAt: Date | null }[]>`
    SELECT uc."cosmeticId", count(s.id)::int AS "usageCount", max(s."createdAt") AS "lastUsedAt"
    FROM "UserCosmetic" uc
    JOIN "Cosmetic" c ON c.id = uc."cosmeticId"
    LEFT JOIN "EventTurfSticker" s
      ON s.event = ${event.name} AND s."userId" = uc."userId" AND s."cosmeticId" = uc."cosmeticId"
    WHERE uc."userId" = ${userId} AND c.type = 'ContentDecoration' AND c.data ->> 'event' = ${event.name}
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
