import { sql, type Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

// A removal that repeats the reason an image's approved appeal overturned does not take effect on one
// moderator's say: it is held as an `ImageRemovalConfirmation` row until a moderator with the
// `image.removal.confirm` permission confirms or declines it. A removal for a different reason goes
// through. Both apps' block paths call `holdSameReasonRemovals`, so the rule lives here once.

export type ApprovedImageAppeal = {
  imageId: number;
  appealId: number;
  approvedAt: Date;
  approvedById: number | null;
  approvedByUsername: string | null;
  resolvedReason: string | null;
  resolvedMessage: string | null;
  /** The violation the overturned removal was filed under, when the decision record has it. */
  removalLabel: string | null;
};

/** The latest approved appeal per image, for the images that have one. */
export async function getLatestApprovedImageAppeals(
  db: Kysely<DB>,
  imageIds: number[]
): Promise<Map<number, ApprovedImageAppeal>> {
  if (!imageIds.length) return new Map();
  const rows = await db
    .selectFrom('Appeal as a')
    .leftJoin('User as u', 'u.id', 'a.resolvedBy')
    .leftJoin('AppealDecisionRecord as d', 'd.appealId', 'a.id')
    .distinctOn('a.entityId')
    .select([
      'a.entityId as imageId',
      'a.id as appealId',
      // "resolvedAt" is a zoneless timestamp holding UTC; read as-is, node-postgres would take it as
      // server-local time. "updatedAt" stands in for approvals that never stamped it.
      sql<Date>`coalesce(a."resolvedAt", a."updatedAt") AT TIME ZONE 'UTC'`.as('approvedAt'),
      'a.resolvedBy as approvedById',
      'u.username as approvedByUsername',
      'a.resolvedReason',
      'a.resolvedMessage',
      'd.removalLabel',
    ])
    .where('a.entityType', '=', 'Image')
    .where('a.entityId', 'in', imageIds)
    .where('a.status', '=', 'Approved')
    .orderBy('a.entityId')
    .orderBy(sql`coalesce(a."resolvedAt", a."updatedAt")`, 'desc')
    .orderBy('a.id', 'desc')
    .execute();
  return new Map(rows.map((r) => [r.imageId, r]));
}

/** One moderator removal as the ClickHouse `images` table logged it (`type = 'DeleteTOS'`). */
export type RemovalEvent = { imageId: number; time: string; label: string | null };

/** A ClickHouse `$query` (`@civitai/clickhouse`). Injected so this package needs no ClickHouse client. */
export type ClickhouseQuery = <T extends object>(
  query: TemplateStringsArray,
  ...values: unknown[]
) => Promise<T[]>;

export function loadRemovalEvents(query: ClickhouseQuery, imageIds: number[]) {
  return query<RemovalEvent>`
    SELECT imageId, toString(time) AS time, coalesce(nullIf(violationType, ''), tosReason) AS label
    FROM images
    WHERE type = 'DeleteTOS' AND imageId IN (${imageIds})
  `;
}

/** The label of the last removal at or before the approval: the one the appeal overturned. */
export function overturnedRemovalLabel(events: RemovalEvent[], approvedAt: Date): string | null {
  let last: { at: number; label: string | null } | undefined;
  for (const e of events) {
    // ClickHouse `DateTime` renders as 'YYYY-MM-DD hh:mm:ss' in UTC.
    const at = Date.parse(`${e.time.replace(' ', 'T')}Z`);
    if (Number.isNaN(at) || at > approvedAt.getTime()) continue;
    if (!last || at >= last.at) last = { at, label: e.label };
  }
  return last?.label || null;
}

/**
 * Whether a new removal repeats the overturned one. A reason not in `knownReasons` (none chosen, a
 * catch-all, free text, or the lookup failed) cannot be shown to differ, so it counts as the same.
 */
export function isSameRemovalReason(
  overturned: string | null,
  requested: string | null | undefined,
  knownReasons: ReadonlySet<string>
): boolean {
  if (!overturned || !knownReasons.has(overturned)) return true;
  if (!requested || !knownReasons.has(requested)) return true;
  return overturned === requested;
}

export type RemovalRequest = {
  imageId: number;
  violationType?: string | null;
  violationDetails?: string | null;
  reportIds?: number[];
};

export type HeldRemoval = {
  imageId: number;
  confirmationId: number;
  /** False when the image already had a pending request, which this removal joined. */
  created: boolean;
  appeal: ApprovedImageAppeal;
};

/**
 * Splits removals into the ones to apply now and the ones held for confirmation, writing a Pending
 * row for each held one. Call it before the block is written; a held image must stay untouched.
 */
export async function holdSameReasonRemovals(opts: {
  db: Kysely<DB>;
  requests: RemovalRequest[];
  requestedById: number;
  source: string;
  knownReasons: ReadonlySet<string>;
  /** ClickHouse, for approvals whose decision record has no removal label yet. Failures hold. */
  clickhouse?: ClickhouseQuery;
}): Promise<{ held: HeldRemoval[]; proceed: number[] }> {
  const { db, requests, requestedById, source, knownReasons, clickhouse } = opts;
  const appeals = await getLatestApprovedImageAppeals(
    db,
    requests.map((r) => r.imageId)
  );
  if (!appeals.size) return { held: [], proceed: requests.map((r) => r.imageId) };

  const unlabelled = [...appeals.values()].filter((a) => !a.removalLabel).map((a) => a.imageId);
  const eventsByImage = new Map<number, RemovalEvent[]>();
  if (unlabelled.length && clickhouse) {
    try {
      for (const e of await loadRemovalEvents(clickhouse, unlabelled)) {
        const list = eventsByImage.get(e.imageId) ?? [];
        list.push(e);
        eventsByImage.set(e.imageId, list);
      }
    } catch (e) {
      console.error('[image-removal-confirmation] removal label lookup failed', e);
    }
  }

  const toHold: { request: RemovalRequest; appeal: ApprovedImageAppeal }[] = [];
  const proceed: number[] = [];
  for (const request of requests) {
    const appeal = appeals.get(request.imageId);
    const overturned = appeal
      ? appeal.removalLabel ??
        overturnedRemovalLabel(eventsByImage.get(request.imageId) ?? [], appeal.approvedAt)
      : null;
    if (appeal && isSameRemovalReason(overturned, request.violationType, knownReasons))
      toHold.push({ request, appeal });
    else proceed.push(request.imageId);
  }
  if (!toHold.length) return { held: [], proceed };

  const inserted = await db
    .insertInto('ImageRemovalConfirmation')
    .values(
      toHold.map(({ request, appeal }) => ({
        imageId: request.imageId,
        appealId: appeal.appealId,
        requestedById,
        violationType: request.violationType ?? null,
        violationDetails: request.violationDetails ?? null,
        source,
        reportIds: request.reportIds ?? [],
      }))
    )
    .onConflict((oc) => oc.column('imageId').where('status', '=', 'Pending').doNothing())
    .returning(['id', 'imageId'])
    .execute();
  const createdIds = new Map(inserted.map((r) => [r.imageId, r.id]));

  const joined = toHold.filter(({ request }) => !createdIds.has(request.imageId));
  const existing = joined.length
    ? await db
        .selectFrom('ImageRemovalConfirmation')
        .select(['id', 'imageId'])
        .where('status', '=', 'Pending')
        .where(
          'imageId',
          'in',
          joined.map(({ request }) => request.imageId)
        )
        .execute()
    : [];
  const existingIds = new Map(existing.map((r) => [r.imageId, r.id]));

  const held: HeldRemoval[] = [];
  for (const { request, appeal } of toHold) {
    const createdId = createdIds.get(request.imageId);
    const confirmationId = createdId ?? existingIds.get(request.imageId);
    // The pending request was decided between the insert and the read. Refuse rather than apply a
    // removal no one confirmed; a retry files a fresh request.
    if (confirmationId == null)
      throw new Error(`Image ${request.imageId} changed while it was being removed. Try again.`);
    held.push({ imageId: request.imageId, confirmationId, created: createdId != null, appeal });
  }
  return { held, proceed };
}
