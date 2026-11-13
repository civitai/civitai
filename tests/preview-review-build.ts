/**
 * How the App Blocks preview e2e reads the automatic REVIEW build of its own submission
 * (`preview-apps-publish.spec.ts`). Pure (no Playwright import) so a unit test can pin it:
 * `src/server/services/blocks/__tests__/preview-review-build.verdict.test.ts`.
 *
 * The observable is the publish request's review-preview state, as `blocks.getReviewStatus`
 * reports it. The build pipeline checks the manifest before it builds anything, and the platform
 * moves the request to `preview-deploying` only when the whole build succeeded, so
 * `preview-deploying` or `preview-live` proves the manifest check passed. `preview-failed` carries
 * the failed step in its error ("review build failed at manifest check (...)").
 */

/** The fields of `blocks.getReviewStatus` this reads. */
export type ReviewStatusLike = {
  state: string | null;
  detail?: { error?: string } | null;
};

/** `blocks.getMyAutoReviewBuildBudget`. */
export type AutoBuildBudgetLike =
  | { available: true; scope: string; limit: number; remaining: number }
  | { available: false; scope: string };

export type ReviewBuildVerdict = { done: false } | { done: true; pass: boolean; message: string };

/** States that prove the build (and so its manifest check) succeeded. */
const BUILD_PASSED_STATES = ['preview-deploying', 'preview-live'];

/**
 * Whether the automatic build can start at all, read BEFORE submitting. `null` when it can;
 * otherwise the failure message. A spent or unreadable budget means the submission's preview
 * waits for a moderator and no build runs, so the test must fail saying so rather than time out.
 */
export function budgetBlocksReviewBuild(budget: AutoBuildBudgetLike, slug: string): string | null {
  if (!budget.available) {
    return (
      `The automatic review-build budget for ${slug} could not be read (scope ${budget.scope}), ` +
      'so the platform would not start the review build; the manifest check was not exercised.'
    );
  }
  if (budget.remaining <= 0) {
    return (
      `The automatic review-build budget for ${slug} is spent for today ` +
      `(scope ${budget.scope}, limit ${budget.limit}/day): the submission's review build ` +
      'would not start, so the manifest check was not exercised.'
    );
  }
  return null;
}

/** One poll's verdict. `done: false` keeps polling (no preview yet, queued or building). */
export function reviewBuildVerdict(status: ReviewStatusLike): ReviewBuildVerdict {
  const state = status.state;
  if (state && BUILD_PASSED_STATES.includes(state)) {
    return {
      done: true,
      pass: true,
      message: `review build passed (state ${state})`,
    };
  }
  if (state === 'preview-failed') {
    const error = status.detail?.error ?? '(no error recorded)';
    const atManifest = error.includes('manifest check');
    return {
      done: true,
      pass: false,
      message: atManifest
        ? `The review build REJECTED the manifest: ${error}`
        : `The review build failed (not at the manifest check): ${error}`,
    };
  }
  if (state === 'preview-expired') {
    return { done: true, pass: false, message: 'The review preview expired before it built.' };
  }
  return { done: false };
}

/** The failure message when no verdict arrived in time. */
export function reviewBuildTimeoutMessage(args: {
  slug: string;
  timeoutMs: number;
  lastState: string | null;
  budgetAfter: AutoBuildBudgetLike | null;
}): string {
  const head = `No review-build verdict for ${args.slug} within ${Math.round(
    args.timeoutMs / 1000
  )}s (last state: ${args.lastState ?? 'none'}).`;
  if (args.lastState != null) {
    return `${head} The build is still queued or running: the build slots may be busy.`;
  }
  // No preview at all. A budget that reads spent NOW is the likeliest reason: another run on
  // the same budget spent the last build between the pre-submit read and this submission.
  const spent = args.budgetAfter ? budgetBlocksReviewBuild(args.budgetAfter, args.slug) : null;
  if (spent) return `${head} ${spent}`;
  return (
    `${head} The build never started: automatic review previews may be switched off, ` +
    'or the build trigger failed.'
  );
}
