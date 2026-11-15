import { convert } from 'html-to-text';
import { kyselyRead, kyselyV3Read } from '~/server/db/kyselyDb';
import type {
  CsamContextSources,
  GetCsamContextCandidatesSchema,
} from '~/server/schema/csam.schema';
import { xmlSafe } from '~/server/services/ncmec-xml';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { getBaseUrl } from '~/server/utils/url-helpers';

/** Text posted with a report's images, copied when the report is filed. */
export type CsamContextText = {
  source: 'postDescription' | 'comment';
  /** The post's id for a description, the comment's otherwise. */
  id: number;
  postId?: number;
  imageId?: number;
  /** Moderators and Legal only: never sent. */
  authorId: number;
  authorIsReportedUser: boolean;
  postedAt: string;
  text: string;
  capturedAt: string;
  capturedById: number;
};

export type CsamContextCandidate = Omit<
  CsamContextText,
  'authorIsReportedUser' | 'capturedAt' | 'capturedById'
> & { deleted?: boolean; hidden?: boolean };

export type CsamContextPreview = CsamContextCandidate & {
  authorIsReportedUser: boolean;
  /** Characters in the full text, when `text` holds only its start. */
  fullLength?: number;
};

export const CSAM_CONTEXT_TEXT_MAX_CHARS = 50_000;
const CANDIDATE_COMMENT_LIMIT = 500;
const CANDIDATE_PREVIEW_CHARS = 2_000;

export const htmlToPlainText = (html: string) =>
  convert(html, {
    wordwrap: false,
    selectors: [
      { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
      { selector: 'img', format: 'skip' },
    ],
  }).trim();

type Scope = {
  imageIds: number[];
  ownerId?: number;
  postIds?: number[];
  commentIds?: number[];
};

async function readCandidates({
  imageIds,
  ownerId,
  postIds: onlyPosts,
  commentIds,
}: Scope): Promise<{ candidates: CsamContextCandidate[]; more: boolean }> {
  if (!imageIds.length) return { candidates: [], more: false };
  let imageQuery = kyselyRead
    .selectFrom('Image')
    .select(['id', 'postId'])
    .where('id', 'in', imageIds);
  if (ownerId !== undefined) imageQuery = imageQuery.where('userId', '=', ownerId);
  const images = await imageQuery.execute();
  const presentImageIds = images.map((i) => i.id);
  if (!presentImageIds.length) return { candidates: [], more: false };
  const postIds = [...new Set(images.map((i) => i.postId).filter((id): id is number => !!id))];

  const candidates: CsamContextCandidate[] = [];

  const describedPostIds = onlyPosts ? postIds.filter((id) => onlyPosts.includes(id)) : postIds;
  if (describedPostIds.length) {
    const posts = await kyselyRead
      .selectFrom('Post')
      .select(['id', 'detail', 'userId', 'createdAt', 'publishedAt'])
      .where('id', 'in', describedPostIds)
      .execute();
    // A post's storyline text items are part of its text, in reading order.
    const items = await kyselyRead
      .selectFrom('PostText')
      .select(['postId', 'content'])
      .where('postId', 'in', describedPostIds)
      .orderBy('index')
      .orderBy('id')
      .execute();
    const itemTexts = new Map<number, string[]>();
    for (const item of items) {
      const plain = htmlToPlainText(item.content);
      if (plain) itemTexts.set(item.postId, [...(itemTexts.get(item.postId) ?? []), plain]);
    }
    for (const post of posts) {
      const text = [
        post.detail ? htmlToPlainText(post.detail) : '',
        ...(itemTexts.get(post.id) ?? []),
      ]
        .filter(Boolean)
        .join('\n\n');
      if (!text) continue;
      candidates.push({
        source: 'postDescription',
        id: post.id,
        postId: post.id,
        authorId: post.userId,
        postedAt: new Date(post.publishedAt ?? post.createdAt).toISOString(),
        text,
      });
    }
  }

  if (commentIds?.length === 0) return { candidates, more: false };
  const limit = commentIds ? commentIds.length : CANDIDATE_COMMENT_LIMIT;

  const v3 = await kyselyV3Read
    .selectFrom('CommentV3')
    .select([
      'id',
      'entityType',
      'entityId',
      'userId',
      'content',
      'createdAt',
      'deletedAt',
      'hidden',
    ])
    .where((eb) => {
      const onPage = eb.or([
        eb.and([eb('entityType', '=', 'image'), eb('entityId', 'in', presentImageIds)]),
        ...(postIds.length
          ? [eb.and([eb('entityType', '=', 'post'), eb('entityId', 'in', postIds)])]
          : []),
      ]);
      return commentIds ? eb.and([onPage, eb('id', 'in', commentIds)]) : onPage;
    })
    .orderBy('id', 'desc')
    .limit(limit)
    .execute();

  for (const c of v3)
    candidates.push({
      source: 'comment',
      id: c.id,
      ...(c.entityType === 'post' ? { postId: c.entityId } : { imageId: c.entityId }),
      authorId: c.userId,
      postedAt: new Date(c.createdAt).toISOString(),
      text: htmlToPlainText(c.content),
      ...(c.deletedAt && { deleted: true }),
      ...(c.hidden && { hidden: true }),
    });
  return {
    candidates,
    more: !commentIds && v3.length === limit,
  };
}

/** The post descriptions and comments a moderator may attach to a report on these images. */
export async function getCsamContextCandidates({
  userId,
  imageIds,
}: GetCsamContextCandidatesSchema): Promise<{
  candidates: CsamContextPreview[];
  /** More comments exist than are listed. */
  more: boolean;
}> {
  const reportedUserIds = reportedUserIdsOf(userId, undefined);
  const { candidates, more } = await readCandidates({
    imageIds,
    ...(userId > 0 && { ownerId: userId }),
  });
  const previews = candidates
    .sort(
      (a, b) =>
        Number(b.source === 'postDescription') - Number(a.source === 'postDescription') ||
        b.postedAt.localeCompare(a.postedAt)
    )
    .map((candidate) => {
      const chars = Array.from(candidate.text);
      return {
        ...candidate,
        text: chars.slice(0, CANDIDATE_PREVIEW_CHARS).join(''),
        ...(chars.length > CANDIDATE_PREVIEW_CHARS && { fullLength: chars.length }),
        authorIsReportedUser: reportedUserIds.includes(candidate.authorId),
      };
    });
  return { candidates: previews, more };
}

/** Copies the chosen text, refusing any source outside the report's images. */
export async function snapshotCsamContextText({
  imageIds,
  ownerId,
  sources,
  reportedUserIds,
  capturedById,
  capturedAt = new Date(),
}: {
  imageIds: number[];
  /** The report's user: text on anyone else's images is refused. */
  ownerId?: number;
  sources: CsamContextSources;
  reportedUserIds: number[];
  capturedById: number;
  capturedAt?: Date;
}): Promise<CsamContextText[]> {
  const postIds = [...new Set(sources.postIds)];
  const commentIds = [...new Set(sources.commentIds)];
  if (!postIds.length && !commentIds.length) return [];

  const { candidates: found } = await readCandidates({ imageIds, ownerId, postIds, commentIds });
  const missing = [
    ...postIds.filter((id) => !found.some((c) => c.source === 'postDescription' && c.id === id)),
    ...commentIds.filter((id) => !found.some((c) => c.source === 'comment' && c.id === id)),
  ];
  if (missing.length)
    throwBadRequestError('Some selected text is not on the images in this report');

  return found.map(({ deleted, hidden, ...candidate }) => ({
    ...candidate,
    authorIsReportedUser: reportedUserIds.includes(candidate.authorId),
    capturedAt: capturedAt.toISOString(),
    capturedById,
  }));
}

/** The report's user and, when it names one, its secondary user. */
export function reportedUserIdsOf(userId: number, details: unknown) {
  const ids = userId > 0 ? [userId] : [];
  const secondary =
    details && typeof details === 'object' && 'secondaryUserId' in details
      ? Number((details as { secondaryUserId: unknown }).secondaryUserId)
      : NaN;
  if (Number.isInteger(secondary) && secondary > 0) ids.push(secondary);
  return ids;
}

/** Earlier captures are kept: a re-filing never replaces text already captured. */
export function foldContextText(prior: unknown, added: CsamContextText[] | undefined) {
  const kept = Array.isArray(prior) ? (prior as CsamContextText[]) : [];
  const key = (c: CsamContextText) => `${c.source}:${c.id}`;
  const seen = new Set(kept.map(key));
  const merged = kept.concat((added ?? []).filter((c) => !seen.has(key(c))));
  return merged.length ? merged : undefined;
}

const pad = (n: number) => String(n).padStart(2, '0');
export const formatUtc = (iso: string) => {
  const d = new Date(iso);
  return `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${d.getUTCFullYear()} ${pad(
    d.getUTCHours()
  )}:${pad(d.getUTCMinutes())} UTC`;
};

// The truncation line sits outside the quotes so it cannot be read as part of the posted text.
function quotedCapped(text: string) {
  const chars = Array.from(text);
  if (chars.length <= CSAM_CONTEXT_TEXT_MAX_CHARS) return `"${text}"`;
  const rest = chars.length - CSAM_CONTEXT_TEXT_MAX_CHARS;
  return `"${chars
    .slice(0, CSAM_CONTEXT_TEXT_MAX_CHARS)
    .join(
      ''
    )}"\n[Truncated: ${rest} further characters are preserved by Civitai with this report.]`;
}

const author = (c: CsamContextText) =>
  c.authorIsReportedUser ? 'the reported account' : 'another account';

function itemText(c: CsamContextText) {
  const heading =
    c.source === 'postDescription'
      ? `Post description, posted ${formatUtc(c.postedAt)} by ${author(c)}:`
      : `Comment ${c.id}, posted ${formatUtc(c.postedAt)} by ${author(c)}:`;
  return `${heading}\n${quotedCapped(c.text)}`;
}

/** The page incidents as NCMEC reads them once parsed: one per page and capture time. */
export function contextWebPageIncidents(contextText: CsamContextText[] | undefined) {
  if (!contextText?.length) return [];
  const base = getBaseUrl('red');
  const groups = new Map<string, { url: string; capturedAt: string; items: CsamContextText[] }>();
  for (const c of contextText) {
    const url = c.postId ? `${base}/posts/${c.postId}` : `${base}/images/${c.imageId}`;
    const key = `${url} ${c.capturedAt}`;
    const group = groups.get(key) ?? { url, capturedAt: c.capturedAt, items: [] };
    group.items.push(c);
    groups.set(key, group);
  }
  return [...groups.values()].map(({ url, capturedAt, items }) => {
    const ordered = [...items].sort(
      (a, b) =>
        Number(b.source === 'postDescription') - Number(a.source === 'postDescription') ||
        a.postedAt.localeCompare(b.postedAt) ||
        a.id - b.id
    );
    return {
      url,
      additionalInfo: xmlSafe(
        [
          `Text posted with the reported images on this page, captured by Civitai on ${formatUtc(
            capturedAt
          )}.`,
          ...ordered.map(itemText),
        ].join('\n\n')
      ),
    };
  });
}
