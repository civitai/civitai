import { Prisma } from '@prisma/client';
import { NsfwLevel } from '~/server/common/enums';
import type { Context } from '~/server/createContext';
import { dbRead } from '~/server/db/client';
import type { ImageMetadata, VideoMetadata } from '~/server/schema/media.schema';
import { parseVerifiedBotHeader, VERIFIED_BOT_HEADER } from '~/server/utils/bot-detection/header';
import { requestDomainBrowsingLevelCap } from '~/server/utils/browsing-level';
import { storedSourceImageIds } from '~/server/utils/source-image-ids';
import { imageVisibilityConditions } from '~/server/services/image-visibility.service';
import { Flags } from '~/shared/utils/flags';

type MediaFields = {
  url: string;
  nsfwLevel: number;
  metadata: ImageMetadata | VideoMetadata | null;
  user: { id: number };
};

/**
 * Whether a single-image response may carry the media: the request's domain cap on the image's own
 * rating, always allowed for the owner and moderators (`viewerCanSeeImageMedia` adds collection
 * managers). Not identical to `Gated`: it ignores a contest's forced level and withholds mixed
 * ratings.
 */
export function canViewImageMedia(
  ctx: Pick<Context, 'user' | 'features' | 'req'>,
  image: Pick<MediaFields, 'nsfwLevel' | 'user'>
) {
  if (ctx.user && (ctx.user.isModerator || ctx.user.id === image.user.id)) return true;
  const cap = requestDomainBrowsingLevelCap(ctx);
  // Under a cap, every bit of the rating must be inside it; unrated (0) and mixed ratings fail closed.
  return cap === undefined || (image.nsfwLevel !== 0 && Flags.hasFlag(cap, image.nsfwLevel));
}

/** Signed-out answers are edge-cached by URL alone; a crawler's must not be served to others. */
function keepCrawlerAnswerOutOfEdgeCache(
  ctx: Pick<Context, 'user' | 'req'> & Partial<Pick<Context, 'cache'>>
) {
  const verifiedBot = parseVerifiedBotHeader(ctx.req?.headers[VERIFIED_BOT_HEADER]);
  if (!ctx.user && verifiedBot !== null && ctx.cache) {
    ctx.cache.edgeTTL = 0;
    ctx.cache.browserTTL = 0;
    ctx.cache.staleWhileRevalidate = 0;
  }
}

/** The image with `url` null and external video ids dropped; blur hash, size and rating stay. */
export function withoutMedia<T extends MediaFields>(image: T): Omit<T, 'url'> & { url: null } {
  if (!image.metadata) return { ...image, url: null };
  const { youtubeVideoId, vimeoVideoId, ...metadata } = image.metadata as VideoMetadata;
  return { ...image, url: null, metadata };
}

/**
 * Whether the user holds MANAGE on the collection the image's post was submitted to. Only the
 * post's author (or a moderator) chooses that collection, so the post must also belong to the
 * image's owner. Membership of a collection does not count: anyone can create one, of any mode,
 * and add any image to it.
 */
export async function managesPostCollection({
  postId,
  imageOwnerId,
  userId,
}: {
  postId: number;
  imageOwnerId: number;
  userId: number;
}) {
  const rows = await dbRead.$queryRaw<{ managed: boolean }[]>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1 FROM "Post" p
      JOIN "CollectionContributor" cc ON cc."collectionId" = p."collectionId"
      WHERE p.id = ${postId}
        AND p."userId" = ${imageOwnerId}
        AND cc."userId" = ${userId}
        AND cc."permissions" && ARRAY['MANAGE']::"CollectionContributorPermission"[]
    ) AS managed
  `);
  return rows[0]?.managed ?? false;
}

export type MediaViewer = Pick<Context, 'user' | 'features' | 'req'> &
  Partial<Pick<Context, 'cache'>>;

/**
 * `canViewImageMedia` with the post-collection manager exemption `getImageHandler` grants, for an
 * image fetched by id. The collection lookup only runs when it could change the answer.
 */
export async function viewerCanSeeImageMedia(
  ctx: MediaViewer,
  image: { nsfwLevel: number; userId: number; postId: number | null }
) {
  const media = { nsfwLevel: image.nsfwLevel, user: { id: image.userId } };
  const canSee =
    canViewImageMedia(ctx, media) ||
    (!!ctx.user &&
      !!image.postId &&
      (await managesPostCollection({
        postId: image.postId,
        imageOwnerId: image.userId,
        userId: ctx.user.id,
      })));
  if (canSee) keepCrawlerAnswerOutOfEdgeCache(ctx);
  return canSee;
}

/**
 * Whether the viewer may see the media an image was generated from, judged by each recorded
 * source on its own (`meta.extra.sourceImageIds`): an edit can be rated below its source. A
 * source the viewer could not open (`image.get`'s rules), that is gone, or that is rated Blocked
 * counts as unseen except by its owner and moderators. The
 * image's owner made it from those sources and is not asked again. Sources the meta does not
 * record (uploads) can only be judged by the image's own rating.
 */
export async function viewerCanSeeSourceMedia(
  ctx: MediaViewer,
  image: { id: number; userId: number },
  meta: unknown
) {
  if (ctx.user && (ctx.user.isModerator || ctx.user.id === image.userId)) return true;
  const sourceIds = [...new Set(storedSourceImageIds(meta) ?? [])].filter((id) => id !== image.id);
  if (!sourceIds.length) return true;
  const sources = await dbRead.$queryRaw<{ nsfwLevel: number; userId: number }[]>(Prisma.sql`
    SELECT i."nsfwLevel", i."userId"
    FROM "Image" i
    LEFT JOIN "Post" p ON p.id = i."postId"
    WHERE ${Prisma.join(
      [
        Prisma.sql`i.id IN (${Prisma.join(sourceIds)})`,
        ...imageVisibilityConditions({ userId: ctx.user?.id, isModerator: ctx.user?.isModerator }),
      ],
      ' AND '
    )}
  `);
  if (sources.length < sourceIds.length) return false;
  if (ctx.user) {
    // image.get's other half: a source's owner may have blocked the viewer. Imported here, as in
    // assertImageVisibleToViewer: user.service sits in the image.service import cycle.
    const { amIBlockedByUser } = await import('~/server/services/user.service');
    const viewerId = ctx.user.id;
    const owners = [...new Set(sources.map((source) => source.userId))];
    for (const targetUserId of owners)
      if (await amIBlockedByUser({ userId: viewerId, targetUserId })) return false;
  }
  return sources.every(
    ({ nsfwLevel, userId }) =>
      ctx.user?.id === userId ||
      (nsfwLevel !== NsfwLevel.Blocked &&
        canViewImageMedia(ctx, { nsfwLevel, user: { id: userId } }))
  );
}

const BARE_URL = /^\s*(https?:\/\/|\/\/|data:)\S*\s*$/i;
const isMediaReference = (key: string, value: unknown) =>
  typeof value === 'string' && (key.toLowerCase() === 'url' || BARE_URL.test(value));
// Workflow graphs, usually stored as JSON text, carry their input media inside node values.
// `workflow` also names the generator workflow ('img2img:edit'), which is kept.
const isWorkflowGraph = (key: string, value: unknown) => {
  const name = key.toLowerCase();
  if (name.startsWith('comfy')) return true;
  if (name !== 'workflow') return false;
  return typeof value !== 'string' || /^\s*[[{]/.test(value);
};
const REMOVED = Symbol('removed');

function strip(value: unknown, key: string): unknown {
  if (isMediaReference(key, value) || isWorkflowGraph(key, value)) return REMOVED;
  if (Array.isArray(value))
    return value.map((item) => strip(item, '')).filter((item) => item !== REMOVED);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    // An image entry that loses its link goes whole, rather than as an input with no source.
    if (entries.some(([k, item]) => k.toLowerCase() === 'url' && isMediaReference(k, item)))
      return REMOVED;
    return stripEntries(entries);
  }
  return value;
}

const stripEntries = (entries: [string, unknown][]) =>
  Object.fromEntries(
    entries.map(([k, item]) => [k, strip(item, k)]).filter(([, item]) => item !== REMOVED)
  );

/**
 * Generation meta for a viewer who may not see the image's media: every entry holding a `url`,
 * every string that is only a link, and workflow graphs, at any depth. Source images (img2img,
 * img2vid, ControlNet, style references) are recorded that way.
 */
export function withoutMediaReferences<T extends object>(meta: T): T {
  return stripEntries(Object.entries(meta)) as T;
}
