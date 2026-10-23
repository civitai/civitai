import { sql, type Kysely } from 'kysely';
import type { Generated, Timestamp } from '../moderator-db/types';
import { SCAN_PROBE_LIMITS, type ProbeRun, type RunStatus } from '$lib/scan-probe';
import type { ScanVerdict } from './workflow';

/** Hand-declared: the table is hand-applied (`apps/moderator/scan-probe/schema.sql`), not pulled. */
export type ScanProbeTables = {
  image_scan_probe_run: {
    id: Generated<string>;
    created_at: Generated<Timestamp>;
    moderator_id: number;
    image_id: number;
    status: Generated<RunStatus>;
    workflow_id: string | null;
    workflow_status: string | null;
    completed_at: Timestamp | null;
    nsfw_level: string | null;
    blocked_reason: string | null;
    csam: boolean | null;
    cached: Generated<'yes' | 'no' | 'unknown'>;
    tripped: Generated<boolean>;
    breaker_reset_at: Timestamp | null;
    breaker_reset_by: number | null;
  };
};

export type ScanProbeDb = Kysely<ScanProbeTables>;

/**
 * Terminal statuses the probe records itself, each of which trips the breaker: the workflow may have
 * run and its verdict cannot be read.
 */
export const UNRESOLVED_OUTCOME = {
  /** The submit timed out, threw or answered without an id: it may have been accepted. */
  unknownSubmit: 'unknown-submit',
  /** The orchestrator says the workflow does not exist (404/410). */
  gone: 'gone',
  /** A `pending` row nobody settled: the process died between the audit write and the submit. */
  abandoned: 'abandoned',
  /** The id came back under an account other than the system account. */
  wrongAccount: 'wrong-account',
} as const;

/** A `pending` row older than this was abandoned; a submit is bounded well below it. */
const PENDING_ABANDONED_AFTER = sql<Date>`now() - interval '10 minutes'`;

export type ReserveRefusal = 'breaker' | 'in-flight' | 'moderator-hourly' | 'global-daily';
export type ReserveResult =
  | { ok: true; runs: { id: string; imageId: number }[] }
  | { ok: false; reason: ReserveRefusal };

/**
 * Writes one `pending` row per image, or none. The rows ARE the counters and the breaker, so every
 * check and the insert share one transaction under an advisory lock: two runs racing cannot both
 * read the state from before the other's insert.
 *
 * 🔴 Refuses while the breaker is tripped, and while ANY earlier run is unresolved: a scan's verdict
 * is only known once it finishes, so one batch in flight at a time is what bounds how many blocks
 * can land before the breaker sees the first.
 */
export async function reserveRuns(
  db: ScanProbeDb,
  moderatorId: number,
  imageIds: number[]
): Promise<ReserveResult> {
  return db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext('image_scan_probe_run'))`.execute(trx);
    const state = await trx
      .selectFrom('image_scan_probe_run')
      .select([
        sql<number>`count(*) FILTER (WHERE tripped AND breaker_reset_at IS NULL)::int`.as(
          'tripped'
        ),
        // 🔴 No age limit: a run whose verdict never arrives must hold the probe, not time out of it.
        sql<number>`count(*) FILTER (WHERE workflow_status IS NULL
          AND status <> 'submit-failed')::int`.as('inFlight'),
        sql<number>`count(*) FILTER (WHERE moderator_id = ${moderatorId}
          AND created_at > now() - interval '1 hour')::int`.as('hourly'),
        sql<number>`count(*) FILTER (WHERE created_at > now() - interval '1 day')::int`.as('daily'),
      ])
      .executeTakeFirstOrThrow();
    if (state.tripped > 0) return { ok: false, reason: 'breaker' } as const;
    if (state.inFlight > 0) return { ok: false, reason: 'in-flight' } as const;
    if (state.hourly + imageIds.length > SCAN_PROBE_LIMITS.perModeratorPerHour)
      return { ok: false, reason: 'moderator-hourly' } as const;
    if (state.daily + imageIds.length > SCAN_PROBE_LIMITS.globalPerDay)
      return { ok: false, reason: 'global-daily' } as const;

    const rows = await trx
      .insertInto('image_scan_probe_run')
      .values(imageIds.map((imageId) => ({ moderator_id: moderatorId, image_id: imageId })))
      .returning(['id', 'image_id'])
      .execute();
    if (rows.length !== imageIds.length) throw new Error('scan probe audit insert incomplete');
    return {
      ok: true,
      runs: rows.map((r) => ({ id: String(r.id), imageId: r.image_id })),
    } as const;
  });
}

export type SubmitOutcome =
  | { workflowId: string }
  /** No id came back from a submit that was sent: it may have been accepted, so it trips. */
  | { unknown: true }
  /** Never sent. */
  | { skipped: true };

/** Moves a `pending` row to its submit outcome. Returns false when no pending row matched. */
export async function settleSubmit(
  db: ScanProbeDb,
  runId: string,
  outcome: SubmitOutcome
): Promise<boolean> {
  const result = await db
    .updateTable('image_scan_probe_run')
    .set(
      'workflowId' in outcome
        ? { status: 'submitted', workflow_id: outcome.workflowId }
        : 'unknown' in outcome
        ? {
            status: 'submit-failed',
            workflow_status: UNRESOLVED_OUTCOME.unknownSubmit,
            tripped: true,
            completed_at: sql<Date>`now()`,
          }
        : { status: 'submit-failed', completed_at: sql<Date>`now()` }
    )
    .where('id', '=', runId)
    .where('status', '=', 'pending')
    .executeTakeFirst();
  return Number(result.numUpdatedRows) === 1;
}

/** Submitted runs whose verdict is not recorded yet, across every moderator. */
export async function unresolvedRuns(db: ScanProbeDb) {
  return db
    .selectFrom('image_scan_probe_run')
    .select(['id', 'workflow_id'])
    .where('status', '=', 'submitted')
    .where('workflow_id', 'is not', null)
    .where('workflow_status', 'is', null)
    .execute();
}

/** Trips every `pending` row old enough that its submit cannot still be running. */
export async function tripAbandonedPending(db: ScanProbeDb): Promise<void> {
  await db
    .updateTable('image_scan_probe_run')
    .set({
      workflow_status: UNRESOLVED_OUTCOME.abandoned,
      tripped: true,
      completed_at: sql<Date>`now()`,
    })
    .where('status', '=', 'pending')
    .where('workflow_status', 'is', null)
    .where('created_at', '<', PENDING_ABANDONED_AFTER)
    .execute();
}

/** One of `moderatorId`'s own runs; another moderator's run reads as absent. */
export async function getOwnRun(db: ScanProbeDb, runId: string, moderatorId: number) {
  return db
    .selectFrom('image_scan_probe_run')
    .select(['id', 'status', 'workflow_id', 'workflow_status'])
    .where('id', '=', runId)
    .where('moderator_id', '=', moderatorId)
    .executeTakeFirst();
}

/** Records the terminal verdict once; a second call for the same run changes nothing. */
export async function recordOutcome(
  db: ScanProbeDb,
  runId: string,
  outcome: { workflowStatus: string; verdict: ScanVerdict | null; tripped: boolean }
): Promise<boolean> {
  const result = await db
    .updateTable('image_scan_probe_run')
    .set({
      workflow_status: outcome.workflowStatus,
      completed_at: sql<Date>`now()`,
      nsfw_level: outcome.verdict?.nsfwLevel ?? null,
      blocked_reason: outcome.verdict?.blockedReason ?? null,
      csam: outcome.verdict?.csam ?? null,
      tripped: outcome.tripped,
    })
    .where('id', '=', runId)
    .where('workflow_status', 'is', null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) === 1;
}

export async function trippedRuns(db: ScanProbeDb) {
  const rows = await db
    .selectFrom('image_scan_probe_run')
    .select(['id', 'image_id'])
    .where('tripped', '=', true)
    .where('breaker_reset_at', 'is', null)
    .orderBy('id')
    .execute();
  return rows.map((r) => ({ id: String(r.id), imageId: r.image_id }));
}

/** Clears the breaker, recording who did. Returns how many tripped rows it reset. */
export async function resetBreaker(db: ScanProbeDb, adminId: number): Promise<number> {
  const result = await db
    .updateTable('image_scan_probe_run')
    .set({ breaker_reset_at: sql<Date>`now()`, breaker_reset_by: adminId })
    .where('tripped', '=', true)
    .where('breaker_reset_at', 'is', null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}

export async function recentOwnRuns(db: ScanProbeDb, moderatorId: number): Promise<ProbeRun[]> {
  const rows = await db
    .selectFrom('image_scan_probe_run')
    .select(['id', 'image_id', 'created_at', 'status'])
    .where('moderator_id', '=', moderatorId)
    .orderBy('id', 'desc')
    .limit(SCAN_PROBE_LIMITS.perRun * 2)
    .execute();
  return rows.map((r) => ({
    id: String(r.id),
    imageId: r.image_id,
    createdAt: new Date(r.created_at as unknown as string | Date).toISOString(),
    status: r.status,
  }));
}
