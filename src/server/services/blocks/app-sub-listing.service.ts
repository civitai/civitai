import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';

import { sessionClient } from '~/server/auth/session-client';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { bustAppListingCatalogCache } from '~/server/services/blocks/app-listing.service';
import { PARENT_LINK_TEMPLATE_SQL } from '~/server/services/blocks/app-sub-listing-store.service';
import { isMissingTableError } from '~/server/services/blocks/app-access.service';
import { isMissingColumnError } from '~/server/services/blocks/app-listing-source-repo.service';
import {
  assertSharedWriteTrust,
  hasLinkedOAuthAccount,
} from '~/server/services/blocks/block-write-trust.service';
import {
  assertSharedTextSafe,
  SharedContentBlockedError,
} from '~/server/services/apps/shared-content-safety';
import { newAppSubListingId } from '~/server/utils/app-block-ids';
import {
  checkSubListingSyncRateLimit,
  checkSubListingWriteRateLimit,
} from '~/server/utils/shared-storage-rate-limit';
import {
  APP_SUB_LISTING_CONTENT_RATINGS,
  APP_SUB_LISTING_ITEM_KEY_MAX,
  APP_SUB_LISTING_TAGLINE_MAX,
  APP_SUB_LISTING_TITLE_MAX,
  isAppSubListingId,
  isRatingAtLeastAsStrict,
  isValidSubListingExternalId,
  isValidSubListingSubPath,
  subListingExternalHref,
  type AppSubListingStatus,
} from '~/shared/constants/app-sub-listing.constants';
import type { SessionUser } from '~/types/session';
import type {
  ListSubListingQueueInput,
  ModerateSubListingInput,
} from '~/server/schema/blocks/app-sub-listing.schema';

/**
 * App Store sub-listings — the write path.
 *
 * Writers: the app (through the `upsert` and `withdraw` block-token endpoints, as the item's
 * author), an off-site parent's platform (through the `/api/v1/catalog/items` endpoints), the
 * in-app withdraw / moderator hide of the matching shared row, and moderators on
 * `/apps/review`. A write busts the store catalog cache when it changes what the cached id
 * page can contain.
 *
 * The tables and the `link_template` column are manual-apply. While they are absent every
 * function here throws `SubListingError` with status 503 rather than a raw Prisma error.
 */

export type SubListingErrorCode =
  | 'invalid_body'
  | 'anonymous'
  | 'not_enabled'
  | 'untrusted'
  | 'item_not_found'
  | 'not_your_item'
  | 'text_rejected'
  | 'image_not_yours'
  | 'image_not_public'
  | 'rating_too_loose'
  | 'rate_limited'
  | 'author_cap'
  | 'not_found'
  | 'invalid_transition'
  | 'conflict'
  | 'unavailable'
  | 'invalid_token'
  | 'insufficient_scope'
  | 'parent_ambiguous'
  | 'creator_not_linked'
  | 'creator_not_found'
  | 'author_mismatch';

export class SubListingError extends Error {
  constructor(
    readonly status: number,
    readonly code: SubListingErrorCode,
    message: string,
    readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = 'SubListingError';
  }
}

/** Map a missing table or column to the 503 every caller expects; rethrow anything else. */
function rethrowUnavailable(err: unknown): never {
  if (err instanceof SubListingError) throw err;
  if (isMissingTableError(err) || isMissingColumnError(err)) {
    throw new SubListingError(503, 'unavailable', 'Store items are not available yet');
  }
  throw err;
}

async function bustCatalog() {
  await bustAppListingCatalogCache().catch(() => undefined);
}

/**
 * The compare-and-set predicate for a row as read. `updated_at` is microsecond precision in the
 * database but a JS Date carries milliseconds, so the match is on the millisecond the read saw;
 * an exact match would never succeed for a value Postgres itself wrote (the column default, a
 * hand edit).
 */
function unchangedSince(row: { id: string; status: string; updatedAt: Date }) {
  const ms = row.updatedAt.getTime();
  return {
    id: row.id,
    status: row.status,
    updatedAt: { gte: new Date(ms), lt: new Date(ms + 1) },
  } satisfies Prisma.AppSubListingWhereInput;
}

// Control and format characters (bidi overrides, zero-width joiners, soft hyphens): invisible
// text that can disguise what a title says.
const INVISIBLE_RE = /[\p{Cc}\p{Cf}]/gu;

export function cleanSubListingText(value: string): string {
  return value.normalize('NFC').replace(INVISIBLE_RE, ' ').replace(/\s+/g, ' ').trim();
}

export const upsertSubListingBodySchema = z
  .object({
    itemKey: z.string().min(1).max(APP_SUB_LISTING_ITEM_KEY_MAX),
    title: z.string().max(1000),
    tagline: z.string().max(2000).nullish(),
    imageId: z.number().int().positive().nullish(),
    subPath: z.string().max(1000),
    contentRating: z.enum(APP_SUB_LISTING_CONTENT_RATINGS).nullish(),
  })
  .strict();
export type UpsertSubListingBody = z.infer<typeof upsertSubListingBodySchema>;

export const withdrawSubListingBodySchema = z
  .object({ itemKey: z.string().min(1).max(APP_SUB_LISTING_ITEM_KEY_MAX) })
  .strict();

/** The cleaned, validated content of an item: what goes into the live or pending columns. */
type SubListingContent = {
  title: string;
  tagline: string | null;
  imageId: number | null;
  subPath: string;
  contentRating: string | null;
};

function cleanContent(body: UpsertSubListingBody): SubListingContent {
  const title = cleanSubListingText(body.title);
  const tagline = body.tagline == null ? null : cleanSubListingText(body.tagline) || null;
  if (title.length < 1 || title.length > APP_SUB_LISTING_TITLE_MAX) {
    throw new SubListingError(
      400,
      'invalid_body',
      `title must be 1-${APP_SUB_LISTING_TITLE_MAX} characters`
    );
  }
  if (tagline != null && tagline.length > APP_SUB_LISTING_TAGLINE_MAX) {
    throw new SubListingError(
      400,
      'invalid_body',
      `tagline must be at most ${APP_SUB_LISTING_TAGLINE_MAX} characters`
    );
  }
  if (!isValidSubListingSubPath(body.subPath)) {
    throw new SubListingError(
      400,
      'invalid_body',
      'subPath must be 1-4 segments of letters, digits, _ or -'
    );
  }
  return {
    title,
    tagline,
    imageId: body.imageId ?? null,
    subPath: body.subPath,
    contentRating: body.contentRating ?? null,
  };
}

function sameContent(a: SubListingContent, b: SubListingContent): boolean {
  return (
    a.title === b.title &&
    a.tagline === b.tagline &&
    a.imageId === b.imageId &&
    a.subPath === b.subPath &&
    a.contentRating === b.contentRating
  );
}

function liveContent(row: SubListingContent): SubListingContent {
  return {
    title: row.title,
    tagline: row.tagline,
    imageId: row.imageId,
    subPath: row.subPath,
    contentRating: row.contentRating,
  };
}

const CLEAR_PENDING = {
  pendingTitle: null,
  pendingTagline: null,
  pendingImageId: null,
  pendingSubPath: null,
  pendingContentRating: null,
  pendingSubmittedAt: null,
} satisfies Prisma.AppSubListingUncheckedUpdateManyInput;

function liveColumns(c: SubListingContent) {
  return {
    title: c.title,
    tagline: c.tagline,
    imageId: c.imageId,
    subPath: c.subPath,
    contentRating: c.contentRating,
  };
}

type ResolvedParent = {
  id: string;
  slug: string;
  contentRating: string | null;
  blockId: string;
  enabled: boolean;
  maxPerAuthor: number;
};

/** The calling app's own top-level listing and its sub-listing switch. */
async function resolveParent(appBlockId: string): Promise<ResolvedParent | null> {
  try {
    const listing = await dbRead.appListing.findFirst({
      where: { appBlockId, revisionOfId: null },
      select: {
        id: true,
        slug: true,
        contentRating: true,
        appBlock: { select: { blockId: true } },
        subListingParent: { select: { enabled: true, maxPerAuthor: true } },
      },
    });
    if (!listing?.appBlock) return null;
    return {
      id: listing.id,
      slug: listing.slug,
      contentRating: listing.contentRating,
      blockId: listing.appBlock.blockId,
      enabled: listing.subListingParent?.enabled ?? false,
      maxPerAuthor: listing.subListingParent?.maxPerAuthor ?? 0,
    };
  } catch (err) {
    rethrowUnavailable(err);
  }
}

export type SharedItemRead = { authorUserId: number; hidden: boolean } | null;

/** The app's shared-storage row for `key`, including a hidden one. */
export async function readSharedItemForSubListing(
  blockId: string,
  key: string
): Promise<SharedItemRead> {
  const { sanitizeAppSlug, appSchemaIdent } = await import('~/server/utils/apps-slug');
  const slug = sanitizeAppSlug(blockId);
  if (!slug) return null;
  const { requireAppsDb } = await import('~/server/db/appsDb');
  let rows: { author_user_id: number; hidden: boolean }[];
  try {
    rows = (
      await requireAppsDb().query<{ author_user_id: number; hidden: boolean }>(
        `SELECT author_user_id, hidden_at IS NOT NULL AS hidden FROM ${appSchemaIdent(
          slug
        )}.shared_kv WHERE key = $1 LIMIT 1`,
        [key]
      )
    ).rows;
  } catch (err) {
    // An unprovisioned schema or an unavailable apps database cannot prove the item exists.
    logToAxiom({
      name: 'app-sub-listing-shared-read-failed',
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    }).catch(() => null);
    throw new SubListingError(503, 'unavailable', 'Item storage is unavailable, retry later');
  }
  const row = rows[0];
  return row ? { authorUserId: row.author_user_id, hidden: row.hidden } : null;
}

/**
 * Owner of `imageId` if an anonymous viewer may see it, else null. A card shows its image to
 * every store visitor, so this reuses `getImage`'s non-moderator read rather than restating
 * its visibility rule. Render re-checks that the image's post is still public and the
 * per-viewer maturity (`hydrateSubListingCards` / `projectSubListingCard`).
 */
async function publicImageOwner(imageId: number): Promise<number | null> {
  const { getImage } = await import('~/server/services/image.service');
  try {
    const image = await getImage({ id: imageId, isModerator: false });
    return image.user.id;
  } catch (err) {
    if (err instanceof TRPCError && err.code === 'NOT_FOUND') return null;
    throw err;
  }
}

export type UpsertSubListingResult = {
  id: string;
  status: AppSubListingStatus;
  /** True while an edit to an approved item is waiting for a moderator. */
  pendingEdit: boolean;
};

export async function upsertSubListing(args: {
  appBlockId: string;
  subjectUser: SessionUser | null;
  hasLinkedOAuth: boolean;
  body: unknown;
}): Promise<UpsertSubListingResult> {
  const parsed = upsertSubListingBodySchema.safeParse(args.body);
  if (!parsed.success) throw new SubListingError(400, 'invalid_body', 'Invalid request body');
  const content = cleanContent(parsed.data);
  const itemKey = parsed.data.itemKey;

  const user = args.subjectUser;
  if (!user) throw new SubListingError(401, 'anonymous', 'Sign in to publish store items');

  const parent = await resolveParent(args.appBlockId);
  if (!parent || !parent.enabled) {
    throw new SubListingError(403, 'not_enabled', 'This app may not publish store items');
  }

  try {
    assertSharedWriteTrust(user, args.hasLinkedOAuth);
  } catch {
    throw new SubListingError(403, 'untrusted', 'Your account cannot publish store items yet');
  }

  if (!isRatingAtLeastAsStrict(content.contentRating, parent.contentRating)) {
    throw new SubListingError(
      400,
      'rating_too_loose',
      "contentRating may not be less mature than the app's own rating"
    );
  }

  const rate = await checkSubListingWriteRateLimit(user.id, parent.id);
  if (!rate.allowed) {
    throw new SubListingError(
      429,
      'rate_limited',
      'Too many store item updates, retry later',
      rate.retryAfterSeconds
    );
  }

  const item = await readSharedItemForSubListing(parent.blockId, itemKey);
  if (!item || item.hidden) throw new SubListingError(404, 'item_not_found', 'Item not found');
  if (item.authorUserId !== user.id) {
    throw new SubListingError(403, 'not_your_item', 'Only the item author can publish it');
  }

  if (content.imageId != null) {
    const owner = await publicImageOwner(content.imageId);
    if (owner == null) {
      throw new SubListingError(
        400,
        'image_not_public',
        'The image must be public: in a published post and reviewed'
      );
    }
    if (owner !== user.id) {
      throw new SubListingError(403, 'image_not_yours', 'The image must be one you uploaded');
    }
  }

  try {
    const safe = await assertSharedTextSafe({
      title: content.title,
      body: content.tagline ?? undefined,
      userId: user.id,
      isModerator: user.isModerator ?? false,
    });
    content.title = safe.title;
    content.tagline = safe.body ?? null;
  } catch (err) {
    if (err instanceof SharedContentBlockedError) {
      throw new SubListingError(400, 'text_rejected', 'The title or tagline was not accepted');
    }
    throw err;
  }

  try {
    const { catalogAffected, ...result } = await writeSubListing(parent, itemKey, user.id, content);
    if (catalogAffected) await bustCatalog();
    return result;
  } catch (err) {
    rethrowUnavailable(err);
  }
}

type WriteOutcome = UpsertSubListingResult & { catalogAffected: boolean };

const MAX_WRITE_ATTEMPTS = 3;

const notYourItem = () =>
  new SubListingError(403, 'not_your_item', 'Only the item author can publish it');

async function writeSubListing(
  parent: Pick<ResolvedParent, 'id' | 'maxPerAuthor'>,
  itemKey: string,
  authorUserId: number,
  content: SubListingContent,
  authorMismatch: () => SubListingError = notYourItem,
  attempt = 1
): Promise<WriteOutcome> {
  const again = () => {
    if (attempt >= MAX_WRITE_ATTEMPTS) {
      throw new SubListingError(409, 'conflict', 'The item changed while saving, retry');
    }
    return writeSubListing(parent, itemKey, authorUserId, content, authorMismatch, attempt + 1);
  };
  const activeCount = () =>
    dbWrite.appSubListing.count({
      where: { parentListingId: parent.id, authorUserId, status: { in: ['pending', 'approved'] } },
    });

  const existing = await dbWrite.appSubListing.findUnique({
    where: { parentListingId_itemKey: { parentListingId: parent.id, itemKey } },
  });

  if (!existing) {
    if ((await activeCount()) >= parent.maxPerAuthor) {
      throw new SubListingError(429, 'author_cap', 'You have reached the store item limit');
    }
    // Always `pending`: moderator approval is mandatory.
    try {
      const created = await dbWrite.appSubListing.create({
        data: {
          id: newAppSubListingId(),
          parentListingId: parent.id,
          itemKey,
          authorUserId,
          ...liveColumns(content),
          status: 'pending',
        },
        select: { id: true, status: true },
      });
      return {
        id: created.id,
        status: created.status as AppSubListingStatus,
        pendingEdit: false,
        catalogAffected: false,
      };
    } catch (err) {
      // A concurrent first publish of the same item won the insert: apply this as an edit.
      if ((err as { code?: unknown })?.code === 'P2002') return again();
      throw err;
    }
  }

  if (existing.authorUserId !== authorUserId) throw authorMismatch();
  const status = existing.status as AppSubListingStatus;

  // A moderator's hide is a lock the app cannot lift.
  if (status === 'hidden') {
    return { id: existing.id, status, pendingEdit: false, catalogAffected: false };
  }

  // Every update is a compare-and-set on the state this branch was chosen from, so a
  // moderator action landing between the read and the write is never overwritten.
  const casUpdate = async (data: Prisma.AppSubListingUncheckedUpdateManyInput) => {
    const { count } = await dbWrite.appSubListing.updateMany({
      where: unchangedSince(existing),
      data: { ...data, updatedAt: new Date() },
    });
    return count > 0;
  };

  if (status === 'withdrawn') {
    if ((await activeCount()) >= parent.maxPerAuthor) {
      throw new SubListingError(429, 'author_cap', 'You have reached the store item limit');
    }
    const written = await casUpdate({
      ...liveColumns(content),
      ...CLEAR_PENDING,
      editRejectionReason: null,
      status: 'pending',
      statusReason: null,
      // Restore keys on `approvedAt`; a stale stamp would let hide + restore skip re-review.
      approvedAt: null,
    });
    if (!written) return again();
    return { id: existing.id, status: 'pending', pendingEdit: false, catalogAffected: false };
  }

  if (status === 'pending') {
    // Never approved: the live columns ARE the draft.
    const written = await casUpdate({
      ...liveColumns(content),
      ...CLEAR_PENDING,
      editRejectionReason: null,
    });
    if (!written) return again();
    return { id: existing.id, status, pendingEdit: false, catalogAffected: false };
  }

  // Approved: keep the live version and stage the edit, unless it changes nothing.
  if (sameContent(liveContent(existing), content)) {
    if (existing.pendingSubmittedAt && !(await casUpdate({ ...CLEAR_PENDING }))) return again();
    return { id: existing.id, status, pendingEdit: false, catalogAffected: false };
  }
  const written = await casUpdate({
    pendingTitle: content.title,
    pendingTagline: content.tagline,
    pendingImageId: content.imageId,
    pendingSubPath: content.subPath,
    pendingContentRating: content.contentRating,
    pendingSubmittedAt: new Date(),
    editRejectionReason: null,
  });
  if (!written) return again();
  return { id: existing.id, status, pendingEdit: true, catalogAffected: false };
}

/**
 * Move a pending or approved row out of the store, busting the catalog only when an approved
 * row (the only kind the cached page can hold) moved. Returns the number of rows changed.
 */
async function transitionActive(args: {
  where: Prisma.AppSubListingWhereInput;
  data: Prisma.AppSubListingUncheckedUpdateManyInput;
}): Promise<number> {
  const data = { ...args.data, updatedAt: new Date() };
  // Pending first: a row approved between the two statements is then caught by the second,
  // because nothing moves an approved row back to pending.
  const pending = await dbWrite.appSubListing.updateMany({
    where: { ...args.where, status: 'pending' },
    data,
  });
  const approved = await dbWrite.appSubListing.updateMany({
    where: { ...args.where, status: 'approved' },
    data,
  });
  if (approved.count > 0) await bustCatalog();
  return approved.count + pending.count;
}

export async function withdrawSubListing(args: {
  appBlockId: string;
  userId: number | null;
  body: unknown;
}): Promise<{ ok: true; withdrawn: boolean }> {
  const parsed = withdrawSubListingBodySchema.safeParse(args.body);
  if (!parsed.success) throw new SubListingError(400, 'invalid_body', 'Invalid request body');
  if (args.userId == null) {
    throw new SubListingError(401, 'anonymous', 'Sign in to withdraw store items');
  }
  const parent = await resolveParent(args.appBlockId);
  if (!parent) return { ok: true, withdrawn: false };
  const rate = await checkSubListingWriteRateLimit(args.userId, parent.id);
  if (!rate.allowed) {
    throw new SubListingError(
      429,
      'rate_limited',
      'Too many store item updates, retry later',
      rate.retryAfterSeconds
    );
  }
  try {
    const count = await transitionActive({
      where: {
        parentListingId: parent.id,
        itemKey: parsed.data.itemKey,
        authorUserId: args.userId,
      },
      data: { status: 'withdrawn', ...CLEAR_PENDING },
    });
    return { ok: true, withdrawn: count > 0 };
  } catch (err) {
    rethrowUnavailable(err);
  }
}

export type MySubListing = {
  id: string;
  itemKey: string;
  status: AppSubListingStatus;
  title: string;
  pendingEdit: boolean;
  statusReason: string | null;
  editRejectionReason: string | null;
  updatedAt: Date;
};

export async function listMySubListings(args: {
  appBlockId: string;
  userId: number | null;
}): Promise<{ items: MySubListing[] }> {
  if (args.userId == null) {
    throw new SubListingError(401, 'anonymous', 'Sign in to see your store items');
  }
  const parent = await resolveParent(args.appBlockId);
  if (!parent) return { items: [] };
  try {
    const rows = await dbRead.appSubListing.findMany({
      where: { parentListingId: parent.id, authorUserId: args.userId },
      orderBy: { createdAt: 'asc' },
      take: 200,
      select: {
        id: true,
        itemKey: true,
        status: true,
        title: true,
        pendingSubmittedAt: true,
        statusReason: true,
        editRejectionReason: true,
        updatedAt: true,
      },
    });
    return {
      items: rows.map((r) => ({
        id: r.id,
        itemKey: r.itemKey,
        status: r.status as AppSubListingStatus,
        title: r.title,
        pendingEdit: r.pendingSubmittedAt != null,
        statusReason: r.statusReason,
        editRejectionReason: r.editRejectionReason,
        updatedAt: r.updatedAt,
      })),
    };
  } catch (err) {
    rethrowUnavailable(err);
  }
}

/**
 * The off-site listings `clientId` may sync items onto: approved, top-level, linked to the
 * client, with an enabled parent row carrying a link template.
 */
function catalogParentWhere(clientId: string) {
  return {
    connectClientId: clientId,
    kind: 'offsite',
    revisionOfId: null,
    status: 'approved',
    subListingParent: { is: { enabled: true, linkTemplate: { not: null } } },
  } satisfies Prisma.AppListingWhereInput;
}

/**
 * The one listing `clientId` syncs. Nothing in a request selects it: none → 403, and more than
 * one (no index makes `connect_client_id` unique) is a configuration error → 409.
 */
export async function resolveCatalogParentId(clientId: string): Promise<string> {
  let rows: { id: string }[];
  try {
    rows = await dbRead.appListing.findMany({
      where: catalogParentWhere(clientId),
      select: { id: true },
      take: 2,
    });
  } catch (err) {
    rethrowUnavailable(err);
  }
  if (rows.length === 0) {
    throw new SubListingError(403, 'not_enabled', 'This client has no store listing to sync');
  }
  if (rows.length > 1) {
    throw new SubListingError(
      409,
      'parent_ambiguous',
      'This client is linked to more than one store listing'
    );
  }
  return rows[0].id;
}

type CatalogParent = {
  id: string;
  ownerUserId: number;
  contentRating: string | null;
  maxPerAuthor: number;
  linkTemplate: string;
};

async function readCatalogParent(
  parentListingId: string,
  clientId: string
): Promise<CatalogParent> {
  try {
    const listing = await dbRead.appListing.findFirst({
      where: { ...catalogParentWhere(clientId), id: parentListingId },
      select: {
        id: true,
        userId: true,
        contentRating: true,
        subListingParent: { select: { maxPerAuthor: true, linkTemplate: true } },
      },
    });
    const linkTemplate = listing?.subListingParent?.linkTemplate;
    if (!listing || !linkTemplate) {
      throw new SubListingError(403, 'not_enabled', 'This client has no store listing to sync');
    }
    return {
      id: listing.id,
      ownerUserId: listing.userId,
      contentRating: listing.contentRating,
      maxPerAuthor: listing.subListingParent?.maxPerAuthor ?? 0,
      linkTemplate,
    };
  } catch (err) {
    rethrowUnavailable(err);
  }
}

export const upsertCatalogItemBodySchema = z
  .object({
    title: z.string().max(1000),
    tagline: z.string().max(2000).nullish(),
    contentRating: z.enum(APP_SUB_LISTING_CONTENT_RATINGS).nullish(),
    creatorUserId: z.number().int().positive().nullish(),
  })
  .strict();

function assertExternalId(externalId: string) {
  if (!isValidSubListingExternalId(externalId)) {
    throw new SubListingError(
      400,
      'invalid_body',
      'The item id must be 1-64 letters, digits, _ or -'
    );
  }
}

/**
 * The card's author: the listing owner, or a creator who has consented to the token's own
 * client (signed in to the platform with Civitai). Either must pass the shared-write trust check.
 */
async function resolveCatalogAuthor(
  parent: CatalogParent,
  clientId: string,
  creatorUserId: number | null | undefined
): Promise<SessionUser> {
  const authorId = creatorUserId ?? parent.ownerUserId;
  if (authorId !== parent.ownerUserId) {
    const consent = await dbWrite.oauthConsent.findUnique({
      where: { userId_clientId: { userId: authorId, clientId } },
      select: { id: true },
    });
    if (!consent) {
      throw new SubListingError(
        403,
        'creator_not_linked',
        'The creator has not signed in to this app with Civitai'
      );
    }
  }
  const user = (await sessionClient.getSessionUserById(authorId)) as SessionUser | null;
  if (!user) throw new SubListingError(404, 'creator_not_found', 'Creator not found');
  const hasLinkedOAuth = await hasLinkedOAuthAccount(user);
  try {
    assertSharedWriteTrust(user, hasLinkedOAuth);
  } catch {
    throw new SubListingError(403, 'untrusted', 'The creator cannot publish store items yet');
  }
  return user;
}

export type UpsertCatalogSubListingResult = UpsertSubListingResult & { href: string };

/**
 * Publish or edit an off-site parent's catalog item, keyed by its platform id. The same
 * moderation rules as an in-app publish apply (new and edited items wait for a moderator, a
 * hide is a lock); an identical re-sync writes nothing and is not rate limited.
 */
export async function upsertCatalogSubListing(args: {
  parentListingId: string;
  clientId: string;
  externalId: string;
  body: unknown;
}): Promise<UpsertCatalogSubListingResult> {
  assertExternalId(args.externalId);
  const parsed = upsertCatalogItemBodySchema.safeParse(args.body);
  if (!parsed.success) throw new SubListingError(400, 'invalid_body', 'Invalid request body');
  const content = cleanContent({
    itemKey: args.externalId,
    title: parsed.data.title,
    tagline: parsed.data.tagline,
    subPath: args.externalId,
    contentRating: parsed.data.contentRating,
  });

  const parent = await readCatalogParent(args.parentListingId, args.clientId);
  const href = subListingExternalHref(parent.linkTemplate, args.externalId);
  if (!href) {
    throw new SubListingError(400, 'invalid_body', 'The item id does not form a valid link');
  }
  if (!isRatingAtLeastAsStrict(content.contentRating, parent.contentRating)) {
    throw new SubListingError(
      400,
      'rating_too_loose',
      "contentRating may not be less mature than the app's own rating"
    );
  }
  const author = await resolveCatalogAuthor(parent, args.clientId, parsed.data.creatorUserId);
  const authorMismatch = () =>
    new SubListingError(409, 'author_mismatch', 'This item is attributed to another creator');

  try {
    const existing = await dbWrite.appSubListing.findUnique({
      where: {
        parentListingId_itemKey: { parentListingId: parent.id, itemKey: args.externalId },
      },
    });
    if (existing) {
      if (existing.authorUserId !== author.id) throw authorMismatch();
      const status = existing.status as AppSubListingStatus;
      const unchanged =
        (status === 'approved' || status === 'pending') &&
        !existing.pendingSubmittedAt &&
        sameContent(liveContent(existing), content);
      if (status === 'hidden' || unchanged) {
        return { id: existing.id, status, pendingEdit: false, href };
      }
    }
  } catch (err) {
    rethrowUnavailable(err);
  }

  const rate = await checkSubListingSyncRateLimit(parent.id);
  if (!rate.allowed) {
    throw new SubListingError(
      429,
      'rate_limited',
      'Too many store item updates, retry later',
      rate.retryAfterSeconds
    );
  }

  try {
    const safe = await assertSharedTextSafe({
      title: content.title,
      body: content.tagline ?? undefined,
      userId: author.id,
      isModerator: false,
    });
    content.title = safe.title;
    content.tagline = safe.body ?? null;
  } catch (err) {
    if (err instanceof SharedContentBlockedError) {
      throw new SubListingError(400, 'text_rejected', 'The title or tagline was not accepted');
    }
    throw err;
  }

  try {
    const { catalogAffected, ...result } = await writeSubListing(
      parent,
      args.externalId,
      author.id,
      content,
      authorMismatch
    );
    if (catalogAffected) await bustCatalog();
    return { ...result, href };
  } catch (err) {
    rethrowUnavailable(err);
  }
}

/**
 * Withdraw a catalog item, whoever authored it. A hidden item stays hidden, but can then only be
 * restored to review: its platform no longer lists it. Deleting an unknown or already withdrawn
 * item changes nothing and is not rate limited.
 */
export async function withdrawCatalogSubListing(args: {
  parentListingId: string;
  externalId: string;
}): Promise<{ ok: true; withdrawn: boolean }> {
  assertExternalId(args.externalId);
  const where = { parentListingId: args.parentListingId, itemKey: args.externalId };
  try {
    const row = await dbWrite.appSubListing.findUnique({
      where: { parentListingId_itemKey: where },
      select: { status: true, approvedAt: true },
    });
    if (!row || row.status === 'withdrawn' || (row.status === 'hidden' && !row.approvedAt)) {
      return { ok: true, withdrawn: false };
    }
    const rate = await checkSubListingSyncRateLimit(args.parentListingId);
    if (!rate.allowed) {
      throw new SubListingError(
        429,
        'rate_limited',
        'Too many store item updates, retry later',
        rate.retryAfterSeconds
      );
    }
    if (row.status === 'hidden') {
      // Moving `updated_at` also fails a restore that read the row before this change.
      await dbWrite.appSubListing.updateMany({
        where: { ...where, status: 'hidden' },
        data: { approvedAt: null, updatedAt: new Date() },
      });
      return { ok: true, withdrawn: false };
    }
    const count = await transitionActive({
      where,
      data: { status: 'withdrawn', ...CLEAR_PENDING },
    });
    return { ok: true, withdrawn: count > 0 };
  } catch (err) {
    rethrowUnavailable(err);
  }
}

export const CATALOG_LIST_PAGE_SIZE = 100;

export type CatalogSubListing = {
  externalId: string;
  id: string;
  status: AppSubListingStatus;
  title: string;
  creatorUserId: number;
  pendingEdit: boolean;
  statusReason: string | null;
  editRejectionReason: string | null;
  updatedAt: Date;
};

/** Every item under the parent, oldest first, for the platform to diff against its catalog. */
export async function listCatalogSubListings(args: {
  parentListingId: string;
  cursor?: string;
}): Promise<{ items: CatalogSubListing[]; nextCursor: string | null }> {
  if (args.cursor !== undefined && !isAppSubListingId(args.cursor)) {
    throw new SubListingError(400, 'invalid_body', 'Invalid cursor');
  }
  try {
    const rows = await dbRead.appSubListing.findMany({
      where: { parentListingId: args.parentListingId },
      // Ids are ULIDs, so this is creation order, and the primary key serves it.
      orderBy: { id: 'asc' },
      take: CATALOG_LIST_PAGE_SIZE + 1,
      ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        itemKey: true,
        status: true,
        title: true,
        authorUserId: true,
        pendingSubmittedAt: true,
        statusReason: true,
        editRejectionReason: true,
        updatedAt: true,
      },
    });
    const page = rows.slice(0, CATALOG_LIST_PAGE_SIZE);
    return {
      items: page.map((r) => ({
        externalId: r.itemKey,
        id: r.id,
        status: r.status as AppSubListingStatus,
        title: r.title,
        creatorUserId: r.authorUserId,
        pendingEdit: r.pendingSubmittedAt != null,
        statusReason: r.statusReason,
        editRejectionReason: r.editRejectionReason,
        updatedAt: r.updatedAt,
      })),
      nextCursor: rows.length > CATALOG_LIST_PAGE_SIZE ? page[page.length - 1].id : null,
    };
  } catch (err) {
    rethrowUnavailable(err);
  }
}

export type SyncSubListingForSharedRowArgs = {
  appBlockId: string;
  itemKey: string;
  change: 'withdrawn' | 'hidden';
  /** For `withdrawn`: only the author's own item follows their withdraw. */
  authorUserId?: number;
  /** For `hidden`: the moderator who hid the shared row. */
  moderatorId?: number;
};

/**
 * Mirror an in-app removal onto the matching sub-listing. Best-effort: the in-app write has
 * already committed in another database, so a failure here is logged and swallowed (a
 * moderator hide in the store still catches it).
 */
export async function syncSubListingForSharedRow(
  args: SyncSubListingForSharedRowArgs
): Promise<void> {
  // An undefined author would drop the filter and withdraw every author's item for this key.
  if (args.change === 'withdrawn' && args.authorUserId == null) return;
  try {
    const parent = await dbRead.appListing.findFirst({
      where: { appBlockId: args.appBlockId, revisionOfId: null },
      select: { id: true },
    });
    if (!parent) return;
    const where: Prisma.AppSubListingWhereInput = {
      parentListingId: parent.id,
      itemKey: args.itemKey,
      ...(args.change === 'withdrawn' ? { authorUserId: args.authorUserId } : {}),
    };
    // Moves a store-hidden row's version so a restore that read the shared row as live fails
    // its compare-and-set. Best-effort on its own: a failed touch must not stop the transition.
    await dbWrite.appSubListing
      .updateMany({ where: { ...where, status: 'hidden' }, data: { updatedAt: new Date() } })
      .catch((err: unknown) => {
        if (isMissingTableError(err)) throw err;
        logToAxiom({
          name: 'app-sub-listing-shared-sync-failed',
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
          appBlockId: args.appBlockId,
          change: args.change,
        }).catch(() => null);
      });
    await transitionActive({
      where,
      data:
        args.change === 'withdrawn'
          ? { status: 'withdrawn', ...CLEAR_PENDING }
          : {
              status: 'hidden',
              statusReason: 'Hidden in the app by a moderator',
              moderatedById: args.moderatorId ?? null,
              moderatedAt: new Date(),
              ...CLEAR_PENDING,
            },
    });
  } catch (err) {
    // Before the manual-apply migration there is nothing to mirror onto.
    if (isMissingTableError(err)) return;
    logToAxiom({
      name: 'app-sub-listing-shared-sync-failed',
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
      appBlockId: args.appBlockId,
      change: args.change,
    }).catch(() => null);
  }
}

/** The queue: new pending rows plus approved rows carrying a staged edit. */
const QUEUE_WHERE = {
  OR: [{ status: 'pending' }, { status: 'approved', pendingSubmittedAt: { not: null } }],
} satisfies Prisma.AppSubListingWhereInput;

const imageSelect = { select: { url: true } } as const;

export type SubListingQueueRow = {
  id: string;
  status: AppSubListingStatus;
  statusReason: string | null;
  itemKey: string;
  parent: { id: string; slug: string; name: string };
  author: { id: number; username: string | null; image: string | null };
  /** Where an off-site parent's card links to; null for an on-site parent. */
  externalHref: string | null;
  live: SubListingContent & { imageUrl: string | null };
  pending: (SubListingContent & { imageUrl: string | null; submittedAt: Date }) | null;
  createdAt: Date;
  moderatedAt: Date | null;
  /** Echoed back by `moderateSubListing`, so a decision applies only to what was shown. */
  version: string;
};

export async function listSubListingQueue(
  input: ListSubListingQueueInput
): Promise<{ items: SubListingQueueRow[]; nextCursor?: string }> {
  const where: Prisma.AppSubListingWhereInput =
    input.view === 'queue' ? QUEUE_WHERE : { status: input.view };
  try {
    const rows = await dbRead.appSubListing.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: input.limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        status: true,
        statusReason: true,
        itemKey: true,
        title: true,
        tagline: true,
        imageId: true,
        subPath: true,
        contentRating: true,
        image: imageSelect,
        pendingTitle: true,
        pendingTagline: true,
        pendingImageId: true,
        pendingSubPath: true,
        pendingContentRating: true,
        pendingSubmittedAt: true,
        pendingImage: imageSelect,
        createdAt: true,
        moderatedAt: true,
        updatedAt: true,
        parentListing: { select: { id: true, slug: true, name: true, kind: true } },
        author: { select: { id: true, username: true, image: true } },
      },
    });
    const page = rows.slice(0, input.limit);
    const templates = await readParentLinkTemplates(
      page.filter((r) => r.parentListing.kind === 'offsite').map((r) => r.parentListing.id)
    );
    return {
      items: page.map((r) => ({
        id: r.id,
        status: r.status as AppSubListingStatus,
        statusReason: r.statusReason,
        itemKey: r.itemKey,
        parent: { id: r.parentListing.id, slug: r.parentListing.slug, name: r.parentListing.name },
        author: r.author,
        externalHref:
          r.parentListing.kind === 'offsite'
            ? subListingExternalHref(templates.get(r.parentListing.id), r.subPath)
            : null,
        live: {
          title: r.title,
          tagline: r.tagline,
          imageId: r.imageId,
          subPath: r.subPath,
          contentRating: r.contentRating,
          imageUrl: r.image?.url ?? null,
        },
        pending:
          r.pendingSubmittedAt && r.pendingTitle != null && r.pendingSubPath != null
            ? {
                title: r.pendingTitle,
                tagline: r.pendingTagline,
                imageId: r.pendingImageId,
                subPath: r.pendingSubPath,
                contentRating: r.pendingContentRating,
                imageUrl: r.pendingImage?.url ?? null,
                submittedAt: r.pendingSubmittedAt,
              }
            : null,
        createdAt: r.createdAt,
        moderatedAt: r.moderatedAt,
        version: r.updatedAt.toISOString(),
      })),
      nextCursor: rows.length > input.limit ? page[page.length - 1]?.id : undefined,
    };
  } catch (err) {
    rethrowUnavailable(err);
  }
}

/** Each parent's link template; empty before the manual-apply column exists. */
async function readParentLinkTemplates(parentIds: string[]): Promise<Map<string, string>> {
  if (parentIds.length === 0) return new Map();
  const rows = await dbRead.$queryRaw<{ id: string; link_template: string | null }[]>(Prisma.sql`
    SELECT sp.parent_listing_id AS id, ${PARENT_LINK_TEMPLATE_SQL} AS link_template
    FROM app_sub_listing_parents sp
    WHERE sp.parent_listing_id IN (${Prisma.join([...new Set(parentIds)])})
  `);
  return new Map(rows.flatMap((r) => (r.link_template ? [[r.id, r.link_template] as const] : [])));
}

/** The pending count for the tab label: new pending rows plus staged edits. */
export async function countSubListingQueue(): Promise<number> {
  try {
    return await dbRead.appSubListing.count({ where: QUEUE_WHERE });
  } catch (err) {
    if (isMissingTableError(err)) return 0;
    throw err;
  }
}

async function isSharedItemLive(row: {
  parentListingId: string;
  itemKey: string;
  authorUserId: number;
}): Promise<boolean> {
  const parent = await dbRead.appListing.findUnique({
    where: { id: row.parentListingId },
    select: { kind: true, appBlock: { select: { blockId: true } } },
  });
  // An off-site parent's items have no shared row: its platform withdraws them instead.
  if (parent?.kind === 'offsite') return true;
  if (!parent?.appBlock) return false;
  const item = await readSharedItemForSubListing(parent.appBlock.blockId, row.itemKey);
  // Same author as the card: a key the app reused for someone else's item is not this item.
  return item != null && !item.hidden && item.authorUserId === row.authorUserId;
}

export async function moderateSubListing(args: {
  input: ModerateSubListingInput;
  moderatorId: number;
}): Promise<{ id: string; status: AppSubListingStatus; pendingEdit: boolean }> {
  const { id, action, reason, version } = args.input;
  const now = new Date();
  const stamp = { moderatedById: args.moderatorId, moderatedAt: now, updatedAt: now };
  try {
    const row = await dbWrite.appSubListing.findUnique({ where: { id } });
    if (!row) throw new SubListingError(404, 'not_found', 'Store item not found');
    const status = row.status as AppSubListingStatus;
    // The moderator decides on the version the queue showed them; anything the author changed
    // since then has not been reviewed.
    const stale = () =>
      new SubListingError(409, 'conflict', 'This item changed since it was loaded; reload it');
    if (row.updatedAt.getTime() !== new Date(version).getTime()) throw stale();
    const invalid = () =>
      new SubListingError(409, 'invalid_transition', `Cannot ${action} a ${status} store item`);

    let data: Prisma.AppSubListingUncheckedUpdateManyInput;
    switch (action) {
      case 'approve':
        if (status !== 'pending') throw invalid();
        data = { status: 'approved', approvedAt: now, statusReason: null, ...stamp };
        break;
      case 'hide':
        // A withdrawn item is the author's to bring back; hiding it would let a restore
        // republish it over their withdraw.
        if (status !== 'pending' && status !== 'approved') throw invalid();
        data = { status: 'hidden', statusReason: reason || null, ...CLEAR_PENDING, ...stamp };
        break;
      case 'restore':
        if (status !== 'hidden') throw invalid();
        // The in-app moderation sync hides the item when its shared row is hidden or deleted;
        // don't restore a card for an item the app no longer shows.
        if (!(await isSharedItemLive(row))) {
          throw new SubListingError(
            409,
            'invalid_transition',
            'This item is hidden or removed in the app; it cannot be restored here'
          );
        }
        // An item hidden before it was ever approved goes back to review, not into the store.
        data = row.approvedAt
          ? { status: 'approved', statusReason: null, ...stamp }
          : { status: 'pending', statusReason: null, ...stamp };
        break;
      case 'approve-edit':
        if (status !== 'approved' || !row.pendingSubmittedAt || row.pendingTitle == null) {
          throw invalid();
        }
        data = {
          title: row.pendingTitle,
          tagline: row.pendingTagline,
          imageId: row.pendingImageId,
          subPath: row.pendingSubPath ?? row.subPath,
          contentRating: row.pendingContentRating,
          editRejectionReason: null,
          ...CLEAR_PENDING,
          ...stamp,
        };
        break;
      case 'reject-edit':
        if (!row.pendingSubmittedAt) throw invalid();
        data = { editRejectionReason: reason || null, ...CLEAR_PENDING, ...stamp };
        break;
    }

    // Compare-and-set on the row as read, so two moderators acting at once, or an author edit
    // landing between the read and the write, cannot both apply.
    const { count } = await dbWrite.appSubListing.updateMany({
      where: unchangedSince(row),
      data,
    });
    if (count === 0) throw stale();
    const nextStatus = (data.status as AppSubListingStatus | undefined) ?? status;
    // A rejected edit changes no live column, so the cached page is still right.
    if ((status === 'approved' || nextStatus === 'approved') && action !== 'reject-edit') {
      await bustCatalog();
    }
    return {
      id,
      status: nextStatus,
      pendingEdit: data.pendingSubmittedAt === undefined && row.pendingSubmittedAt != null,
    };
  } catch (err) {
    rethrowUnavailable(err);
  }
}

/** The REST shape of a `SubListingError`; `null` for anything else (the caller rethrows). */
export function subListingErrorResponse(err: unknown): {
  status: number;
  body: { error: string; code: SubListingErrorCode };
  retryAfter?: number;
} | null {
  if (!(err instanceof SubListingError)) return null;
  return {
    status: err.status,
    body: { error: err.message, code: err.code },
    retryAfter: err.retryAfterSeconds,
  };
}
