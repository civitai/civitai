import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { runnerMintReads } from '@civitai/db-queries/recipe-runner';
import {
  decideRunnerMint,
  RUNNER_TOKEN_SCOPE,
  type RunnerMintRefusal,
} from '~/server/services/blocks/runner-mint.service';

// The recipe runner's attempt ledger (`runner_run_attempts`): Postgres is the authority on what a
// runner may spend. One row per submit attempt of a run; a partial unique index allows one live
// attempt per run.

export type RunnerAttemptState =
  | 'reserved'
  | 'submitting'
  | 'unknown'
  | 'submitted'
  | 'settled'
  | 'refunded'
  | 'failed';

/** `transitionRunnerAttempt` throws on any other pair. */
const TRANSITIONS: Readonly<Record<string, readonly RunnerAttemptState[]>> = {
  reserved: ['submitting', 'refunded'],
  submitting: ['submitted', 'refunded', 'unknown'],
  // Adopted: the sweeper moved a sent attempt to `unknown` before its submit returned a workflow.
  unknown: ['submitted'],
  // The reconciler, on a terminal workflow.
  submitted: ['settled', 'failed', 'refunded'],
};

/**
 * The Redis legs an attempt holds, each reserved for `amount`: key names and amounts only. Written
 * by the `reserved -> submitting` move, so a `reserved` attempt has none.
 */
export interface RunnerReservation {
  buzzCapKey: string;
  consentBudgetKey: string | null;
  appSpendKey: string | null;
  amount: number;
}

export type RunnerReserveRefusal = RunnerMintRefusal | 'run_mismatch';

export type RunnerReserveResult =
  | { ok: true; attemptId: string; attemptNo: number }
  | { ok: false; refusal: RunnerReserveRefusal };

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === '23505';
}

/**
 * Reserve one attempt of a run, or refuse. Under a row lock on the user's consent for the runner
 * client, so the cap and runs-per-period counts cannot race another reserve for the same pair:
 * every mint check runs again against what is committed now, then the attempt is inserted in
 * `reserved`. A second live attempt for the run, however it raced, refuses as `run_live`.
 * A database error throws: the caller refuses the submit.
 */
export async function reserveRunnerAttempt(
  db: Kysely<DB>,
  input: {
    userId: number;
    clientId: string;
    authorizationId: string;
    runKey: string;
    runId: string;
    appBlockId: string;
    amount: number;
    externalId: string;
    now: Date;
  }
): Promise<RunnerReserveResult> {
  const refuse = (refusal: RunnerReserveRefusal): RunnerReserveResult => ({ ok: false, refusal });
  try {
    return await db.transaction().execute(async (trx) => {
      const locked = await sql`
        SELECT 1 FROM "OauthConsent"
        WHERE "userId" = ${input.userId} AND "clientId" = ${input.clientId}
        FOR UPDATE`.execute(trx);
      if (locked.rows.length === 0) return refuse('consent');

      const decision = await decideRunnerMint(
        {
          userId: input.userId,
          clientId: input.clientId,
          // The block token was minted for a runner-scoped credential; that is what it re-checks.
          tokenScope: RUNNER_TOKEN_SCOPE,
          request: {
            authorizationId: input.authorizationId,
            runKey: input.runKey,
            amount: input.amount,
          },
          now: input.now,
        },
        runnerMintReads(trx)
      );
      if (!decision.ok) return decision;
      if (decision.grant.runId !== input.runId || decision.grant.appBlock.id !== input.appBlockId) {
        return refuse('run_mismatch');
      }

      const attemptId = `rat_${randomUUID()}`;
      const { rows } = await sql<{ attemptNo: number }>`
        INSERT INTO runner_run_attempts (
          attempt_id, run_id, attempt_no, user_id, runner_client_id, app_block_id,
          authorization_id, state, reserved_amount, external_id
        )
        SELECT ${attemptId}, ${input.runId}, COALESCE(MAX(attempt_no), 0) + 1, ${input.userId},
               ${input.clientId}, ${input.appBlockId}, ${input.authorizationId}, 'reserved',
               ${input.amount}, ${input.externalId}
        FROM runner_run_attempts WHERE run_id = ${input.runId}
        RETURNING attempt_no AS "attemptNo"`.execute(trx);
      return { ok: true, attemptId, attemptNo: Number(rows[0].attemptNo) };
    });
  } catch (e) {
    if (isUniqueViolation(e)) return refuse('run_live');
    throw e;
  }
}

/**
 * Move an attempt from `from` to `to`, only if it is still in `from`. False: another writer moved
 * it first, and the caller must not act as if it had. Leaving `submitted` stamps `settled_at`.
 */
export async function transitionRunnerAttempt(
  db: Kysely<DB>,
  attemptId: string,
  from: RunnerAttemptState,
  to: RunnerAttemptState,
  patch: { workflowId?: string; reservation?: RunnerReservation; chargedAmount?: number } = {}
): Promise<boolean> {
  if (!TRANSITIONS[from]?.includes(to)) {
    throw new Error(`runner attempt: no transition ${from} -> ${to}`);
  }
  const reservation = patch.reservation ? JSON.stringify(patch.reservation) : null;
  const result = await sql`
    UPDATE runner_run_attempts
    SET state = ${to}, updated_at = now(),
        workflow_id = COALESCE(${patch.workflowId ?? null}::text, workflow_id),
        reservation = COALESCE(${reservation}::jsonb, reservation),
        charged_amount = COALESCE(${patch.chargedAmount ?? null}::int, charged_amount),
        settled_at = CASE WHEN ${from} = 'submitted' THEN now() ELSE settled_at END
    WHERE attempt_id = ${attemptId} AND state = ${from}`.execute(db);
  return Number(result.numAffectedRows ?? 0) > 0;
}

/** Bump `updated_at` of an attempt still in `state`, moving it to the back of `listRunnerAttempts`. */
export async function touchRunnerAttempt(
  db: Kysely<DB>,
  attemptId: string,
  state: RunnerAttemptState
): Promise<void> {
  await sql`
    UPDATE runner_run_attempts SET updated_at = now()
    WHERE attempt_id = ${attemptId} AND state = ${state}`.execute(db);
}

/** An attempt's state, or null when there is no such attempt. */
export async function readRunnerAttemptState(
  db: Kysely<DB>,
  attemptId: string
): Promise<RunnerAttemptState | null> {
  const { rows } = await sql<{ state: RunnerAttemptState }>`
    SELECT state FROM runner_run_attempts WHERE attempt_id = ${attemptId}`.execute(db);
  return rows[0]?.state ?? null;
}

export interface RunnerAttemptRow {
  attemptId: string;
  runId: string;
  userId: number;
  appBlockId: string;
  /** The app the block belongs to, for the workflow's app tag; null if the block is gone. */
  appId: string | null;
  state: RunnerAttemptState;
  reservedAmount: number;
  workflowId: string | null;
  reservation: RunnerReservation | null;
  updatedAt: Date;
}

/** Attempts in `state` last moved before `updatedBefore`, oldest first. */
export async function listRunnerAttempts(
  db: Kysely<DB>,
  input: { state: RunnerAttemptState; updatedBefore: Date; limit: number }
): Promise<RunnerAttemptRow[]> {
  const { rows } = await sql<RunnerAttemptRow>`
    SELECT a.attempt_id AS "attemptId", a.run_id AS "runId", a.user_id AS "userId",
           a.app_block_id AS "appBlockId", b.app_id AS "appId", a.state,
           a.reserved_amount AS "reservedAmount", a.workflow_id AS "workflowId",
           a.reservation, a.updated_at AS "updatedAt"
    FROM runner_run_attempts a
    LEFT JOIN app_blocks b ON b.id = a.app_block_id
    WHERE a.state = ${input.state} AND a.updated_at < ${input.updatedBefore}
    ORDER BY a.updated_at
    LIMIT ${input.limit}`.execute(db);
  return rows;
}
