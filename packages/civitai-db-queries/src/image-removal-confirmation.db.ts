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

/**
 * The label of the last removal at or before the approval: the one the appeal overturned. Null when
 * that removal carries no label, undefined when there is no such removal.
 */
export function overturnedRemovalLabel(
  events: RemovalEvent[],
  approvedAt: Date
): string | null | undefined {
  let last: { at: number; label: string | null } | undefined;
  for (const e of events) {
    // ClickHouse `DateTime` renders as 'YYYY-MM-DD hh:mm:ss' in UTC.
    const at = Date.parse(`${e.time.replace(' ', 'T')}Z`);
    if (Number.isNaN(at) || at > approvedAt.getTime()) continue;
    if (!last || at >= last.at) last = { at, label: e.label };
  }
  return last ? last.label || null : undefined;
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
  /** 0 when the caller named no moderator. */
  requestedById: number;
  source: string;
  knownReasons: ReadonlySet<string>;
  /** ClickHouse, for the removal each appeal overturned. Failures hold. */
  clickhouse?: ClickhouseQuery;
}): Promise<{ held: HeldRemoval[]; proceed: number[] }> {
  const { db, requestedById, source, knownReasons, clickhouse } = opts;
  // One request per image: a batch naming an image twice would update its row twice in one statement.
  const requests = [...new Map(opts.requests.map((r) => [r.imageId, r])).values()];
  const appeals = await getLatestApprovedImageAppeals(
    db,
    requests.map((r) => r.imageId)
  );
  if (!appeals.size) return { held: [], proceed: requests.map((r) => r.imageId) };

  // Already removed: nothing would be undone a second time, and the removal's reports still need
  // actioning, so it goes through.
  const removed = new Set(
    (
      await db
        .selectFrom('Image')
        .select('id')
        .where('id', 'in', [...appeals.keys()])
        .where('ingestion', '=', 'Blocked')
        .where('blockedFor', '=', 'moderated')
        // An account-deletion grace block looks the same but is undone if the account is restored.
        .where(sql<boolean>`("metadata" -> 'accountDeletionPriorIngestion') IS NULL`)
        .execute()
    ).map((r) => r.id)
  );

  // The decision record's label is filled later from the LATEST removal, which can postdate the
  // approval, so the time-bounded ClickHouse read wins when it answers.
  const eventsByImage = new Map<number, RemovalEvent[]>();
  let eventsRead = false;
  const lookup = [...appeals.keys()].filter((id) => !removed.has(id));
  if (lookup.length && clickhouse) {
    try {
      for (const e of await loadRemovalEvents(clickhouse, lookup)) {
        const list = eventsByImage.get(e.imageId) ?? [];
        list.push(e);
        eventsByImage.set(e.imageId, list);
      }
      eventsRead = true;
    } catch (e) {
      console.error('[image-removal-confirmation] removal label lookup failed', e);
    }
  }

  const toHold: { request: RemovalRequest; appeal: ApprovedImageAppeal }[] = [];
  const proceed: number[] = [];
  for (const request of requests) {
    const appeal = appeals.get(request.imageId);
    if (!appeal || removed.has(request.imageId)) {
      proceed.push(request.imageId);
      continue;
    }
    const event = eventsRead
      ? overturnedRemovalLabel(eventsByImage.get(request.imageId) ?? [], appeal.approvedAt)
      : null;
    const overturned = event === undefined ? appeal.removalLabel : event;
    if (isSameRemovalReason(overturned, request.violationType, knownReasons))
      toHold.push({ request, appeal });
    else proceed.push(request.imageId);
  }
  if (!toHold.length) return { held: [], proceed };

  // A removal that joins a pending request adds its reports to it, so confirming actions them all,
  // and moves it to the appeal it was checked against, so a confirmation weighs the latest one.
  const rows = await db
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
    .onConflict((oc) =>
      oc
        .column('imageId')
        .where('status', '=', 'Pending')
        .doUpdateSet({
          appealId: sql<number>`excluded."appealId"`,
          reportIds: sql<
            number[]
          >`ARRAY(SELECT DISTINCT unnest("ImageRemovalConfirmation"."reportIds" || excluded."reportIds"))`,
        })
    )
    // `xmax = 0` only on a freshly inserted row.
    .returning(['id', 'imageId', sql<boolean>`xmax = 0`.as('created')])
    .execute();
  const byImage = new Map(rows.map((r) => [r.imageId, r]));

  const held = toHold.map(({ request, appeal }) => {
    const row = byImage.get(request.imageId)!;
    return { imageId: request.imageId, confirmationId: row.id, created: row.created, appeal };
  });
  return { held, proceed };
}
