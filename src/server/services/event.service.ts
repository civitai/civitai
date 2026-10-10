import { getTRPCErrorFromUnknown } from '@trpc/server';
import { pack } from 'msgpackr';
import { CacheTTL } from '~/server/common/constants';
import { dbRead, dbWrite } from '~/server/db/client';
import { getEntityCoverImage } from '~/server/services/image.service';
import type { EventDecorationData } from '~/shared/constants/event-decoration.constants';
import {
  getEventDecorationDefinition,
  isEventDecorationData,
} from '~/shared/constants/event-decoration.constants';
import {
  ArticleStatus,
  CosmeticEntity,
  ImageIngestionStatus,
  ModelStatus,
} from '~/shared/utils/prisma/enums';
import { eventEngine } from '~/server/events';
import type { EventViewer } from '~/server/events/event-access';
import {
  cosmeticCache,
  profilePictureCache,
  refreshOwnedStickerCache,
  userBasicCache,
} from '~/server/redis/caches';
import { redis, REDIS_KEYS, REDIS_SUB_KEYS } from '~/server/redis/client';
import { hSetWithTTL } from '~/server/redis/atomic';
import type {
  EventInput,
  TeamScoreHistoryInput,
  WornEventHatInput,
} from '~/server/schema/event.schema';
import type { CosmeticScoreKey } from '~/server/events/scoring/cosmetic-placement.service';
import {
  cosmeticScoreKey,
  getCosmeticScores,
  getEventStandings as getScoredEventStandings,
  getUserCosmeticScores,
} from '~/server/events/scoring/cosmetic-placement.service';
import { getCosmeticDetail } from '~/server/services/cosmetic.service';
import { cosmeticStatus, getCosmeticsForUsers } from '~/server/services/user.service';

// Every event read is gated on what the viewer may see (event-access.ts); a closed event reads as an
// unknown one.
type Viewer = { viewer: EventViewer };

export function getViewerEventAccess({ event, viewer }: EventInput & Viewer) {
  return eventEngine.getAccess(event, viewer);
}

export async function getEventData({ event, viewer }: EventInput & Viewer) {
  try {
    return await eventEngine.getEventData(event, viewer);
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}

export async function getTeamScores({ event, viewer }: EventInput & Viewer) {
  try {
    const access = await eventEngine.assertReadable(event, viewer);
    return await eventEngine.getTeamScores(event, access);
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}

export async function getTeamScoreHistory({ viewer, ...input }: TeamScoreHistoryInput & Viewer) {
  try {
    const access = await eventEngine.assertReadable(input.event, viewer);
    return await eventEngine.getTeamScoreHistory(input, access);
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}

type EventCosmetic = Awaited<ReturnType<typeof cosmeticStatus>> & {
  cosmetic: Awaited<ReturnType<typeof cosmeticCache.fetch>>[number] | null;
};
const noCosmetic = {
  available: false,
  obtained: false,
  equipped: false,
  data: {},
  cosmetic: null,
} as EventCosmetic;
export async function getEventCosmetic({
  event,
  user,
}: EventInput & { user: { id: number; isModerator?: boolean } }) {
  const userId = user.id;
  try {
    await eventEngine.assertReadable(event, user);
    const key = `${REDIS_KEYS.EVENT.CACHE}:${event}:${REDIS_SUB_KEYS.EVENT.COSMETICS}` as const;
    // TODO optimize, let's cache this to avoid multiple queries
    let userStatus = await redis.packed.hGet<
      Awaited<ReturnType<typeof cosmeticStatus>> & { cosmeticId: number }
    >(key, userId.toString());
    if (!userStatus) {
      const { cosmeticId } = await eventEngine.getUserData({ event, userId });
      if (!cosmeticId) return noCosmetic;

      const status = await cosmeticStatus({ id: cosmeticId, userId });
      userStatus = { ...status, cosmeticId };
      // Atomic packed-write: single EVAL replaces racy Promise.all([hSet, hExpire]).
      await hSetWithTTL(redis, key, userId.toString(), pack(userStatus), CacheTTL.hour * 1000);
    }

    const { cosmeticId } = userStatus;
    const cosmetic = (await cosmeticCache.fetch(cosmeticId))[cosmeticId];
    if (!cosmetic) return noCosmetic;

    return { ...userStatus, cosmetic } as EventCosmetic;
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}

export async function getEventPartners({ event, viewer }: EventInput & Viewer) {
  try {
    await eventEngine.assertReadable(event, viewer);
    return await eventEngine.getPartners(event);
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}

export async function activateEventCosmetic({
  event,
  user,
}: EventInput & { user: { id: number; isModerator?: boolean } }) {
  const userId = user.id;
  try {
    if (eventEngine.isJoinEvent(event)) {
      const { cosmeticId, team, joined } = await eventEngine.join(event, user);
      const cosmetic = await getCosmeticDetail({ id: cosmeticId });
      if (joined) {
        await redis.hDel(
          `${REDIS_KEYS.EVENT.CACHE}:${event}:${REDIS_SUB_KEYS.EVENT.COSMETICS}`,
          userId.toString()
        );
        await eventEngine.queueAddRole({ event, team, userId });
      }
      return { cosmetic };
    }

    // Get cosmetic
    const { cosmeticId, team } = await eventEngine.getUserData({ event, userId });
    if (!cosmeticId) throw new Error("You don't have a cosmetic for this event");
    const cosmetic = await getCosmeticDetail({ id: cosmeticId });
    if (!cosmetic) throw new Error("That cosmetic doesn't exist");

    // Update database
    const [{ data }] = (await dbWrite.$queryRaw<{ data: any }[]>`
      INSERT INTO "UserCosmetic" ("userId", "cosmeticId", "claimKey", "obtainedAt")
      VALUES (${userId}, ${cosmeticId}, ${event}, NOW())
      ON CONFLICT ("userId", "cosmeticId", "claimKey") DO UPDATE SET "equippedAt" = NOW()
      RETURNING data;
    `) ?? [{ data: {} }];

    await refreshOwnedStickerCache([userId]);

    const cacheKey =
      `${REDIS_KEYS.EVENT.CACHE}:${event}:${REDIS_SUB_KEYS.EVENT.COSMETICS}` as const;

    // Update cache — atomic packed-write replaces racy Promise.all([hSet, hExpire]).
    await hSetWithTTL(
      redis,
      cacheKey,
      userId.toString(),
      pack({
        equipped: true,
        available: true,
        obtained: true,
        data,
        cosmeticId,
      }),
      CacheTTL.hour * 1000
    );

    // Queue adding to role
    await eventEngine.queueAddRole({ event, team, userId });

    return { cosmetic };
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}

export async function donate({
  event,
  userId,
  amount,
}: EventInput & { userId: number; amount: number }) {
  try {
    const result = await eventEngine.donate(event, { userId, amount });
    return result;
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}

export async function getEventRewards({ event, viewer }: EventInput & Viewer) {
  try {
    await eventEngine.assertReadable(event, viewer);
    return await eventEngine.getRewards(event);
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}

export async function getEventContributors({ event, viewer }: EventInput & Viewer) {
  try {
    await eventEngine.assertReadable(event, viewer);
    const contributors = await eventEngine.getTopContributors(event);
    const userIdSet = new Set<number>();
    for (const team of Object.values(contributors.teams)) {
      for (const user of team) userIdSet.add(user.userId);
    }
    for (const user of contributors.allTime) userIdSet.add(user.userId);
    for (const user of contributors.day) userIdSet.add(user.userId);

    const userIds = Array.from(userIdSet);
    const users = await userBasicCache.fetch(userIds);
    const profilePictures = await profilePictureCache.fetch(userIds);
    const userCosmetics = await getCosmeticsForUsers(userIds);

    const userMap = new Map(
      Object.values(users).map((user) => [
        user.id,
        {
          ...user,
          profilePicture: profilePictures[user.id],
          cosmetics: userCosmetics[user.id] ?? [],
        },
      ])
    );

    return {
      allTime: contributors.allTime.map((user) => ({
        ...user,
        user: userMap.get(user.userId),
      })),
      day: contributors.day.map((user) => ({
        ...user,
        user: userMap.get(user.userId),
      })),
      teams: Object.fromEntries(
        Object.entries(contributors.teams).map(([team, users]) => [
          team,
          users.map((user) => ({ ...user, user: userMap.get(user.userId) })),
        ])
      ),
    };
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}

export async function getUserRank({
  event,
  user,
}: EventInput & { user: { id: number; isModerator?: boolean } }) {
  const userId = user.id;
  try {
    await eventEngine.assertReadable(event, user);
    const { team } = await eventEngine.getUserData({ event, userId });
    const { teams } = await eventEngine.getTopContributors(event);
    if (!teams[team]) return null;

    const teamRankingIndex = teams[team].findIndex((x) => x.userId === userId);
    return teamRankingIndex >= 0 ? teamRankingIndex + 1 : null;
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}

export async function getEventStandings({ event, viewer }: EventInput & Viewer) {
  try {
    const scored = await eventEngine.getReadableScoredEvent(event, viewer);
    const standings = await getScoredEventStandings(scored);
    const userIds = [
      ...new Set([
        ...standings.topCosmetics.map((x) => x.userId),
        ...Object.values(standings.topUsers).flatMap((x) => x.map((u) => u.userId)),
      ]),
    ];
    const [basicUsers, profilePictures, userCosmetics, cosmeticDetails, teamHats] =
      await Promise.all([
        userBasicCache.fetch(userIds),
        profilePictureCache.fetch(userIds),
        getCosmeticsForUsers(userIds),
        cosmeticCache.fetch([...new Set(standings.topCosmetics.map((x) => x.cosmeticId))]),
        // Decoration only: a failed lookup costs the hats, never the standings.
        eventEngine.getJoinHats(event).catch(() => [] as { team: string; url: string | null }[]),
      ]);
    // As getEventContributors: UserAvatar draws the avatar and its decoration from these two.
    const users = Object.fromEntries(
      Object.values(basicUsers).map((user) => [
        user.id,
        {
          ...user,
          profilePicture: profilePictures[user.id],
          cosmetics: userCosmetics[user.id] ?? [],
        },
      ])
    );
    // Name and art of each top cosmetic, so the page can show which hat earned it.
    const cosmetics = Object.fromEntries(
      Object.entries(cosmeticDetails).map(([id, c]) => {
        const url = (c.data as { url?: unknown } | null)?.url;
        return [id, { name: c.name, url: typeof url === 'string' ? url : null }];
      })
    );
    return { ...standings, users, cosmetics, teamHats };
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}

type CatalogRow = { design: string | null; team: string | null; name: string; url: string | null };

// Every design of this event's decorations in every team colour, for visitors deciding whether to
// join: the free join design and what is on sale now. Read access only: it shows art and names,
// never prices or the viewer's own team, and is edge-cached for anonymous visitors, so a design
// staged for a later drop must not appear until its shop item is available. "On sale" is the
// shop's own rule (getShopSectionsWithItems) plus availableFrom.
export async function getEventHatCatalog({ event, viewer }: EventInput & Viewer) {
  try {
    await eventEngine.assertReadable(event, viewer);
    const joinDesign = eventEngine.getJoinDesign(event) ?? null;
    // Two reads: as one correlated EXISTS the planner estimates one row and JITs the query.
    const onSale = await dbRead.$queryRaw<{ id: number }[]>`
      SELECT DISTINCT si."cosmeticId" AS id
      FROM "CosmeticShopItem" si
      WHERE si."cosmeticId" IS NOT NULL AND si.status = 'Published' AND si.listed
        AND si."archivedAt" IS NULL
        AND (si."availableFrom" IS NULL OR si."availableFrom" <= now())
        AND (si."availableTo" IS NULL OR si."availableTo" >= now())
        AND EXISTS (
          SELECT 1 FROM "CosmeticShopSectionItem" ssi
          JOIN "CosmeticShopSection" ss ON ss.id = ssi."shopSectionId"
          WHERE ssi."shopItemId" = si.id AND ss.published
        )
    `;
    // Official art only (createdById null), as the shop shows unflagged viewers.
    const rows = await dbRead.$queryRaw<CatalogRow[]>`
      SELECT c.data->>'design' AS design, c.data->>'team' AS team, c.name, c.data->>'url' AS url
      FROM "Cosmetic" c
      WHERE c.type = 'ContentDecoration' AND c.data->>'event' = ${event}
        AND c."createdById" IS NULL
        AND (c.data->>'design' = ${joinDesign} OR c.id = ANY(${onSale.map((r) => r.id)}::int[]))
      ORDER BY c.id
    `;
    const designs = new Map<
      string,
      { design: string; name: string; hats: { team: string; url: string }[] }
    >();
    for (const r of rows) {
      if (!r.design || !r.team || !r.url) continue;
      let entry = designs.get(r.design);
      if (!entry) {
        entry = { design: r.design, name: hatDesignName(r.name, r.team), hats: [] };
        designs.set(r.design, entry);
      }
      entry.hats.push({ team: r.team, url: r.url });
    }
    return [...designs.values()];
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}

// "Party Cap - Blue" is "Party Cap" in Blue.
const hatDesignName = (name: string, team: string) => {
  const suffix = ` - ${team}`;
  return name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
};

export async function getMyEventCosmeticScores({
  event,
  user,
}: EventInput & { user: { id: number; isModerator?: boolean } }) {
  try {
    const scored = await eventEngine.getReadableScoredEvent(event, user);
    const scores = await getUserCosmeticScores(scored, user.id);
    const details = await cosmeticCache.fetch([...new Set(scores.map((x) => x.cosmeticId))]);
    const cosmetics = scores.map((x) => ({ ...x, name: details[x.cosmeticId]?.name ?? null }));
    const points = cosmetics.reduce((sum, x) => sum + x.points, 0);
    return { points, cosmetics };
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}

type MyHatRow = {
  cosmeticId: number;
  claimKey: string;
  name: string;
  data: EventDecorationData;
  equippedToType: CosmeticEntity | null;
  equippedToId: number | null;
  placedAt: string | null;
};

// Every decoration of this event the caller owns, where it is worn, when it may move again, and what
// it has earned. Read from the primary: it is the caller's own state, read right after they buy or
// move a hat, and a lagging replica would show the hat where it was.
export async function getMyEventHats({
  event,
  user,
}: EventInput & { user: { id: number; isModerator?: boolean } }) {
  try {
    const scored = await eventEngine.getReadableScoredEvent(event, user);
    const definition = getEventDecorationDefinition(event);
    const rows = await dbWrite.$queryRaw<MyHatRow[]>`
      SELECT uc."cosmeticId", uc."claimKey", c.name, c.data,
        uc."equippedToType", uc."equippedToId", uc.data->>'placedAt' AS "placedAt"
      FROM "UserCosmetic" uc
      JOIN "Cosmetic" c ON c.id = uc."cosmeticId"
      WHERE uc."userId" = ${user.id}
        AND c.type = 'ContentDecoration'
        AND c.data->>'event' = ${event}
      ORDER BY uc."obtainedAt", uc."cosmeticId", uc."claimKey"
    `;
    const keys = rows.map((r) => ({
      userId: user.id,
      cosmeticId: r.cosmeticId,
      claimKey: r.claimKey,
    }));
    const placed = rows
      .filter((r) => r.equippedToType && r.equippedToId)
      .map((r) => ({ entityType: r.equippedToType!, entityId: r.equippedToId! }));
    const [scores, entities] = await Promise.all([
      getCosmeticScores(scored, keys),
      getPlaceableEntities(placed),
    ]);

    const now = Date.now();
    return rows.map((r) => {
      const placedAt = r.placedAt ? new Date(r.placedAt) : null;
      const movableAt =
        placedAt && definition ? new Date(placedAt.getTime() + definition.moveCooldownMs) : null;
      const score = scores[cosmeticScoreKey({ userId: user.id, ...r })];
      const entity =
        r.equippedToType && r.equippedToId
          ? entities.find((e) => e.entityType === r.equippedToType && e.entityId === r.equippedToId)
          : undefined;
      return {
        cosmeticId: r.cosmeticId,
        claimKey: r.claimKey,
        name: r.name,
        data: r.data,
        placedOn: entity ?? null,
        placedAt,
        movableAt,
        // Measured on the server's clock and capped at the cooldown, so the page can count it down
        // without comparing movableAt to a browser clock that may be minutes off.
        moveCooldownLeftMs:
          movableAt && definition
            ? Math.min(definition.moveCooldownMs, Math.max(0, movableAt.getTime() - now))
            : 0,
        points: score?.points ?? 0,
        impressions: (score?.impressions ?? 0) + (score?.anonImpressions ?? 0),
        reactions: score?.reactions ?? 0,
      };
    });
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}

// The caller's own content a hat of this event can go on, newest first, per allowed type.
export async function getPlaceableEventContent({
  event,
  user,
}: EventInput & { user: { id: number; isModerator?: boolean } }) {
  try {
    await eventEngine.assertReadable(event, user);
    const definition = getEventDecorationDefinition(event);
    if (!definition) return [];
    const types = new Set<CosmeticEntity>(definition.entityTypes);
    const [images, models, articles] = await Promise.all([
      types.has(CosmeticEntity.Image)
        ? dbRead.image.findMany({
            where: {
              userId: user.id,
              ingestion: ImageIngestionStatus.Scanned,
              post: { publishedAt: { not: null } },
            },
            select: { id: true },
            orderBy: { id: 'desc' },
            take: PLACEABLE_PER_TYPE,
          })
        : [],
      types.has(CosmeticEntity.Model)
        ? dbRead.model.findMany({
            where: { userId: user.id, status: ModelStatus.Published },
            select: { id: true },
            orderBy: { lastVersionAt: 'desc' },
            take: PLACEABLE_PER_TYPE,
          })
        : [],
      types.has(CosmeticEntity.Article)
        ? dbRead.article.findMany({
            where: { userId: user.id, status: ArticleStatus.Published },
            select: { id: true },
            orderBy: { publishedAt: 'desc' },
            take: PLACEABLE_PER_TYPE,
          })
        : [],
    ]);
    return getPlaceableEntities([
      ...images.map((x) => ({ entityType: CosmeticEntity.Image, entityId: x.id })),
      ...models.map((x) => ({ entityType: CosmeticEntity.Model, entityId: x.id })),
      ...articles.map((x) => ({ entityType: CosmeticEntity.Article, entityId: x.id })),
    ]);
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}

const PLACEABLE_PER_TYPE = 24;

// Title and cover image for each entity, in the order given. An entity with no usable cover (still
// scanning, or removed) is kept with a null image, so a worn hat never disappears from the list.
async function getPlaceableEntities(entities: { entityType: CosmeticEntity; entityId: number }[]) {
  if (!entities.length) return [];
  const modelIds = entities.filter((e) => e.entityType === 'Model').map((e) => e.entityId);
  const articleIds = entities.filter((e) => e.entityType === 'Article').map((e) => e.entityId);
  const [covers, models, articles] = await Promise.all([
    getEntityCoverImage({ entities }),
    modelIds.length
      ? dbRead.model.findMany({ where: { id: { in: modelIds } }, select: { id: true, name: true } })
      : [],
    articleIds.length
      ? dbRead.article.findMany({
          where: { id: { in: articleIds } },
          select: { id: true, title: true },
        })
      : [],
  ]);
  return entities.map(({ entityType, entityId }) => {
    const image = covers.find((c) => c.entityType === entityType && c.entityId === entityId);
    const title =
      entityType === 'Model'
        ? models.find((m) => m.id === entityId)?.name
        : entityType === 'Article'
        ? articles.find((a) => a.id === entityId)?.title
        : undefined;
    return { entityType, entityId, title: title ?? null, image: image ?? null };
  });
}

export async function getEventCosmeticScores({
  event,
  cosmetics,
  viewer,
}: EventInput & Viewer & { cosmetics: CosmeticScoreKey[] }) {
  try {
    const scored = await eventEngine.getReadableScoredEvent(event, viewer);
    return await getCosmeticScores(scored, cosmetics);
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}

type WornHatRow = {
  userId: number;
  cosmeticId: number;
  claimKey: string;
  name: string;
  data: unknown;
};

// The hat of this event worn on one piece of content, who wears it and what it has earned there, for
// the popover a click on a card's hat opens. Null when no hat of the event is on it, or when the
// content is not public: the answer is the same for every viewer and is edge-cached as such.
export async function getWornEventHat({
  event,
  entityType,
  entityId,
  viewer,
}: WornEventHatInput & Viewer) {
  try {
    const scored = await eventEngine.getReadableScoredEvent(event, viewer);
    const [row] = await dbRead.$queryRaw<WornHatRow[]>`
      SELECT uc."userId", uc."cosmeticId", uc."claimKey", c.name, c.data
      FROM "UserCosmetic" uc
      JOIN "Cosmetic" c ON c.id = uc."cosmeticId"
      WHERE uc."equippedToType" = ${entityType}::"CosmeticEntity"
        AND uc."equippedToId" = ${entityId}
        AND c.type = 'ContentDecoration'
        AND c.data->>'event' = ${event}
        AND CASE uc."equippedToType"
          WHEN 'Image' THEN EXISTS (
            SELECT 1 FROM "Image" i JOIN "Post" p ON p.id = i."postId"
            WHERE i.id = uc."equippedToId" AND p."publishedAt" <= now()
              AND p.availability <> 'Private' AND NOT p."tosViolation"
              AND i.ingestion = 'Scanned' AND i."needsReview" IS NULL AND NOT i."tosViolation"
          )
          WHEN 'Model' THEN EXISTS (
            SELECT 1 FROM "Model" m WHERE m.id = uc."equippedToId" AND m.status = 'Published'
              AND m.availability <> 'Private' AND NOT m."tosViolation"
          )
          WHEN 'Article' THEN EXISTS (
            SELECT 1 FROM "Article" a WHERE a.id = uc."equippedToId" AND a.status = 'Published'
              AND a.ingestion = 'Scanned' AND a.availability <> 'Private' AND NOT a."tosViolation"
          )
          ELSE false
        END
      ORDER BY uc."equippedAt" DESC NULLS LAST
      LIMIT 1
    `;
    if (!row || !isEventDecorationData(row.data)) return null;
    const team = row.data.team ?? null;
    const key = { userId: row.userId, cosmeticId: row.cosmeticId, claimKey: row.claimKey };
    const [users, profilePictures, scores] = await Promise.all([
      userBasicCache.fetch([row.userId]),
      profilePictureCache.fetch([row.userId]),
      getCosmeticScores(scored, [key]),
    ]);
    const owner = users[row.userId];
    const score = scores[cosmeticScoreKey(key)];
    return {
      cosmeticId: row.cosmeticId,
      name: team ? hatDesignName(row.name, team) : row.name,
      team,
      url: row.data.url,
      owner:
        owner && !owner.deletedAt
          ? {
              id: owner.id,
              username: owner.username,
              image: owner.image,
              profilePicture: profilePictures[owner.id] ?? null,
            }
          : null,
      points: score?.points ?? 0,
      impressions: (score?.impressions ?? 0) + (score?.anonImpressions ?? 0),
      reactions: score?.reactions ?? 0,
    };
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}
