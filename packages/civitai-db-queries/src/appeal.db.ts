import { type Kysely, type Selectable } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

// Enum column values derived from the schema so this module needs no separate enum import.
type AppealStatusValue = Selectable<DB['Appeal']>['status'];
type EntityTypeValue = Selectable<DB['Appeal']>['entityType'];

// ── Reads ──────────────────────────────────────────────────────────────────────────────────────────────

// A user's 10 most recent appeals, newest first.
export function getRecentAppealsByUserId(db: Kysely<DB>, userId: number) {
  return db
    .selectFrom('Appeal')
    .selectAll()
    .where('userId', '=', userId)
    .orderBy('createdAt', 'desc')
    .limit(10)
    .execute();
}

// Count a user's appeals in the given statuses (optionally since `startDate`). Guards the empty-status case
// (Kysely compiles `in ([])` to `IN ()`, a syntax error) by returning 0 without touching the DB.
export async function getAppealCount(
  db: Kysely<DB>,
  {
    userId,
    status,
    startDate,
  }: {
    userId: number;
    status: AppealStatusValue[];
    startDate?: Date;
  }
): Promise<number> {
  if (!status.length) return 0;
  let query = db
    .selectFrom('Appeal')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('userId', '=', userId)
    .where('status', 'in', status);
  if (startDate) query = query.where('createdAt', '>=', startDate);
  const row = await query.executeTakeFirst();
  return Number(row?.count ?? 0);
}

// One appeal by id (full row), or undefined if absent. The caller owns the not-found throw + entity-detail
// enrichment that the service's getAppealDetails wraps around this.
export function getAppealById(db: Kysely<DB>, id: number) {
  return db.selectFrom('Appeal').selectAll().where('id', '=', id).executeTakeFirst();
}

// The Image entity-detail fields getAppealDetails surfaces for an Image appeal (id/url/userId). Only Image is
// enriched today; other entity types fall back to label-only in the service.
export function getAppealImageEntity(db: Kysely<DB>, imageId: number) {
  return db
    .selectFrom('Image')
    .select(['id', 'url', 'userId'])
    .where('id', '=', imageId)
    .executeTakeFirst();
}

// The pending appeals a bulk resolution will close: those whose entityId is in `ids`, for one entityType,
// still Pending. Snapshotted BEFORE the status update so the caller's dropped refund/notify/email cascade can
// use them. Guards the empty-array case.
export async function getPendingAppealsForResolve(
  db: Kysely<DB>,
  { ids, entityType }: { ids: number[]; entityType: EntityTypeValue }
) {
  if (!ids.length) return [];
  return db
    .selectFrom('Appeal')
    .select(['id', 'entityId', 'entityType', 'resolvedAt', 'buzzTransactionId', 'status', 'userId'])
    .where('entityId', 'in', ids)
    .where('status', '=', 'Pending')
    .where('entityType', '=', entityType)
    .execute();
}

// ── Writes ─────────────────────────────────────────────────────────────────────────────────────────────

// Insert an appeal. The buzz-fee charge (and the buzzTransactionId it produces) is a caller-side side effect
// that is intentionally DROPPED from this core; a caller that still charges may pass the resulting
// `buzzTransactionId` through. `updatedAt` is set explicitly (Prisma `@updatedAt`, no DB trigger).
export function createEntityAppeal(
  db: Kysely<DB>,
  {
    entityId,
    entityType,
    message,
    userId,
    buzzTransactionId = null,
  }: {
    entityId: number;
    entityType: EntityTypeValue;
    message: string;
    userId: number;
    buzzTransactionId?: string | null;
  }
) {
  return db
    .insertInto('Appeal')
    .values({
      entityId,
      entityType,
      appealMessage: message,
      userId,
      buzzTransactionId,
      updatedAt: new Date(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

// Close the pending Image appeal — set status + resolver + resolvedAt (and resolvedMessage when the caller
// passes one). `updatedAt` is auto-stamped by the plugin — Appeal is `@updatedAt`, and the Prisma source
// (`appeal.updateMany`) bumped it too, so this preserves parity. The dropped refund/notify/email cascade is
// the caller's.
export function setImageAppealStatus(
  db: Kysely<DB>,
  {
    imageId,
    status,
    userId,
    resolvedMessage,
  }: {
    imageId: number;
    status: AppealStatusValue;
    userId: number;
    resolvedMessage?: string | null;
  }
) {
  return db
    .updateTable('Appeal')
    .set({
      status,
      resolvedBy: userId,
      resolvedAt: new Date(),
      ...(resolvedMessage !== undefined ? { resolvedMessage } : {}),
    })
    .where('entityType', '=', 'Image')
    .where('entityId', '=', imageId)
    .where('status', '=', 'Pending')
    .execute();
}

// Bulk-close appeals by their (appeal) ids: stamp status + resolver + resolution fields + resolvedAt. The
// buzz refund / notification / email cascade is the caller's (DROPPED here). `updatedAt` is auto-stamped by
// the @updatedAt plugin (Appeal is `@updatedAt`; the Prisma source bumped it too). Guards the empty-array case.
export async function setAppealStatusMany(
  db: Kysely<DB>,
  {
    ids,
    status,
    userId,
    resolvedMessage,
    internalNotes,
  }: {
    ids: number[];
    status: AppealStatusValue;
    userId?: number;
    resolvedMessage?: string | null;
    internalNotes?: string | null;
  }
) {
  if (!ids.length) return { numUpdatedRows: BigInt(0) };
  return db
    .updateTable('Appeal')
    .set({
      status,
      resolvedBy: userId ?? null,
      resolvedMessage: resolvedMessage ?? null,
      internalNotes: internalNotes ?? null,
      resolvedAt: new Date(),
    })
    .where('id', 'in', ids)
    .executeTakeFirst();
}
