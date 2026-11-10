import { sql } from '@civitai/db/kysely';
import { dbRead, dbWrite } from './db';
import { callModEndpoint } from './user-actions.service';

/**
 * Personal-data exports (access requests), as the dashboard sees them. This app only queues a row and
 * reads status; the main app's `build-personal-data-exports` job builds the archive, and its
 * `/api/mod/user/personal-data-export-release` endpoint sends it to the account owner.
 */

export const EXPORT_STATUSES = [
  'queued',
  'building',
  'built',
  'held',
  'failed',
  'released',
] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];

export type ExportSummary = {
  id: number;
  userId: number;
  status: ExportStatus;
  createdAt: Date;
  builtAt: Date | null;
  releasedAt: Date | null;
};

export type QueueResult =
  | { status: 'queued'; id: number }
  | { status: 'already-queued' }
  | { status: 'no-user' }
  | { status: 'error' };

/**
 * Queues an export. A second queue while one is queued or building is refused by the database's
 * partial unique index, not by this check: two presses at once still produce one row.
 */
export type QueueInput = {
  userId: number;
  requestedById: number;
  /** The help-desk ticket the request came in on; null when queued from the dashboard. */
  ticketId: number | null;
  /** The date the user asked: the ticket's own date, or the date the moderator entered. */
  requestedAt: Date;
};

export async function queuePersonalDataExport(input: QueueInput): Promise<QueueResult> {
  const user = await dbWrite
    .selectFrom('User')
    .select('id')
    .where('id', '=', input.userId)
    .executeTakeFirst();
  if (!user) return { status: 'no-user' };
  // The export row and its audit row commit together or not at all: an export is a copy of the
  // account's data, and every one must be accountable to the moderator who queued it.
  try {
    return await dbWrite.transaction().execute(async (tx) => {
      const row = await tx
        .insertInto('PersonalDataExport')
        .values({
          userId: input.userId,
          requestedById: input.requestedById,
          ticketId: input.ticketId,
          // A DATE column: the UTC calendar day.
          requestedAt: input.requestedAt.toISOString().slice(0, 10),
        })
        .onConflict((oc) =>
          oc
            .column('userId')
            .where(sql<boolean>`status IN ('queued', 'building')`)
            .doNothing()
        )
        .returning('id')
        .executeTakeFirst();
      if (!row) return { status: 'already-queued' as const };
      // Targetless ON CONFLICT, as recordModActivity has it (see its comment).
      await tx
        .insertInto('ModActivity')
        .values({
          userId: input.requestedById,
          entityType: 'user',
          entityId: input.userId,
          activity: 'queuePersonalDataExport',
        })
        .onConflict((oc) => oc.doNothing())
        .execute();
      return { status: 'queued' as const, id: row.id };
    });
  } catch (e) {
    console.error('[personal-data-export] queue failed; nothing was queued', e);
    return { status: 'error' };
  }
}

/** The user's most recent export, for the ticket account panel. */
export async function latestPersonalDataExport(userId: number): Promise<ExportSummary | null> {
  const row = await dbRead
    .selectFrom('PersonalDataExport')
    .select(['id', 'userId', 'status', 'createdAt', 'builtAt', 'releasedAt'])
    .where('userId', '=', userId)
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row ? { ...row, status: row.status as ExportStatus } : null;
}

export type ExportListRow = ExportSummary & {
  username: string | null;
  requestedBy: string | null;
  error: string | null;
  sentAt: Date | null;
  linkExpiresAt: Date | null;
  /** Per-file row counts and statuses, as the job recorded them. */
  manifest: unknown;
};

/** Which hold applies is not listed: the page says held, and Legal knows why. */
export async function listPersonalDataExports(opts: {
  status?: ExportStatus;
  limit: number;
}): Promise<ExportListRow[]> {
  let q = dbRead
    .selectFrom('PersonalDataExport as e')
    .leftJoin('User as u', 'u.id', 'e.userId')
    .leftJoin('User as r', 'r.id', 'e.requestedById')
    .select([
      'e.id',
      'e.userId',
      'e.status',
      'e.createdAt',
      'e.builtAt',
      'e.releasedAt',
      'e.sentAt',
      'e.linkExpiresAt',
      'e.error',
      'e.manifest',
      'u.username as username',
      'r.username as requestedBy',
    ])
    .orderBy('e.id', 'desc')
    .limit(opts.limit);
  if (opts.status) q = q.where('e.status', '=', opts.status);
  const rows = await q.execute();
  return rows.map((r) => ({ ...r, status: r.status as ExportStatus }));
}

const RELEASE_MAY_HAVE_COMPLETED =
  'Could not confirm the release. Reload the page to see whether it was sent before trying again.';

/** Sends a built export to the account owner, through the main app, which re-checks every hold. */
export async function releasePersonalDataExport(
  exportId: number
): Promise<{ ok: true; linkExpiresAt: string } | { ok: false; error: string }> {
  const result = await callModEndpoint(
    'user/personal-data-export-release',
    { exportId },
    'Release personal data export'
  );
  if (!result.ok) {
    const lost = result.status === undefined ? !result.requestNeverSent : result.status >= 500;
    return { ok: false, error: lost ? RELEASE_MAY_HAVE_COMPLETED : result.error };
  }
  const { linkExpiresAt } = result.body;
  if (typeof linkExpiresAt !== 'string') return { ok: false, error: RELEASE_MAY_HAVE_COMPLETED };
  return { ok: true, linkExpiresAt };
}
