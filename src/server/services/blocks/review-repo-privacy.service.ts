import { logToAxiom } from '~/server/logging/client';

/**
 * ONE-OFF BACKFILL — flip every EXISTING in-review snapshot repo to private.
 *
 * `ensureReviewRepo` now creates snapshots with `private: true`, but that only
 * fixes repos created from this change forward. The create call is idempotent
 * on an already-existing repo (Forgejo answers 409/422 and changes nothing), so
 * a re-submit of an old app does NOT retroactively flip its snapshot. Every
 * snapshot created before this change therefore stays readable until something
 * walks the org and patches it — which is what this does.
 *
 * 🔴 The privacy fix is INCOMPLETE until a human runs this once. Until then the
 * already-created snapshots keep whatever visibility they were created with.
 *
 * Properties (it is expected to be re-run, possibly repeatedly):
 *  - IDEMPOTENT: setting `private: true` on an already-private repo is a no-op,
 *    and we skip those without even issuing the PATCH.
 *  - TOLERANT: a repo that vanished between the LIST and the PATCH is counted
 *    `missing`, not failed.
 *  - LOG-AND-CONTINUE: a per-repo failure is recorded in `failed[]` and the
 *    walk continues, so one bad repo cannot strand the rest.
 *  - OBSERVABLE: one structured log line per repo acted on, plus a summary.
 */

export type BackfillReviewRepoPrivacyParams = {
  /** Cap the number of repos processed this run. Omit = all. */
  limit?: number;
  /** Preview only: enumerate + classify, but issue no PATCH. */
  dryRun?: boolean;
};

export type BackfillReviewRepoPrivacyResult = {
  /** Repos enumerated from the in-review org (after `limit`). */
  scanned: number;
  /** Repos that were public and are now private (0 when `dryRun`). */
  updated: number;
  /** Repos already private — the steady state on a re-run. */
  alreadyPrivate: number;
  /** Repos that disappeared between the LIST and the PATCH. */
  missing: number;
  dryRun: boolean;
  /** Slugs that were (or, under `dryRun`, would be) flipped. */
  updatedSlugs: string[];
  /** Per-repo failures — the walk continued past each of these. */
  failed: { slug: string; error: string }[];
};

const logBackfill = (data: Record<string, unknown>) =>
  logToAxiom({ name: 'backfill-review-repo-privacy', ...data }, 'webhooks').catch(() => undefined);

export async function backfillReviewRepoPrivacy(
  params: BackfillReviewRepoPrivacyParams = {}
): Promise<BackfillReviewRepoPrivacyResult> {
  const { limit, dryRun = false } = params;
  const { listReviewRepos, setReviewRepoPrivate } = await import('./forgejo.service');

  const all = await listReviewRepos();
  const repos = typeof limit === 'number' ? all.slice(0, limit) : all;

  const result: BackfillReviewRepoPrivacyResult = {
    scanned: repos.length,
    updated: 0,
    alreadyPrivate: 0,
    missing: 0,
    dryRun,
    updatedSlugs: [],
    failed: [],
  };

  for (const repo of repos) {
    if (repo.private) {
      result.alreadyPrivate += 1;
      continue;
    }
    // Record the intent BEFORE the dryRun short-circuit so a preview run tells
    // the operator exactly which slugs a real run would touch.
    result.updatedSlugs.push(repo.name);
    if (dryRun) {
      logBackfill({ type: 'info', slug: repo.name, outcome: 'would-update' });
      continue;
    }
    try {
      const outcome = await setReviewRepoPrivate(repo.name);
      if (outcome === 'missing') result.missing += 1;
      else result.updated += 1;
      logBackfill({ type: 'info', slug: repo.name, outcome });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      result.failed.push({ slug: repo.name, error });
      logBackfill({ type: 'error', level: 'error', slug: repo.name, outcome: 'failed', error });
    }
  }

  logBackfill({
    type: 'info',
    outcome: 'summary',
    scanned: result.scanned,
    updated: result.updated,
    alreadyPrivate: result.alreadyPrivate,
    missing: result.missing,
    failed: result.failed.length,
    dryRun,
  });

  return result;
}
