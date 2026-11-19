import { convert } from 'html-to-text';
import { kyselyRead, kyselyV3Read, kyselyWrite } from '~/server/db/kyselyDb';
import type {
  CsamContextSources,
  GetCsamContextCandidatesSchema,
} from '~/server/schema/csam.schema';
import { xmlSafe } from '~/server/services/ncmec-xml';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { getBaseUrl } from '~/server/utils/url-helpers';

/** How a held text came to be reviewed: the filing moderator's recorded read, or its hold decided on its own. */
export const CSAM_REVIEW_ORIGINS = ['filer-read', 'individual-decision'] as const;
export type CsamReviewOrigin = (typeof CSAM_REVIEW_ORIGINS)[number];

/** A held text's review: a moderator read it before filing, or decided its hold on its own. */
export type CsamContextReview = {
  byId: number;
  at: string;
  /** Missing on captures stored before it was recorded. */
  origin?: CsamReviewOrigin;
};

/** Text posted with a report's images, copied when the report is filed. */
export type CsamContextText = {
  /** `postText`: a held text item, captured with its post's text but on its own. */
  source: 'postDescription' | 'comment' | 'postText';
  /** The post's id for a description, the item's for a text item, the comment's otherwise. */
  id: number;
  postId?: number;
  imageId?: number;
  /** A text item's place in its post's reading order. */
  index?: number;
  /** Moderators and Legal only: never sent. */
  authorId: number;
  authorIsReportedUser: boolean;
  postedAt: string;
  text: string;
  capturedAt: string;
  capturedById: number;
  /** A text item without one is sent marked as not reviewed by Civitai. */
  reviewed?: CsamContextReview;
};

export type CsamContextCandidate = Omit<
  CsamContextText,
  'authorIsReportedUser' | 'capturedAt' | 'capturedById'
> & {
  deleted?: boolean;
  hidden?: boolean;
  /** A held text item's hold, or its text when it has none, last changed: a read before it does not count. */
  heldSince?: string;
};

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

/** The `ModActivity` a moderator's read of a held text item writes. */
export const CSAM_CONTEXT_TEXT_READ_ACTIVITY = 'csamContextTextRead';

type CsamHoldRow = {
  entityId: number;
  status: string;
  decidedById: number | null;
  decidedAt: Date | null;
  meta: unknown;
  createdAt: Date;
  updatedAt: Date;
};

/** Each item's newest Pending or Confirmed csam hold. */
async function latestCsamHolds(textIds: number[]) {
  const latest = new Map<number, CsamHoldRow>();
  if (!textIds.length) return latest;
  const rows = await kyselyWrite
    .selectFrom('TextScanHold')
    .select(['entityId', 'status', 'decidedById', 'decidedAt', 'meta', 'createdAt', 'updatedAt'])
    .where('entityType', '=', 'PostText')
    .where('label', '=', 'csam')
    .where('status', 'in', ['Pending', 'Confirmed'])
    .where('entityId', 'in', textIds)
    .orderBy('id', 'desc')
    .execute();
  for (const row of rows) if (!latest.has(row.entityId)) latest.set(row.entityId, row);
  return latest;
}

/**
 * A Confirmed hold counts as a review only when `decideCsamHold` marked it decided on its own:
 * a batched confirm, or one from before that mark, does not.
 */
function decisionReview(hold: CsamHoldRow): CsamContextReview | undefined {
  const meta = hold.meta as { reviewedDecision?: unknown } | null;
  if (hold.status !== 'Confirmed' || meta?.reviewedDecision !== true) return;
  if (!hold.decidedById || !hold.decidedAt) return;
  return {
    byId: hold.decidedById,
    at: new Date(hold.decidedAt).toISOString(),
    origin: 'individual-decision',
  };
}

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
    // A post's storyline text items are part of its text, in reading order. A held item is
    // captured on its own, so it can go out marked as not reviewed. Read on the primary, so a
    // hold the replica has not seen yet still splits its item out.
    const items = await kyselyWrite
      .selectFrom('PostText')
      .select(['id', 'postId', 'userId', 'index', 'content', 'csamHeld', 'createdAt', 'updatedAt'])
      .where('postId', 'in', describedPostIds)
      .orderBy('index')
      .orderBy('id')
      .execute();
    const holds = await latestCsamHolds(items.map((i) => i.id));
    const itemTexts = new Map<number, string[]>();
    const heldPosts = new Set<number>();
    const heldItems: CsamContextCandidate[] = [];
    for (const item of items) {
      const plain = htmlToPlainText(item.content);
      const hold = holds.get(item.id);
      if (item.csamHeld || hold) {
        heldPosts.add(item.postId);
        const reviewed = hold && decisionReview(hold);
        heldItems.push({
          source: 'postText',
          id: item.id,
          postId: item.postId,
          index: item.index,
          authorId: item.userId,
          postedAt: new Date(item.createdAt).toISOString(),
          text: plain,
          heldSince: new Date(
            hold ? Math.max(+hold.createdAt, +hold.updatedAt) : +item.updatedAt
          ).toISOString(),
          ...(reviewed && { reviewed }),
        });
      } else if (plain) itemTexts.set(item.postId, [...(itemTexts.get(item.postId) ?? []), plain]);
    }
    for (const post of posts) {
      const text = [
        post.detail ? htmlToPlainText(post.detail) : '',
        ...(itemTexts.get(post.id) ?? []),
      ]
        .filter(Boolean)
        .join('\n\n');
      // A post holding only held text is still offered, so ticking it captures that text.
      if (!text && !heldPosts.has(post.id)) continue;
      candidates.push({
        source: 'postDescription',
        id: post.id,
        postId: post.id,
        authorId: post.userId,
        postedAt: new Date(post.publishedAt ?? post.createdAt).toISOString(),
        text,
      });
    }
    const offered = new Set(candidates.map((c) => c.postId));
    candidates.push(...heldItems.filter((item) => offered.has(item.postId)));
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
  const rank = (c: CsamContextCandidate) =>
    c.source === 'postDescription' ? 2 : c.source === 'postText' ? 1 : 0;
  const previews = candidates
    .sort(
      (a, b) =>
        rank(b) - rank(a) ||
        (a.source === 'postText' && b.source === 'postText'
          ? (a.postId ?? 0) - (b.postId ?? 0) || (a.index ?? 0) - (b.index ?? 0)
          : b.postedAt.localeCompare(a.postedAt))
    )
    .map(({ heldSince, ...candidate }) => {
      // A held item's words are shown only through `readHeldCsamContextText`, which records the read.
      const chars = candidate.source === 'postText' ? [] : Array.from(candidate.text);
      return {
        ...candidate,
        text: chars.slice(0, CANDIDATE_PREVIEW_CHARS).join(''),
        ...(chars.length > CANDIDATE_PREVIEW_CHARS && { fullLength: chars.length }),
        authorIsReportedUser: reportedUserIds.includes(candidate.authorId),
      };
    });
  return { candidates: previews, more };
}

/**
 * A held text item's full words, for a moderator filing a report on these images, recording the
 * read: only such a read by the filing moderator marks the item reviewed when the report is filed.
 */
export async function readHeldCsamContextText({
  userId,
  imageIds,
  postTextId,
  moderatorId,
}: GetCsamContextCandidatesSchema & { postTextId: number; moderatorId: number }) {
  const [text] = await kyselyWrite
    .selectFrom('PostText')
    .select('postId')
    .where('id', '=', postTextId)
    .execute();
  const { candidates } = text
    ? await readCandidates({
        imageIds,
        ...(userId > 0 && { ownerId: userId }),
        postIds: [text.postId],
        commentIds: [],
      })
    : { candidates: [] };
  const held = candidates.find((c) => c.source === 'postText' && c.id === postTextId);
  if (!held) throwBadRequestError('This text is not held text on the images in this report');

  const [read] = await kyselyWrite
    .insertInto('ModActivity')
    .values({
      userId: moderatorId,
      activity: CSAM_CONTEXT_TEXT_READ_ACTIVITY,
      entityType: 'PostText',
      entityId: postTextId,
    })
    .returning('createdAt')
    .execute();
  return { id: postTextId, text: held!.text, readAt: new Date(read.createdAt).toISOString() };
}

/** Each held item's newest read by this moderator after it was held and by `before`. */
async function readsBy(
  moderatorId: number,
  items: CsamContextCandidate[],
  before: Date
): Promise<Map<number, CsamContextReview>> {
  const reads = new Map<number, CsamContextReview>();
  if (!items.length) return reads;
  const rows = await kyselyWrite
    .selectFrom('ModActivity')
    .select(['entityId', 'createdAt'])
    .where('userId', '=', moderatorId)
    .where('activity', '=', CSAM_CONTEXT_TEXT_READ_ACTIVITY)
    .where('entityType', '=', 'PostText')
    .where(
      'entityId',
      'in',
      items.map((i) => i.id)
    )
    .where('createdAt', '<=', before)
    .orderBy('createdAt', 'desc')
    .execute();
  for (const row of rows) {
    const item = items.find((i) => i.id === row.entityId);
    if (!item || row.entityId === null || reads.has(row.entityId)) continue;
    if (item.heldSince && new Date(row.createdAt) < new Date(item.heldSince)) continue;
    reads.set(row.entityId, {
      byId: moderatorId,
      at: new Date(row.createdAt).toISOString(),
      origin: 'filer-read',
    });
  }
  return reads;
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

  const reads = await readsBy(
    capturedById,
    found.filter((c) => c.source === 'postText' && !c.reviewed),
    capturedAt
  );
  return found
    .filter((c) => c.source !== 'postDescription' || c.text)
    .map(({ deleted, hidden, heldSince, ...candidate }) => {
      const reviewed = candidate.reviewed ?? reads.get(candidate.id);
      return {
        ...candidate,
        authorIsReportedUser: reportedUserIds.includes(candidate.authorId),
        capturedAt: capturedAt.toISOString(),
        capturedById,
        ...(candidate.source === 'postText' && reviewed && { reviewed }),
      };
    });
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

/**
 * Merges a filing's captures into a report's. A capture is added as its own entry unless its text
 * equals the item's latest capture, so an item edited, or edited and changed back, keeps each text in
 * order. When it equals the latest capture the report already held, `onIdentical` hears it once per
 * item. An earlier capture changes only one way: a stored latest capture with no review takes the
 * review of an identical capture that has one, with its text and capture time kept.
 */
export function foldContextText(
  prior: unknown,
  added: CsamContextText[] | undefined,
  onIdentical?: (capture: CsamContextText, reviewUpgrade?: CsamContextReview) => void
) {
  const merged = Array.isArray(prior) ? [...(prior as CsamContextText[])] : [];
  const item = (c: CsamContextText) => `${c.source}:${c.id}`;
  const latest = new Map<string, { capture: CsamContextText; stored: boolean }>();
  const consider = (c: CsamContextText, stored: boolean) => {
    const current = latest.get(item(c));
    if (!current || c.capturedAt >= current.capture.capturedAt)
      latest.set(item(c), { capture: c, stored });
  };
  for (const c of merged) consider(c, true);
  const heard = new Set<string>();
  for (const c of added ?? []) {
    const current = latest.get(item(c));
    if (current && current.capture.text === c.text) {
      if (current.stored && !heard.has(item(c))) {
        heard.add(item(c));
        const review = c.reviewed;
        const upgrade =
          !current.capture.reviewed &&
          review?.origin &&
          (CSAM_REVIEW_ORIGINS as readonly string[]).includes(review.origin)
            ? review
            : undefined;
        if (upgrade) {
          const reviewed = { ...current.capture, reviewed: upgrade };
          merged[merged.indexOf(current.capture)] = reviewed;
          latest.set(item(c), { capture: reviewed, stored: true });
        }
        onIdentical?.(c, upgrade);
      }
      continue;
    }
    merged.push(c);
    consider(c, false);
  }
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

/** Sent with a held text item no moderator read or decided on its own (`CsamContextText.reviewed`). */
export const NOT_REVIEWED = 'Not reviewed by Civitai';

function itemText(c: CsamContextText) {
  const posted = `posted ${formatUtc(c.postedAt)} by ${author(c)}`;
  const heading =
    c.source === 'postDescription'
      ? `Post description, ${posted}:`
      : c.source === 'postText'
      ? `Text item ${c.id} of this post, ${posted}${c.reviewed ? '' : `. ${NOT_REVIEWED}`}:`
      : `Comment ${c.id}, ${posted}:`;
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
    // The description, then the post's held text items in reading order, then comments.
    const rank = (c: CsamContextText) =>
      c.source === 'postDescription' ? 0 : c.source === 'postText' ? 1 : 2;
    const ordered = [...items].sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (a.index ?? 0) - (b.index ?? 0) ||
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
