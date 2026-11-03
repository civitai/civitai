import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { createHash } from 'crypto';

import { dbWrite } from '~/server/db/client';
import type { AppListingModerationAction } from '~/server/schema/blocks/offsite-moderation.schema';
import { readListingSourceRepoUrl } from '~/server/services/blocks/app-listing-source-repo.service';
import { readListingRedSlots } from '~/server/services/blocks/listing-media-split.service';
import { newAppListingModerationEventId } from '~/server/utils/app-block-ids';

export const MODERATOR_EDIT_ACTION = 'moderator-edit' satisfies AppListingModerationAction;

export const OWNER_REVISION_IN_PROGRESS_MESSAGE =
  'The owner has an unsubmitted revision in progress; moderator edits are unavailable until it is submitted or discarded.';

export const REVISION_IN_REVIEW_MESSAGE =
  'A revision of this listing is awaiting review; moderator edits are unavailable until it is reviewed.';

export type ModeratorEditSurface = 'details' | 'media' | 'revision';

const SURFACE_REASON: Record<ModeratorEditSurface, string> = {
  details: "A moderator edited this listing's details.",
  media: "A moderator edited this listing's store media.",
  revision: 'A moderator submitted a revision of this listing for review.',
};

type ModeratorEditDb = Prisma.TransactionClient | typeof dbWrite;

/** Everything a revision can change, in a stable shape, so a shadow and its parent compare. */
async function listingContentFingerprint(db: ModeratorEditDb, listingId: string) {
  const row = await db.appListing.findUnique({
    where: { id: listingId },
    select: {
      name: true,
      tagline: true,
      description: true,
      category: true,
      contentRating: true,
      externalUrl: true,
      connectClientId: true,
      connectRequestedScopes: true,
      connectScopeJustifications: true,
      iconId: true,
      coverId: true,
    },
  });
  if (!row) return null;
  const shots = await db.appListingScreenshot.findMany({
    where: { appListingId: listingId },
    select: { imageId: true, order: true, caption: true },
    orderBy: { order: 'asc' },
  });
  const red = await readListingRedSlots(db, listingId);
  // The column read catches a missing-column error, which would abort an open transaction,
  // so its availability is probed on a separate connection first.
  const repoProbe = await readListingSourceRepoUrl(listingId, dbWrite);
  const repo =
    repoProbe.available && db !== dbWrite
      ? await readListingSourceRepoUrl(listingId, db)
      : repoProbe;
  const json = JSON.stringify([
    row.name,
    row.tagline,
    row.description,
    row.category,
    row.contentRating,
    row.externalUrl,
    row.connectClientId,
    row.connectRequestedScopes,
    row.connectScopeJustifications,
    row.iconId,
    row.coverId,
    // The sequence, not the `order` numbers: a removal re-packs those afterwards.
    shots.map((s) => [s.imageId, s.caption]),
    red.redIconId,
    red.redCoverId,
    repo.value,
  ]);
  return createHash('sha256').update(json).digest('hex');
}

/**
 * A moderator may work on a shadow revision only while it holds nothing but their own
 * edits: it still matches its parent, or it is exactly what this moderator last saved
 * (the fingerprint on their latest `moderator-edit` event for it). Anything else is
 * someone else's unsubmitted work, and the moderator is refused, as they are from any
 * revision already awaiting review. Pass the write's transaction so the check holds until
 * the write commits.
 */
export async function assertModeratorMayUseShadow(
  db: ModeratorEditDb,
  args: { shadowId: string; actorUserId: number }
): Promise<void> {
  // Inside the write's transaction, hold the shadow and its screenshot rows so an owner
  // save to either waits until the moderator's write and its fingerprint have committed.
  if (db !== dbWrite) {
    await db.$queryRaw(
      Prisma.sql`SELECT 1 FROM app_listings WHERE id = ${args.shadowId} FOR UPDATE`
    );
    await db.$queryRaw(
      Prisma.sql`SELECT 1 FROM app_listing_screenshots WHERE app_listing_id = ${args.shadowId} FOR UPDATE`
    );
  }
  const shadow = await db.appListing.findUnique({
    where: { id: args.shadowId },
    select: { revisionOfId: true },
  });
  if (!shadow?.revisionOfId) return;
  const inReview = await db.appListingPublishRequest.findFirst({
    where: { appListingId: args.shadowId, status: 'pending' },
    select: { id: true },
  });
  if (inReview) throw new TRPCError({ code: 'FORBIDDEN', message: REVISION_IN_REVIEW_MESSAGE });
  const [current, parent] = await Promise.all([
    listingContentFingerprint(db, args.shadowId),
    listingContentFingerprint(db, shadow.revisionOfId),
  ]);
  if (current != null && current === parent) return;
  const last = await db.appListingModerationEvent.findFirst({
    where: {
      appListingId: shadow.revisionOfId,
      action: MODERATOR_EDIT_ACTION,
      after: { path: ['shadowId'], equals: args.shadowId },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { actorUserId: true, after: true },
  });
  const lastFingerprint = (last?.after as { contentHash?: unknown } | null)?.contentHash;
  if (last?.actorUserId === args.actorUserId && lastFingerprint === current) return;
  throw new TRPCError({ code: 'FORBIDDEN', message: OWNER_REVISION_IN_PROGRESS_MESSAGE });
}

/**
 * Audit row for a moderator editing a listing they hold no seat on. Call it AFTER the
 * write, in the same transaction: a missing action CHECK then rolls the write back, and a
 * refused save leaves no row. A shadow is recorded on its parent, with the fingerprint
 * {@link assertModeratorMayUseShadow} reads.
 */
export async function recordModeratorListingEdit(args: {
  db?: ModeratorEditDb;
  appListingId: string;
  actorUserId: number;
  surface: ModeratorEditSurface;
}): Promise<void> {
  const db = args.db ?? dbWrite;
  const listing = await db.appListing.findUnique({
    where: { id: args.appListingId },
    select: { id: true, slug: true, revisionOf: { select: { id: true, slug: true } } },
  });
  if (!listing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Listing not found' });
  const target = listing.revisionOf ?? listing;
  const after = listing.revisionOf
    ? {
        shadowId: listing.id,
        contentHash: await listingContentFingerprint(db, listing.id),
      }
    : undefined;
  await db.appListingModerationEvent.create({
    data: {
      id: newAppListingModerationEventId(),
      appListingId: target.id,
      slug: target.slug,
      action: MODERATOR_EDIT_ACTION,
      actorUserId: args.actorUserId,
      reason: SURFACE_REASON[args.surface],
      detail: args.surface,
      ...(after ? { after } : {}),
    },
  });
}

/** Run a write, and when a seatless moderator made it, its audit row, as one transaction. */
export async function withModeratorEditAudit<T>(
  audit: {
    moderator: boolean;
    appListingId: string;
    actorUserId: number;
    surface: ModeratorEditSurface;
  },
  write: (db: ModeratorEditDb) => Promise<T>
): Promise<T> {
  if (!audit.moderator) return write(dbWrite);
  return dbWrite.$transaction(async (tx) => {
    const result = await write(tx);
    await recordModeratorListingEdit({ ...audit, db: tx });
    return result;
  });
}
