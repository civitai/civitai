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
export type BuildAttemptStatus = 'triggered' | 'succeeded' | 'failed';

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
    await dbWrite.appBlockBuildAttempt.createMany({
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
        },
      ],
      skipDuplicates: true,
    });
    return true;
  } catch (err) {
    warn(`attempt write (mode=${row.mode}, status=${row.status}, slug=${row.slug})`, err);
    return false;
  }
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
 * The failed step and failure class of each request's LATEST callback attempt in `mode`
 * (trigger rows are not callbacks and are skipped). A request with no attempt is absent
 * from the map; the whole map is empty when the table is missing.
 *
 * Structured values only — never log text — so moderator surfaces may read this too.
 */
export async function latestBuildAttemptSignals(
  publishRequestIds: string[],
  mode: BuildAttemptMode = 'build'
): Promise<Map<string, BuildAttemptSignals>> {
  const out = new Map<string, BuildAttemptSignals>();
  if (publishRequestIds.length === 0) return out;
  try {
    const { dbRead } = await import('~/server/db/client');
    const rows = await dbRead.appBlockBuildAttempt.findMany({
      where: {
        publishRequestId: { in: publishRequestIds },
        mode,
        status: { not: 'triggered' },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      distinct: ['publishRequestId'],
      select: { publishRequestId: true, failedStep: true, failureClass: true },
    });
    for (const r of rows) {
      if (r.publishRequestId && !out.has(r.publishRequestId)) {
        out.set(r.publishRequestId, { failedStep: r.failedStep, failureClass: r.failureClass });
      }
    }
  } catch (err) {
    warn('latest attempt read', err);
    out.clear();
  }
  return out;
}
