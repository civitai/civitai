import { parseRunId } from '~/server/services/blocks/build-signals';
import type {
  BuildAttemptSignals,
  BuildFailedStep,
  BuildFailureClassSignal,
} from '~/shared/constants/app-block-build.constants';

/**
 * Reads and writes of `app_block_build_attempts`, the per-run build history.
 *
 * 🔴 EVERY FUNCTION HERE IS BEST-EFFORT AND NEVER THROWS. The table's migration is applied
 * by hand, per environment, so code that uses it ships before the table exists. Each
 * function catches its own failure (a missing table included), logs it, and returns the
 * answer that leaves the caller doing exactly what it did before this table existed:
 * - a write reports `false`;
 * - the stale-run check reports "not stale";
 * - the signals read returns no signals.
 *
 * The DB client is imported lazily, the same way `publish-request.service` does it, so
 * that module can lazy-import this one without pulling Prisma into its static graph.
 */

export type BuildAttemptMode = 'build' | 'review';
/**
 * `superseded` = a failure callback the stale-run guard ignored: kept as history, never
 * read back as a version's latest outcome.
 */
export type BuildAttemptStatus = 'triggered' | 'succeeded' | 'failed' | 'superseded';

export type BuildAttemptRow = {
  mode: BuildAttemptMode;
  status: BuildAttemptStatus;
  slug: string;
  sha: string;
  /**
   * The publish request the run belongs to. When omitted on a `build`-mode row, it is
   * resolved from the APPROVED request for `(slug, sha)`, the same key
   * `markRequestDeployState` writes through; `null` if none matches.
   */
  publishRequestId?: string | null;
  runId?: string | null;
  failedStep?: BuildFailedStep | null;
  failedReason?: string | null;
  failureClass?: BuildFailureClassSignal | null;
  pipelineStatus?: string | null;
};

function warn(what: string, err: unknown): void {
  // eslint-disable-next-line no-console
  console.warn(
    `[build-attempts] ${what} skipped: ${err instanceof Error ? err.message : String(err)}`
  );
}

/**
 * Append one attempt row. Returns whether the write went through.
 *
 * Duplicate deliveries are absorbed by the table's partial unique index on
 * `(mode, run_id, status)`: `skipDuplicates` turns the insert into `ON CONFLICT DO
 * NOTHING`, so a repeated callback for the same run and outcome adds no row.
 *
 * 🔴 BUT A REPEAT OUTCOME ROW IS RE-STAMPED. A re-delivered failure rewrites
 * `deploy_updated_at` before reaching here; left at its first-delivery time, the existing
 * row would then look older than the transition it describes and the freshness rule in
 * {@link latestBuildAttemptSignals} would hide it. So for an outcome row whose insert was
 * absorbed, `created_at` moves to now: on an outcome row it means "last reported".
 */
export async function recordBuildAttempt(row: BuildAttemptRow): Promise<boolean> {
  try {
    const { dbWrite } = await import('~/server/db/client');
    let publishRequestId = row.publishRequestId ?? null;
    if (row.publishRequestId === undefined && row.mode === 'build') {
      const request = await dbWrite.appBlockPublishRequest.findFirst({
        where: { slug: row.slug, forgejoCommitSha: row.sha, status: 'approved' },
        select: { id: true },
      });
      publishRequestId = request?.id ?? null;
    }
    // Outcome rows are stamped by the app, on the SAME clock as the `deploy_updated_at`
    // the caller wrote just before (the freshness rule compares the two). Trigger rows
    // keep the column default: they are only ordered against each other.
    const stampedAt = row.status === 'triggered' ? undefined : new Date();
    const { count } = await dbWrite.appBlockBuildAttempt.createMany({
      data: [
        {
          publishRequestId,
          slug: row.slug,
          sha: row.sha,
          runId: row.runId ?? null,
          mode: row.mode,
          status: row.status,
          failedStep: row.failedStep ?? null,
          failedReason: row.failedReason ?? null,
          failureClass: row.failureClass ?? null,
          pipelineStatus: row.pipelineStatus ?? null,
          ...(stampedAt ? { createdAt: stampedAt } : {}),
        },
      ],
      skipDuplicates: true,
    });
    if (count === 0 && stampedAt && row.runId) {
      await dbWrite.appBlockBuildAttempt.updateMany({
        where: { mode: row.mode, runId: row.runId, status: row.status },
        data: { createdAt: stampedAt },
      });
    }
    return true;
  } catch (err) {
    warn(`attempt write (mode=${row.mode}, status=${row.status}, slug=${row.slug})`, err);
    return false;
  }
}

/**
 * Record that civitai just started run `runName` for a version, so a later callback from
 * an OLDER run can be recognised as stale (see {@link isSupersededRun}).
 *
 * `runName` is the build service's reply to the trigger. A value that is not a valid run
 * id (an empty name from an older build service, say) is not recorded: the guard then
 * stays inactive for this run rather than keying on garbage.
 */
export async function recordBuildTriggered(args: {
  mode: BuildAttemptMode;
  publishRequestId: string;
  slug: string;
  sha: string;
  runName: string | null | undefined;
}): Promise<boolean> {
  const runId = parseRunId(args.runName);
  if (!runId) return false;
  return recordBuildAttempt({
    mode: args.mode,
    status: 'triggered',
    publishRequestId: args.publishRequestId,
    slug: args.slug,
    sha: args.sha,
    runId,
  });
}

/**
 * Has a NEWER run been started for this version since the run that sent this callback?
 *
 * The stale-run guard: build-failure callbacks are retried and can land minutes late, and
 * by then a moderator may have re-triggered the build. Without this, the old run's failure
 * overwrites the new run's `building`.
 *
 * 🔴 TRUE ONLY ON POSITIVE EVIDENCE: this callback's own run has a `triggered` row AND a
 * later `triggered` row names a different run. Every other case answers `false`, which is
 * the behaviour before this guard existed:
 * - no `runId` on the callback;
 * - the table is missing or the query fails;
 * - no trigger was recorded for this run. Its trigger-time write may have failed, and
 *   calling an unrecorded run stale would drop a CURRENT run's callback.
 */
export async function isSupersededRun(args: {
  mode: BuildAttemptMode;
  slug: string;
  sha: string;
  runId: string | undefined;
}): Promise<boolean> {
  if (!args.runId) return false;
  try {
    const { dbWrite } = await import('~/server/db/client');
    const where = {
      mode: args.mode,
      slug: args.slug,
      sha: args.sha,
      status: 'triggered' as const,
    };
    const latest = await dbWrite.appBlockBuildAttempt.findFirst({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { runId: true },
    });
    if (!latest?.runId || latest.runId === args.runId) return false;
    const own = await dbWrite.appBlockBuildAttempt.findFirst({
      where: { ...where, runId: args.runId },
      select: { id: true },
    });
    return own !== null;
  } catch (err) {
    warn(`stale-run check (mode=${args.mode}, slug=${args.slug})`, err);
    return false;
  }
}

/**
 * The failed step and failure class of each request's latest build outcome in `mode`, for
 * the requests whose current `deploy_state` that outcome still describes. A request with
 * no such attempt is absent from the map; the map is empty when the table is missing.
 *
 * Two rules keep an older run's report off a newer failure:
 * - Only `succeeded` / `failed` rows count. Trigger rows are not outcomes, and a
 *   `superseded` row is an old run's late callback the guard already ignored.
 * - The row must be at least as new as the request's `deployUpdatedAt`. A callback
 *   writes `deploy_state` first and its attempt row second, so the row for the failure
 *   on screen is never older than it. Any later transition (a failed deploy of the built
 *   image, a re-trigger that could not start, a new run) is newer than the row, and the
 *   row then describes something else. Both timestamps come from the app's clock; rows
 *   written by different pods can disagree by their clock skew.
 *
 * Structured values only, never log text, so moderator surfaces may read this too.
 */
export async function latestBuildAttemptSignals(
  requests: Array<{ id: string; deployUpdatedAt: Date | null }>,
  mode: BuildAttemptMode = 'build'
): Promise<Map<string, BuildAttemptSignals>> {
  const out = new Map<string, BuildAttemptSignals>();
  if (requests.length === 0) return out;
  const updatedAt = new Map(requests.map((r) => [r.id, r.deployUpdatedAt]));
  try {
    const { dbRead } = await import('~/server/db/client');
    const rows = await dbRead.appBlockBuildAttempt.findMany({
      where: {
        publishRequestId: { in: requests.map((r) => r.id) },
        mode,
        status: { in: ['succeeded', 'failed'] },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      distinct: ['publishRequestId'],
      select: { publishRequestId: true, failedStep: true, failureClass: true, createdAt: true },
    });
    for (const r of rows) {
      if (!r.publishRequestId || out.has(r.publishRequestId)) continue;
      const since = updatedAt.get(r.publishRequestId);
      if (since && r.createdAt.getTime() < since.getTime()) continue;
      out.set(r.publishRequestId, { failedStep: r.failedStep, failureClass: r.failureClass });
    }
  } catch (err) {
    warn('latest attempt read', err);
    out.clear();
  }
  return out;
}
