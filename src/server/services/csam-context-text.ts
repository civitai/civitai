import type { FormatCallback } from 'html-to-text';
import { convert } from 'html-to-text';
import { kyselyRead, kyselyV3Read, kyselyWrite } from '~/server/db/kyselyDb';
import type {
  CsamContextSourcesInput,
  GetCsamContextCandidatesSchema,
  GetCsamItemCandidatesSchema,
} from '~/server/schema/csam.schema';
import { xmlSafe } from '~/server/services/ncmec-xml';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { PLACEHOLDER_OWNER_ID } from '~/server/utils/legal-hold';
import { withTimeoutFallback } from '~/server/utils/timeout-helpers';
import { clickhouse } from '~/server/clickhouse/client';
import {
  CHAT_EDITORS_UNCONFIRMED_OPENING,
  CSAM_CONTEXT_ITEM_SEND_BUDGET,
  CSAM_CONTEXT_TEXT_MAX_CHARS,
} from '~/shared/constants/csam-context.constants';

export { CSAM_CONTEXT_TEXT_MAX_CHARS };
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
export type CsamPostContextText = {
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

export const CSAM_CONTEXT_ITEM_SOURCES = [
  'chatMessage',
  'model',
  'article',
  'serviceOffering',
  'profile',
] as const;
export type CsamItemContextSource = (typeof CSAM_CONTEXT_ITEM_SOURCES)[number];

/** One labeled field of an item, e.g. a model's name. `at` only where a column records its time. */
export type CsamItemField = { label: string; text: string; at?: string };

/**
 * A chat message, model, article, service offering or profile of the report's own user, copied when
 * the report is filed. Never give it a post or image id: database readers match entries by `postId`.
 */
export type CsamItemContextText = {
  source: CsamItemContextSource;
  /** The user's id for a profile. */
  id: number;
  postId?: never;
  imageId?: never;
  reviewed?: never;
  /** Moderators and Legal only: never sent. Always the report's own user, never its secondary user. */
  authorId: number;
  authorIsReportedUser: true;
  fields: CsamItemField[];
  /** The fields labeled and joined: what a re-file is compared on. */
  text: string;
  createdAt?: string;
  status?: string;
  deletedAt?: string;
  editedAt?: string;
  /** Edited, and the record can't show the sender made every edit: never worded as the user's writing. */
  editorsUnconfirmed?: true;
  /** A profile's address at capture. */
  username?: string;
  capturedAt: string;
  capturedById: number;
};

export type CsamContextText = CsamPostContextText | CsamItemContextText;

export const isItemContextText = (c: CsamContextText): c is CsamItemContextText =>
  (CSAM_CONTEXT_ITEM_SOURCES as readonly string[]).includes(c.source);

export type CsamContextCandidate = Omit<
  CsamPostContextText,
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

const CANDIDATE_COMMENT_LIMIT = 500;
const CANDIDATE_PREVIEW_CHARS = 2_000;

// Writes a target as inert text, never fetched, after the element's own text.
const targetAs =
  (name: string, attribute: string): FormatCallback =>
  (elem, walk, builder) => {
    walk(elem.children, builder);
    const target = elem.attribs?.[attribute];
    // Kept as written: a heading's uppercase transform would change a target's case.
    if (target) builder.addInline(` [${name}: ${target}] `, { noWordTransform: true });
  };

/**
 * `keepTargets` writes image, frame, media and embed targets as text, which the default drops. Post and
 * comment text never sets it: its output is what re-file folding and the holds queue compare.
 */
export const htmlToPlainText = (html: string, { keepTargets = false } = {}) =>
  convert(html, {
    wordwrap: false,
    ...(keepTargets && {
      formatters: {
        csamImage: targetAs('image', 'src'),
        csamFrame: targetAs('frame', 'src'),
        csamMedia: targetAs('media', 'url'),
        csamEmbed: targetAs('embed id', 'data-id'),
      },
    }),
    selectors: [
      ...(keepTargets
        ? [
            // No case change and no dropped href: a link target's exact text is the evidence.
            { selector: 'a', options: { hideLinkHrefIfSameAsText: false } },
            ...(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const).map((selector) => ({
              selector,
              options: { uppercase: false },
            })),
            { selector: 'img', format: 'csamImage' },
            { selector: 'iframe', format: 'csamFrame' },
            { selector: 'edge-media', format: 'csamMedia' },
            { selector: 'div[data-id]', format: 'csamEmbed' },
          ]
        : [
            { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
            { selector: 'img', format: 'skip' },
          ]),
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

const CANDIDATE_ITEM_LIMIT = 100;

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : undefined);
const joinFields = (fields: CsamItemField[]) =>
  fields.map((f) => `${f.label}:\n${f.text}`).join('\n\n');
const present = (fields: { label: string; text: string | null | undefined; at?: string }[]) =>
  fields
    .filter((f): f is CsamItemField => !!f.text?.trim())
    .map((f) => ({
      label: f.label,
      text: f.text,
      ...(f.at && { at: f.at }),
    }));

type ItemRead = Omit<
  CsamItemContextText,
  'authorIsReportedUser' | 'text' | 'capturedAt' | 'capturedById'
>;

// primary, in all three readers: the capture is the item as it stands when the report is filed.
/** The models, articles or service offerings with these ids. */
type WebItemSource = 'model' | 'article' | 'serviceOffering';

async function readWebItems(source: WebItemSource, ids: number[], ownerId: number) {
  if (!ids.length) return [];
  if (source === 'model') {
    const rows = await kyselyWrite
      .selectFrom('Model')
      .select([
        'id',
        'userId',
        'name',
        'description',
        'sfwName',
        'sfwDescription',
        'status',
        'createdAt',
        'deletedAt',
      ])
      .where('id', 'in', ids)
      .where('userId', '=', ownerId)
      .execute();
    const rich = (html: string | null) => html && htmlToPlainText(html, { keepTargets: true });
    return rows.map((r): ItemRead => {
      // A set sfwName turns the civitai.com face on: that site then shows sfwName and sfwDescription.
      const red = r.sfwName !== null ? 'civitai.red' : 'civitai.red and civitai.com';
      return {
        source,
        id: r.id,
        authorId: r.userId,
        fields: present([
          { label: `Name (${red})`, text: r.name },
          { label: `Description (${red})`, text: rich(r.description) },
          ...(r.sfwName !== null
            ? [
                { label: 'Name (civitai.com)', text: r.sfwName },
                { label: 'Description (civitai.com)', text: rich(r.sfwDescription) },
              ]
            : []),
        ]),
        createdAt: iso(r.createdAt),
        status: r.status,
        ...(r.deletedAt && { deletedAt: iso(r.deletedAt) }),
      };
    });
  }
  if (source === 'article') {
    const rows = await kyselyWrite
      .selectFrom('Article')
      .select(['id', 'userId', 'title', 'content', 'status', 'createdAt'])
      .where('id', 'in', ids)
      .where('userId', '=', ownerId)
      .execute();
    return rows.map(
      (r): ItemRead => ({
        source,
        id: r.id,
        authorId: r.userId,
        fields: present([
          { label: 'Title', text: r.title },
          { label: 'Content', text: htmlToPlainText(r.content, { keepTargets: true }) },
        ]),
        ...(r.createdAt && { createdAt: iso(r.createdAt) }),
        status: r.status,
      })
    );
  }
  const rows = await kyselyWrite
    .selectFrom('ServiceOffering')
    .select(['id', 'sellerId', 'title', 'description', 'status', 'createdAt'])
    .where('id', 'in', ids)
    .where('sellerId', '=', ownerId)
    .execute();
  return rows.map(
    (r): ItemRead => ({
      source,
      id: r.id,
      authorId: r.sellerId,
      // Plain text as the seller typed it, not HTML.
      fields: present([
        { label: 'Title', text: r.title },
        { label: 'Description', text: r.description },
      ]),
      createdAt: iso(r.createdAt),
      status: r.status,
    })
  );
}

/**
 * Chat messages whose edits might not all be in "ChatMessageEdit": edits before it existed are only in
 * the "chatAuditEvents" log. Returns those another account edited there, or undefined when the log
 * can't be read in time. Never fails or holds up a filing.
 */
const CHAT_AUDIT_READ_TIMEOUT_MS = 1_500;

async function chatEditsByOthersInAuditLog(
  messages: { id: number; chatId: number }[],
  senderId: number
): Promise<Set<number> | undefined> {
  if (!messages.length) return new Set();
  if (!clickhouse) return undefined;
  // Ints read back from Postgres rows, so nothing user-typed reaches the SQL.
  const ids = messages.map((m) => m.id);
  const chatIds = [...new Set(messages.map((m) => m.chatId))];
  const query = clickhouse
    .$query<{ messageId: string | number }>(
      `SELECT DISTINCT messageId FROM chatAuditEvents
       WHERE type = 'edit' AND chatId IN (${chatIds.join(',')}) AND messageId IN (${ids.join(',')})
         AND actorId != ${senderId}`
    )
    .then((rows) => new Set(rows.map((r) => Number(r.messageId))))
    .catch(() => undefined);
  return withTimeoutFallback(query, CHAT_AUDIT_READ_TIMEOUT_MS, undefined);
}

async function readChatMessages(ids: number[], ownerId: number) {
  if (!ids.length) return [];
  const rows = await kyselyWrite
    .selectFrom('ChatMessage')
    .select([
      'id',
      'chatId',
      'userId',
      'content',
      'contentType',
      'createdAt',
      'editedAt',
      'deletedAt',
    ])
    .where('id', 'in', ids)
    .where('userId', '=', ownerId)
    .execute();
  const edited = rows.filter((r) => r.editedAt);
  const edits = rows.length
    ? await kyselyWrite
        .selectFrom('ChatMessageEdit')
        .select(['messageId', 'editorId'])
        .where(
          'messageId',
          'in',
          rows.map((r) => r.id)
        )
        .execute()
    : [];
  const editedByOthers = new Set(
    edits.filter((e) => e.editorId !== ownerId).map((e) => e.messageId)
  );
  const [firstRecorded] = edited.length
    ? await kyselyWrite
        .selectFrom('ChatMessageEdit')
        .select('createdAt')
        .orderBy('id', 'asc')
        .limit(1)
        .execute()
    : [];
  const historyIncomplete = new Set(
    edited
      .filter(
        (r) =>
          !editedByOthers.has(r.id) &&
          (!edits.some((e) => e.messageId === r.id) ||
            !firstRecorded ||
            r.createdAt < firstRecorded.createdAt)
      )
      .map((r) => r.id)
  );
  const loggedByOthers = await chatEditsByOthersInAuditLog(
    rows.filter((r) => historyIncomplete.has(r.id)),
    ownerId
  );
  return rows.map((r): { attachable: boolean; item: ItemRead } => ({
    // A moderator's edit would be sent as the user's words.
    attachable:
      r.contentType === 'Markdown' && !editedByOthers.has(r.id) && !loggedByOthers?.has(r.id),
    item: {
      source: 'chatMessage',
      id: r.id,
      authorId: r.userId,
      fields: present([{ label: 'Message', text: r.content }]),
      createdAt: iso(r.createdAt),
      ...(r.editedAt && { editedAt: iso(r.editedAt) }),
      ...(r.deletedAt && { deletedAt: iso(r.deletedAt) }),
      ...(historyIncomplete.has(r.id) && { editorsUnconfirmed: true as const }),
    },
  }));
}

/**
 * Models whose text may not be the owner's: another account held it, or it was transferred to them.
 * A model split out of another (its showcase collection names the original) is judged by the original
 * too, and refused when the original is gone or has no ownership record. Only what is on record is
 * seen: a move from before "ModelOwnership" existed, or a showcase link the owner removed, can't be told.
 */
async function modelsOwnedByOthers(ids: number[], ownerId: number) {
  if (!ids.length) return new Set<number>();
  const models = await kyselyWrite
    .selectFrom('Model')
    .select(['id', 'meta'])
    .where('id', 'in', ids)
    .execute();
  const showcaseOf = new Map<number, number>();
  for (const m of models) {
    const collectionId = (m.meta as { showcaseCollectionId?: unknown } | null)
      ?.showcaseCollectionId;
    if (typeof collectionId === 'number') showcaseOf.set(m.id, collectionId);
  }
  const collections = showcaseOf.size
    ? await kyselyWrite
        .selectFrom('Collection')
        .select(['id', 'metadata'])
        .where('id', 'in', [...new Set(showcaseOf.values())])
        .execute()
    : [];
  const originalOf = new Map<number, number>();
  for (const [modelId, collectionId] of showcaseOf) {
    const metadata = collections.find((c) => c.id === collectionId)?.metadata as {
      originalModelId?: unknown;
    } | null;
    const original = metadata?.originalModelId;
    if (typeof original === 'number') originalOf.set(modelId, original);
  }
  const judged = [...new Set([...ids, ...originalOf.values()])];
  const [rows, existing] = await Promise.all([
    kyselyWrite
      .selectFrom('ModelOwnership')
      .select(['modelId', 'userId', 'reason'])
      .where('modelId', 'in', judged)
      .execute(),
    originalOf.size
      ? kyselyWrite
          .selectFrom('Model')
          .select('id')
          .where('id', 'in', [...new Set(originalOf.values())])
          .execute()
      : Promise.resolve([]),
  ]);
  const notTheOwners = (modelId: number) =>
    rows.some(
      (r) =>
        r.modelId === modelId &&
        (r.reason === 'transfer'
          ? r.userId !== PLACEHOLDER_OWNER_ID
          : r.userId !== ownerId && r.userId !== PLACEHOLDER_OWNER_ID)
    );
  const unrecorded = (modelId: number) =>
    !existing.some((m) => m.id === modelId) || !rows.some((r) => r.modelId === modelId);
  return new Set(
    ids.filter((id) => {
      const original = originalOf.get(id);
      return (
        notTheOwners(id) ||
        (original !== undefined && (unrecorded(original) || notTheOwners(original)))
      );
    })
  );
}

/** Each field labeled with the site that shows it: the civitai.com value replaces the other there. */
async function readProfile(userId: number): Promise<ItemRead | undefined> {
  const [row] = await kyselyWrite
    .selectFrom('User')
    .leftJoin('UserProfile', 'UserProfile.userId', 'User.id')
    .select([
      'User.id',
      'User.username',
      'UserProfile.bio',
      'UserProfile.message',
      'UserProfile.messageAddedAt',
      'UserProfile.sfwBio',
      'UserProfile.sfwMessage',
      'UserProfile.sfwMessageAddedAt',
    ])
    .where('User.id', '=', userId)
    .execute();
  if (!row) return;
  // An empty override still replaces the field on civitai.com.
  const sites = (override: string | null) =>
    override !== null ? 'civitai.red' : 'civitai.red and civitai.com';
  return {
    source: 'profile',
    id: row.id,
    authorId: row.id,
    fields: present([
      { label: `Bio (${sites(row.sfwBio)})`, text: row.bio },
      {
        label: `Message (${sites(row.sfwMessage)})`,
        text: row.message,
        at: iso(row.messageAddedAt),
      },
      { label: 'Bio (civitai.com)', text: row.sfwBio },
      { label: 'Message (civitai.com)', text: row.sfwMessage, at: iso(row.sfwMessageAddedAt) },
    ]),
    ...(row.username && { username: row.username }),
  };
}

/** Whether filing could attach the user's profile: it has text in at least one field. */
export async function csamProfileHasText({ userId }: { userId: number }) {
  return !!(await readProfile(userId))?.fields.length;
}

export type CsamItemCandidate = {
  source: 'model' | 'article' | 'serviceOffering';
  id: number;
  title: string;
  status: string;
  deleted?: boolean;
  /** Filing would not attach it. */
  unavailable?: boolean;
};

/**
 * The report's own user's models, articles or service offerings, newest first. Past the cap a
 * moderator gives the id, which filing checks the same way.
 */
export async function getCsamItemCandidates({
  userId,
  source,
}: GetCsamItemCandidatesSchema): Promise<{ candidates: CsamItemCandidate[]; more: boolean }> {
  const limit = CANDIDATE_ITEM_LIMIT + 1;
  const rows: CsamItemCandidate[] =
    source === 'model'
      ? (
          await kyselyRead
            .selectFrom('Model')
            .select(['id', 'name', 'status', 'deletedAt'])
            .where('userId', '=', userId)
            .orderBy('id', 'desc')
            .limit(limit)
            .execute()
        ).map((r) => ({
          source,
          id: r.id,
          title: r.name,
          status: r.status,
          ...(r.deletedAt && { deleted: true }),
        }))
      : source === 'article'
      ? (
          await kyselyRead
            .selectFrom('Article')
            .select(['id', 'title', 'status'])
            .where('userId', '=', userId)
            .orderBy('id', 'desc')
            .limit(limit)
            .execute()
        ).map((r) => ({ source, id: r.id, title: r.title, status: r.status }))
      : (
          await kyselyRead
            .selectFrom('ServiceOffering')
            .select(['id', 'title', 'status'])
            .where('sellerId', '=', userId)
            .orderBy('id', 'desc')
            .limit(limit)
            .execute()
        ).map((r) => ({ source, id: r.id, title: r.title, status: r.status }));
  const candidates = rows.slice(0, CANDIDATE_ITEM_LIMIT);
  const moved =
    source === 'model'
      ? await modelsOwnedByOthers(
          candidates.map((c) => c.id),
          userId
        )
      : new Set<number>();
  return {
    candidates: candidates.map((c) => (moved.has(c.id) ? { ...c, unavailable: true } : c)),
    more: rows.length > CANDIDATE_ITEM_LIMIT,
  };
}

const itemLabel = (source: CsamItemContextSource, id: number) =>
  source === 'profile'
    ? 'profile'
    : `${
        {
          chatMessage: 'chat message',
          model: 'model',
          article: 'article',
          serviceOffering: 'service offering',
        }[source]
      } ${id}`;

/**
 * Copies the chosen chat message, model, article, service offering and profile text of the report's own
 * user. An item that can't be attached never stops the filing: it is named in `notAttached`, with no
 * reason, so a missing chat message reads the same as another account's.
 */
async function snapshotItems({
  sources,
  ownerId,
  capturedById,
  capturedAt,
}: {
  sources: CsamContextSourcesInput;
  ownerId?: number;
  capturedById: number;
  capturedAt: Date;
}): Promise<{ items: CsamItemContextText[]; notAttached: string[] }> {
  const unique = (ids: number[] | undefined) => [...new Set(ids ?? [])];
  const wanted: [CsamItemContextSource, number[]][] = [
    ['chatMessage', unique(sources.chatMessageIds)],
    ['model', unique(sources.modelIds)],
    ['article', unique(sources.articleIds)],
    ['serviceOffering', unique(sources.serviceOfferingIds)],
    ...(sources.profile && ownerId !== undefined
      ? ([['profile', [ownerId]]] as [CsamItemContextSource, number[]][])
      : []),
  ];
  const notAttached = sources.profile && ownerId === undefined ? ['profile'] : [];
  if (wanted.every(([, ids]) => !ids.length)) return { items: [], notAttached };
  if (ownerId === undefined) {
    for (const [source, ids] of wanted) notAttached.push(...ids.map((id) => itemLabel(source, id)));
    return { items: [], notAttached };
  }

  const [chatIds, modelIds, articleIds, offeringIds] = wanted.map(([, ids]) => ids);
  const chats = await readChatMessages(chatIds, ownerId);
  const models = await readWebItems('model', modelIds, ownerId);
  const movedModels = await modelsOwnedByOthers(
    models.map((m) => m.id),
    ownerId
  );
  const read: ItemRead[] = [
    ...chats.filter((c) => c.attachable).map((c) => c.item),
    ...models.filter((m) => !movedModels.has(m.id)),
    ...(await readWebItems('article', articleIds, ownerId)),
    ...(await readWebItems('serviceOffering', offeringIds, ownerId)),
    ...(sources.profile ? [await readProfile(ownerId)].filter((p): p is ItemRead => !!p) : []),
  ].filter((item) => item.fields.length);

  // In the moderator's order, so a send that can't carry every item keeps the ones picked first.
  const picks = wanted.flatMap(([source, ids]) => ids.map((id) => ({ source, id })));
  const place = (p: { source: CsamItemContextSource; id: number }) => {
    const at = (sources.order ?? []).indexOf(
      p.source === 'profile' ? 'profile' : `${p.source}:${p.id}`
    );
    return at < 0 ? Infinity : at;
  };
  picks.sort((a, b) => place(a) - place(b));

  const items: CsamItemContextText[] = [];
  for (const { source, id } of picks) {
    const item = read.find((r) => r.source === source && r.id === id);
    if (!item) {
      notAttached.push(itemLabel(source, id));
      continue;
    }
    items.push({
      ...item,
      authorIsReportedUser: true,
      text: joinFields(item.fields),
      capturedAt: capturedAt.toISOString(),
      capturedById,
    });
  }
  return { items, notAttached };
}

/**
 * Copies the chosen text. Post and comment text outside the report's images refuses the filing; an
 * item that can't be attached is only named in `notAttached`.
 */
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
  sources: CsamContextSourcesInput;
  reportedUserIds: number[];
  capturedById: number;
  capturedAt?: Date;
}): Promise<{ contextText: CsamContextText[]; notAttached: string[] }> {
  const postIds = [...new Set(sources.postIds)];
  const commentIds = [...new Set(sources.commentIds)];
  const posts = await snapshotPostText({
    imageIds,
    ownerId,
    postIds,
    commentIds,
    reportedUserIds,
    capturedById,
    capturedAt,
  });
  const { items, notAttached } = await snapshotItems({
    sources,
    ownerId,
    capturedById,
    capturedAt,
  });
  return { contextText: [...posts, ...items], notAttached };
}

async function snapshotPostText({
  imageIds,
  ownerId,
  postIds,
  commentIds,
  reportedUserIds,
  capturedById,
  capturedAt,
}: {
  imageIds: number[];
  ownerId?: number;
  postIds: number[];
  commentIds: number[];
  reportedUserIds: number[];
  capturedById: number;
  capturedAt: Date;
}): Promise<CsamPostContextText[]> {
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
 * review of an identical capture whose review names a known origin (`CSAM_REVIEW_ORIGINS`), with its
 * text and capture time kept.
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
        if (upgrade && !isItemContextText(current.capture)) {
          const reviewed: CsamContextText = { ...current.capture, reviewed: upgrade };
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
function quotedCapped(text: string, max = CSAM_CONTEXT_TEXT_MAX_CHARS) {
  const chars = Array.from(text);
  if (chars.length <= max) return `"${text}"`;
  const rest = chars.length - max;
  return `"${chars
    .slice(0, max)
    .join(
      ''
    )}"\n[Truncated: ${rest} further characters are preserved by Civitai with this report.]`;
}

const author = (c: CsamPostContextText) =>
  c.authorIsReportedUser ? 'the reported account' : 'another account';

/** Sent with a held text item no moderator read or decided on its own (`CsamContextText.reviewed`). */
export const NOT_REVIEWED = 'Not reviewed by Civitai';

function itemText(c: CsamPostContextText) {
  const posted = `posted ${formatUtc(c.postedAt)} by ${author(c)}`;
  const heading =
    c.source === 'postDescription'
      ? `Post description, ${posted}:`
      : c.source === 'postText'
      ? `Text item ${c.id} of this post, ${posted}${c.reviewed ? '' : `. ${NOT_REVIEWED}`}:`
      : `Comment ${c.id}, ${posted}:`;
  return `${heading}\n${quotedCapped(c.text)}`;
}

/** Shared by an item's fields, in order: the whole item sends at most the cap. */
function quotedFields(fields: CsamItemField[]) {
  let budget = CSAM_CONTEXT_TEXT_MAX_CHARS;
  return fields.map((f) => {
    const quoted = quotedCapped(f.text, budget);
    budget = Math.max(0, budget - Array.from(f.text).length);
    return `${f.label}${f.at ? `, added ${formatUtc(f.at)}` : ''}:\n${quoted}`;
  });
}

const EDITED_NOTE = 'text as of capture; may differ from what was sent';

/** Where an item lives and what it was when captured. Never calls an item public or posted. */
function describeItem(c: CsamItemContextText, base: string) {
  const state = [
    c.status && `status ${c.status} at capture`,
    c.createdAt && `created ${formatUtc(c.createdAt)}`,
    c.deletedAt && `deleted ${formatUtc(c.deletedAt)}`,
  ]
    .filter(Boolean)
    .join(', ');
  const of = (label: string) => `${label}${state ? `, ${state}` : ''}`;
  switch (c.source) {
    case 'model':
      return { noun: 'model', url: `${base}/models/${c.id}`, heading: of(`Model ${c.id}`) };
    case 'article':
      return { noun: 'article', url: `${base}/articles/${c.id}`, heading: of(`Article ${c.id}`) };
    case 'serviceOffering':
      return {
        noun: 'service offering',
        url: `${base}/services/${c.id}`,
        heading: of(`Service offering ${c.id}`),
      };
    case 'profile':
      return {
        noun: 'profile',
        url: c.username ? `${base}/user/${encodeURIComponent(c.username)}` : undefined,
        heading: `Profile of the account reported in this CyberTip (user id ${
          c.id
        }; username at capture ${c.username ?? 'none'}). Profile links and images are not included`,
      };
    case 'chatMessage':
      return {
        noun: 'chat message',
        url: undefined,
        heading: [
          `Chat message ${c.id}`,
          c.createdAt && `sent ${formatUtc(c.createdAt)}`,
          c.deletedAt && `deleted ${formatUtc(c.deletedAt)}`,
          c.editedAt && `edited ${formatUtc(c.editedAt)}: ${EDITED_NOTE}`,
        ]
          .filter(Boolean)
          .join(', '),
      };
    default: {
      const unhandled: never = c.source;
      throw new Error(`No CyberTip incident for ${unhandled}`);
    }
  }
}

// Only a chat message is worded as written by the reported user; the others say whose item it is.
const capturedLine = (c: CsamItemContextText, noun: string) =>
  c.editorsUnconfirmed
    ? `${CHAT_EDITORS_UNCONFIRMED_OPENING} Captured by Civitai on ${formatUtc(c.capturedAt)}.`
    : c.source === 'chatMessage'
    ? `Text the reported user wrote in this ${noun}, captured by Civitai on ${formatUtc(
        c.capturedAt
      )}.`
    : `Text on the reported user's ${noun} as of capture, captured by Civitai on ${formatUtc(
        c.capturedAt
      )}.`;

/**
 * Item captures that fit `CSAM_CONTEXT_ITEM_SEND_BUDGET`, in stored order (the moderator's), and those
 * that don't. Post and comment text is never counted against it.
 */
function splitBySendBudget(contextText: CsamContextText[]) {
  const within: CsamItemContextText[] = [];
  const over: CsamItemContextText[] = [];
  let budget = CSAM_CONTEXT_ITEM_SEND_BUDGET;
  for (const c of contextText) {
    if (!isItemContextText(c)) continue;
    const cost = Math.min(Array.from(c.text).length, CSAM_CONTEXT_TEXT_MAX_CHARS);
    if (cost > budget) over.push(c);
    else {
      budget -= cost;
      within.push(c);
    }
  }
  return { within, over };
}

/** A report's captured text in its archive. Post and comment text alone keeps the original shape. */
export function archivedContext(contextText: CsamContextText[]) {
  const { webPageIncidents, chatImIncidents } = contextIncidents(contextText);
  return {
    webPageIncidents,
    ...(chatImIncidents.length && { chatImIncidents }),
    contextText,
  };
}

/** A report's stored items, folds included, that its send will leave out. */
export const contextItemsOverBudget = (contextText: CsamContextText[] | undefined) =>
  splitBySendBudget(contextText ?? []).over.map((c) => itemLabel(c.source, c.id));

/**
 * The incidents as NCMEC reads them once parsed: a page incident per post or image page and capture
 * time, one per model, article, service offering or profile capture, and a chat incident per message.
 */
export function contextIncidents(contextText: CsamContextText[] | undefined) {
  const webPageIncidents: { url?: string; additionalInfo: string }[] = [];
  const chatImIncidents: { chatClient: string; content: string; additionalInfo: string }[] = [];
  /** Item captures past `CSAM_CONTEXT_ITEM_SEND_BUDGET`, left out of the send but kept. */
  let overBudget = 0;
  if (!contextText?.length) return { webPageIncidents, chatImIncidents, overBudget };
  const base = getBaseUrl('red');
  const groups = new Map<
    string,
    { url: string; capturedAt: string; items: CsamPostContextText[] }
  >();
  for (const c of contextText) {
    if (isItemContextText(c)) continue;
    const url = c.postId ? `${base}/posts/${c.postId}` : `${base}/images/${c.imageId}`;
    const key = `${url} ${c.capturedAt}`;
    const group = groups.get(key) ?? { url, capturedAt: c.capturedAt, items: [] };
    group.items.push(c);
    groups.set(key, group);
  }
  for (const { url, capturedAt, items } of groups.values()) {
    // The description, then the post's held text items in reading order, then comments.
    const rank = (c: CsamPostContextText) =>
      c.source === 'postDescription' ? 0 : c.source === 'postText' ? 1 : 2;
    const ordered = [...items].sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (a.index ?? 0) - (b.index ?? 0) ||
        a.postedAt.localeCompare(b.postedAt) ||
        a.id - b.id
    );
    webPageIncidents.push({
      url,
      additionalInfo: xmlSafe(
        [
          `Text posted with the reported images on this page, captured by Civitai on ${formatUtc(
            capturedAt
          )}.`,
          ...ordered.map(itemText),
        ].join('\n\n')
      ),
    });
  }
  const { within, over } = splitBySendBudget(contextText);
  overBudget = over.length;
  for (const c of within) {
    const { noun, url, heading } = describeItem(c, base);
    if (c.source === 'chatMessage') {
      chatImIncidents.push({
        chatClient: 'Civitai chat',
        content: xmlSafe(quotedFields(c.fields).join('\n\n')),
        additionalInfo: xmlSafe(`${capturedLine(c, noun)}\n${heading}.`),
      });
      continue;
    }
    webPageIncidents.push({
      ...(url && { url }),
      additionalInfo: xmlSafe(
        [`${capturedLine(c, noun)}\n${heading}.`, ...quotedFields(c.fields)].join('\n\n')
      ),
    });
  }
  return { webPageIncidents, chatImIncidents, overBudget };
}
