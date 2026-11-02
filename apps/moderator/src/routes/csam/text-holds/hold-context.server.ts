import { sql } from '@civitai/db/kysely';
import { dbRead } from '$lib/server/db';
import { getEntityCovers, type CsamHoldRow } from '$lib/server/csam-holds.queries';
import type { AppealCoverImage } from '$lib/server/minor-hash.service';
import { commentParents } from '$lib/server/user-account.service';
import {
  getProfilePictures,
  getProfiles,
  type ProfileMedia,
} from '$lib/server/user-lookup.service';
import type { HoldContext, HoldParent, HoldProfile } from './hold-context';

type HoldRef = Pick<CsamHoldRow, 'id' | 'entityType' | 'entityId' | 'commentModelId'>;

const toTile = (media: ProfileMedia, caption: string): AppealCoverImage | null =>
  media.id === undefined
    ? null
    : {
        id: media.id,
        url: media.url,
        type: media.type ?? undefined,
        nsfwLevel: media.nsfwLevel ?? 0,
        minor: media.minor ?? false,
        acceptableMinor: media.acceptableMinor ?? false,
        caption,
      };

async function profileContexts(userIds: number[]): Promise<Map<number, HoldProfile>> {
  const [profiles, avatars] = await Promise.all([
    getProfiles(userIds),
    getProfilePictures(userIds),
  ]);
  const found = new Map<number, HoldProfile>();
  for (const userId of userIds) {
    const profile = profiles.get(userId);
    const avatar = avatars.get(userId);
    if (!profile && !avatar) continue;
    const tiles = [
      avatar && toTile(avatar, 'Avatar'),
      profile?.coverImage && toTile(profile.coverImage, 'Cover'),
      profile?.sfwCoverImage && toTile(profile.sfwCoverImage, 'Cover (SFW)'),
    ].filter((tile): tile is AppealCoverImage => !!tile);
    found.set(userId, {
      bio: profile?.bio ?? null,
      message: profile?.message ?? null,
      sfwBio: profile?.sfwBio ?? null,
      sfwMessage: profile?.sfwMessage ?? null,
      location: profile?.location ?? null,
      // The SFW cover is often the same image as the cover.
      images: tiles.filter((tile, i) => tiles.findIndex((t) => t.id === tile.id) === i),
    });
  }
  return found;
}

type ParentRef = { type: string; id: number };
const parentKey = ({ type, id }: ParentRef) => `${type}:${id}`;

const idsOf = (refs: ParentRef[], type: string) => [
  ...new Set(refs.filter((r) => r.type === type).map((r) => r.id)),
];

/** Title and media for each parent, one read per type. A parent that cannot be read has no entry. */
async function parentDetails(refs: ParentRef[]): Promise<Map<string, HoldParent>> {
  const postIds = idsOf(refs, 'post');
  const modelIds = idsOf(refs, 'model');
  const imageIds = idsOf(refs, 'image');
  const articleIds = idsOf(refs, 'article');

  const [covers, posts, models, images, articles] = await Promise.all([
    getEntityCovers([
      ...postIds.map((id) => ({ type: 'Post', id })),
      ...modelIds.map((id) => ({ type: 'Model', id })),
    ]),
    postIds.length
      ? dbRead.selectFrom('Post').select(['id', 'title']).where('id', 'in', postIds).execute()
      : [],
    modelIds.length
      ? dbRead.selectFrom('Model').select(['id', 'name']).where('id', 'in', modelIds).execute()
      : [],
    imageIds.length
      ? dbRead
          .selectFrom('Image')
          .select([
            'id',
            'url',
            'nsfwLevel',
            sql<string>`type::text`.as('type'),
            'minor',
            'acceptableMinor',
          ])
          .where('id', 'in', imageIds)
          .execute()
      : [],
    articleIds.length
      ? dbRead
          .selectFrom('Article as a')
          .leftJoin('Image as i', 'i.id', 'a.coverId')
          .select([
            'a.id',
            'a.title',
            'i.id as coverId',
            'i.url',
            'i.nsfwLevel',
            sql<string | null>`i.type::text`.as('type'),
            'i.minor',
            'i.acceptableMinor',
          ])
          .where('a.id', 'in', articleIds)
          .execute()
      : [],
  ]);

  const found = new Map<string, HoldParent>();
  for (const { id, title } of posts) {
    const c = covers.get(`Post:${id}`);
    found.set(parentKey({ type: 'post', id }), {
      type: 'post',
      id,
      title,
      images: c?.images ?? [],
      imageTotal: c?.total ?? 0,
    });
  }
  for (const { id, name } of models) {
    const c = covers.get(`Model:${id}`);
    found.set(parentKey({ type: 'model', id }), {
      type: 'model',
      id,
      title: name,
      images: c?.images ?? [],
      imageTotal: c?.total ?? 0,
    });
  }
  for (const image of images)
    found.set(parentKey({ type: 'image', id: image.id }), {
      type: 'image',
      id: image.id,
      title: null,
      images: [image],
      imageTotal: 1,
    });
  for (const a of articles) {
    const cover =
      a.coverId !== null && a.url
        ? [
            {
              id: a.coverId,
              url: a.url,
              nsfwLevel: a.nsfwLevel ?? 0,
              type: a.type ?? undefined,
              minor: a.minor ?? false,
              acceptableMinor: a.acceptableMinor ?? false,
            },
          ]
        : [];
    found.set(parentKey({ type: 'article', id: a.id }), {
      type: 'article',
      id: a.id,
      title: a.title,
      images: cover,
      imageTotal: cover.length,
    });
  }
  return found;
}

/** A parent known only by its type and id: enough for a link when the thread points somewhere with no page we read. */
const bare = ({ type, id }: ParentRef): HoldParent => ({
  type,
  id,
  title: null,
  images: [],
  imageTotal: 0,
});

async function parentContexts(holds: HoldRef[]): Promise<Map<number, HoldParent>> {
  // `commentParents` reads `CommentV3`, which shares its ids with `CommentV2`, so it answers both.
  const isThreadComment = (hold: HoldRef) =>
    hold.entityType === 'CommentV2' || hold.entityType === 'CommentV3';
  const threadIds = holds.filter(isThreadComment).map((h) => h.entityId);
  const threads = threadIds.length ? await commentParents(threadIds) : new Map<number, ParentRef>();
  const refOf = (hold: HoldRef): ParentRef | null =>
    isThreadComment(hold)
      ? threads.get(hold.entityId) ?? null
      : hold.entityType === 'Comment' && hold.commentModelId
      ? { type: 'model', id: hold.commentModelId }
      : null;

  const refs = holds.flatMap((h) => refOf(h) ?? []);
  if (!refs.length) return new Map();
  const details = await parentDetails(refs);
  const parents = new Map<number, HoldParent>();
  for (const hold of holds) {
    const ref = refOf(hold);
    if (ref) parents.set(hold.id, details.get(parentKey(ref)) ?? bare(ref));
  }
  return parents;
}

/** Profile images and text, or a comment's parent, batched per type. Decoration: a failing read drops that context, not the page. */
export async function getHoldContexts(holds: HoldRef[]): Promise<Map<number, HoldContext>> {
  const profileHolds = holds.filter((h) => h.entityType === 'UserProfile');
  const commentHolds = holds.filter(
    (h) =>
      h.entityType === 'Comment' || h.entityType === 'CommentV2' || h.entityType === 'CommentV3'
  );
  const [profiles, parents] = await Promise.all([
    profileHolds.length
      ? profileContexts([...new Set(profileHolds.map((h) => h.entityId))]).catch((err) => {
          console.error('CSAM hold profiles failed', err);
          return new Map<number, HoldProfile>();
        })
      : new Map<number, HoldProfile>(),
    commentHolds.length
      ? parentContexts(commentHolds).catch((err) => {
          console.error('CSAM hold comment parents failed', err);
          return new Map<number, HoldParent>();
        })
      : new Map<number, HoldParent>(),
  ]);
  const contexts = new Map<number, HoldContext>();
  for (const h of profileHolds)
    contexts.set(h.id, { profile: profiles.get(h.entityId) ?? null, parent: null });
  for (const h of commentHolds)
    contexts.set(h.id, { profile: null, parent: parents.get(h.id) ?? null });
  return contexts;
}
