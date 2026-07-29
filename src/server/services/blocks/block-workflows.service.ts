import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';

/**
 * G6 — persistent block-generation output queue (generic read-model).
 *
 * A block's generation "queue" is otherwise client-side only (the iframe holds
 * workflowIds in memory and polls each), so it is LOST on reload / device
 * switch. `block_workflows` is a durable read-model of a viewer's in-flight +
 * recently-completed generations for one app block, so a block can rebuild its
 * queue on load by asking the host for the viewer's own recent workflows.
 *
 * FULLY GENERIC — there is NO "generator" concept. Every app block that drives
 * budgeted generation writes exactly one row per submit, keyed on the
 * orchestrator workflow id. No generator/content columns live here (content-
 * author / bounty attribution already lives in `block_spend_attribution`, G5).
 *
 * Accessed via raw SQL (no Prisma delegate) so the read-model ships without a
 * Prisma client regen — see the `20260715130000_block_workflows` migration.
 */

// The block-contract workflow statuses — the exact set BlockWorkflowSnapshot
// surfaces to the iframe AND the CHECK constraint on the table allows.
export const BLOCK_WORKFLOW_STATUSES = [
  'pending',
  'processing',
  'succeeded',
  'failed',
  'expired',
  'canceled',
] as const;
export type BlockWorkflowStatus = (typeof BLOCK_WORKFLOW_STATUSES)[number];

export function isBlockWorkflowStatus(v: unknown): v is BlockWorkflowStatus {
  return typeof v === 'string' && (BLOCK_WORKFLOW_STATUSES as readonly string[]).includes(v);
}

// Bound the read: a block rebuilding its queue never needs more than a page of
// recent items, and the endpoint is token-authed + per-viewer so a huge limit
// is pure load with no product value.
export const BLOCK_WORKFLOWS_DEFAULT_LIMIT = 25;
export const BLOCK_WORKFLOWS_MAX_LIMIT = 50;

export type BlockWorkflowQueueItem = {
  workflowId: string;
  status: BlockWorkflowStatus;
  /** ISO-8601 UTC. */
  submittedAt: string;
  /** ISO-8601 UTC. */
  updatedAt: string;
};

/**
 * Fire-and-forget upsert of the queue row at SUBMIT time. Everything is
 * server-derived from the VERIFIED block JWT (appBlockId, blockInstanceId,
 * userId) plus the orchestrator workflow id + the submit-time status.
 *
 * NON-BLOCKING + FAIL-SAFE: wrapped in try/catch and NEVER throws — a failed
 * write must not add latency to, or break, the submit response (the Buzz was
 * already spent and the snapshot is the user-facing source of truth). Mirrors
 * the G5 `recordSpendAttribution` fire-and-forget posture.
 *
 * `ON CONFLICT DO NOTHING`: a workflow id is unique per submit, so a conflict is
 * only a re-entry — first write wins and we never regress a status a later
 * completion callback already advanced. An unknown status is skipped rather than
 * violating the CHECK constraint (defensive; the caller passes a snapshot status
 * that is always in-set).
 *
 * The CALLER excludes dev/live-harness tokens (`claims.dev === true`, synthetic
 * non-FK appBlockId) — this only ever runs for a real deployed app block, so the
 * `app_block_id` FK never sees a synthetic id.
 */
export async function upsertBlockWorkflowOnSubmit(input: {
  workflowId: string;
  appBlockId: string;
  blockInstanceId: string;
  userId: number;
  status: string;
}): Promise<void> {
  const { workflowId, appBlockId, blockInstanceId, userId, status } = input;
  if (!isBlockWorkflowStatus(status)) return; // defensive — never write a bad status
  try {
    await dbWrite.$executeRaw`
      INSERT INTO "block_workflows"
        ("workflow_id", "app_block_id", "block_instance_id", "user_id", "status")
      VALUES (${workflowId}, ${appBlockId}, ${blockInstanceId}, ${userId}, ${status})
      ON CONFLICT ("workflow_id") DO NOTHING
    `;
  } catch {
    /* best-effort: a failed queue write never breaks (or slows) the submit */
  }
}

/**
 * Update the queue row's status + updated_at on the orchestrator completion
 * callback. Best-effort + FAIL-SAFE: wrapped in try/catch and returns the
 * affected-row count (0 when no row exists — e.g. the submit-time write was lost
 * or this is a non-block workflow), NEVER throws. A missed update degrades to a
 * stale status HINT — the block can always poll the orchestrator for the live
 * status — so the callback stays a no-throw 200 path.
 *
 * Idempotent by construction: the UPDATE is a pure set of (status, updated_at)
 * on the primary key, so a retry is harmless; the callback's own 7-day dedup
 * marker additionally short-circuits duplicate deliveries before this runs.
 */
export async function updateBlockWorkflowStatus(input: {
  workflowId: string;
  status: string;
}): Promise<number> {
  const { workflowId, status } = input;
  if (!isBlockWorkflowStatus(status)) return 0;
  try {
    const affected = await dbWrite.$executeRaw`
      UPDATE "block_workflows"
      SET "status" = ${status}, "updated_at" = now()
      WHERE "workflow_id" = ${workflowId}
    `;
    return typeof affected === 'number' ? affected : 0;
  } catch {
    return 0;
  }
}

type RawQueueRow = {
  workflowId: string;
  status: string;
  // Full-precision (microsecond) ISO strings, formatted by Postgres `to_char`
  // (NOT a JS Date — a Date truncates the TIMESTAMPTZ(6) column to milliseconds,
  // which would break the keyset cursor; see decodeCursor / the query below).
  submittedAt: string;
  updatedAt: string;
};

// Opaque keyset cursor: `${submittedAt microsecond-ISO}|${workflowId}`. The ISO
// timestamp contains no '|', and orchestrator workflow ids contain no '|', so a
// split on the FIRST '|' round-trips exactly.
//
// PRECISION (correctness): the timestamp is carried as the FULL-precision
// microsecond ISO string straight from Postgres and is NEVER round-tripped
// through a JS `Date` (which is millisecond-only). If the cursor were truncated
// to milliseconds, a row whose `submitted_at` shares a millisecond with the
// cursor row but has DIFFERENT microseconds could be skipped across a page
// boundary (its true micro-value would sort as NOT strictly-less-than the
// truncated cursor). Keeping microseconds + the (submitted_at, workflow_id)
// compound tiebreak makes the keyset lossless regardless of sub-ms precision.
function encodeCursor(item: BlockWorkflowQueueItem): string {
  return `${item.submittedAt}|${item.workflowId}`;
}
function decodeCursor(cursor: string): { submittedAt: string; workflowId: string } | null {
  const idx = cursor.indexOf('|');
  if (idx <= 0) return null;
  const submittedAt = cursor.slice(0, idx);
  const workflowId = cursor.slice(idx + 1);
  // Validate the timestamp parses (defensive against a malformed/forged cursor)
  // WITHOUT lowering its precision — we pass the ORIGINAL micro-ISO string to the
  // query, letting Postgres cast it to timestamptz at full precision.
  if (workflowId.length === 0 || Number.isNaN(Date.parse(submittedAt))) return null;
  return { submittedAt, workflowId };
}

/**
 * SECURITY GATE for `blocks.cancelAppWorkflow`. Returns true iff a queue row
 * exists for the exact (userId, appBlockId, workflowId) tuple — i.e. THIS viewer
 * submitted THIS workflow through THIS app block. Both `userId` and `appBlockId`
 * are bound SERVER-SIDE from the verified block token; `workflowId` is the
 * (untrusted) client input being authorized.
 *
 * WHY this is the ownership proof (not the orchestrator by-id read): the
 * orchestrator's GET/PATCH/DELETE `/{workflowId}` endpoints do NOT verify
 * caller-vs-workflow ownership, so fetching/canceling a workflow with the
 * viewer's orchestrator token is NOT by itself an ownership gate — a guessed id
 * belonging to another user could be actioned. `block_workflows` is the ONLY
 * durable USER-bound record of a block generation, so a matching row is the
 * authoritative "this user owns this workflow, via this app" assertion. The
 * caller ADDITIONALLY re-reads the workflow and asserts its `app-block:<appId>`
 * tag as defense-in-depth (the orchestrator's own record must agree it's this
 * app's), but THIS check is the load-bearing user binding.
 *
 * FAIL-CLOSED: the submit-time upsert is best-effort (fire-and-forget), so a lost
 * write means a legitimate cancel is rejected rather than an illegitimate one
 * allowed — the correct trade-off for a security guard. Any DB error → false
 * (reject), never a throw that could be mistaken for "allowed".
 */
export async function blockWorkflowOwnedByAppUser(input: {
  userId: number;
  appBlockId: string;
  workflowId: string;
}): Promise<boolean> {
  const { userId, appBlockId, workflowId } = input;
  try {
    const rows = await dbRead.$queryRaw<Array<{ one: number }>>`
      SELECT 1 AS "one"
      FROM "block_workflows"
      WHERE "workflow_id" = ${workflowId}
        AND "user_id" = ${userId}
        AND "app_block_id" = ${appBlockId}
      LIMIT 1
    `;
    return rows.length > 0;
  } catch {
    return false; // fail-closed
  }
}

/**
 * Read the CALLER's OWN recent workflows for ONE app block, newest first,
 * keyset-paginated. Both `userId` and `appBlockId` are bound SERVER-SIDE from
 * the verified block token, so a block can only ever read the queue of the exact
 * viewer whose session minted the token, scoped to the calling app block — never
 * another user's or another app's rows.
 *
 * Keyset on `(submitted_at DESC, workflow_id DESC)` — served directly by
 * `block_workflows_user_app_idx`. Returns the persisted status per item (the
 * block polls the orchestrator for live details/images via `pollWorkflow`),
 * plus an opaque `nextCursor` (null when the page is the last one).
 */
export async function listMyBlockWorkflows(input: {
  userId: number;
  appBlockId: string;
  limit?: number;
  cursor?: string | null;
}): Promise<{ items: BlockWorkflowQueueItem[]; nextCursor: string | null }> {
  const { userId, appBlockId } = input;
  const limit = Math.min(
    BLOCK_WORKFLOWS_MAX_LIMIT,
    Math.max(1, Math.floor(input.limit ?? BLOCK_WORKFLOWS_DEFAULT_LIMIT))
  );
  const decoded = input.cursor ? decodeCursor(input.cursor) : null;
  // Compound (submitted_at, workflow_id) keyset for the DESC ordering. The cursor
  // timestamp is cast to timestamptz at FULL microsecond precision (the string is
  // never truncated through a JS Date), so no same-millisecond row is skipped.
  const keyset = decoded
    ? Prisma.sql`AND ("submitted_at", "workflow_id") < (${decoded.submittedAt}::timestamptz, ${decoded.workflowId})`
    : Prisma.empty;

  const rows = await dbRead.$queryRaw<RawQueueRow[]>`
    SELECT
      "workflow_id" AS "workflowId",
      "status",
      -- Microsecond-precision ISO (matching TIMESTAMPTZ(6)); NOT a JS Date, whose
      -- millisecond truncation would break the keyset cursor above.
      to_char("submitted_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "submittedAt",
      to_char("updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt"
    FROM "block_workflows"
    WHERE "user_id" = ${userId} AND "app_block_id" = ${appBlockId}
    ${keyset}
    ORDER BY "submitted_at" DESC, "workflow_id" DESC
    LIMIT ${limit + 1}
  `;

  const page = rows.slice(0, limit).map(
    (r): BlockWorkflowQueueItem => ({
      workflowId: r.workflowId,
      // The CHECK constraint guarantees an in-set status; narrow defensively.
      status: isBlockWorkflowStatus(r.status) ? r.status : 'pending',
      // Already full-precision ISO strings from the query (see RawQueueRow).
      submittedAt: r.submittedAt,
      updatedAt: r.updatedAt,
    })
  );
  const nextCursor = rows.length > limit && page.length > 0 ? encodeCursor(page[page.length - 1]) : null;
  return { items: page, nextCursor };
}
