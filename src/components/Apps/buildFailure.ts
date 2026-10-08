import {
  DEPLOY_FAILURE_DETAIL,
  RETRIGGER_FAILED_AUTHOR_DETAIL,
} from '~/shared/constants/app-block-deploy.constants';

/**
 * Turn a failed version's stored `deploy_detail` into what its author is told.
 *
 * 🔴 THIS IS A HEURISTIC, AND IT IS THE ONLY ONE. The cause is inferred from the TEXT of
 * the stored detail, because that is all the build callback sends today. The planned
 * replacement is a structured failed-step / failure-class field on the callback; when it
 * lands, this function's body is what changes and no caller does. Keep every
 * text-sniffing rule in here rather than letting a component grow its own.
 *
 * WHAT THE STORED DETAIL CAN BE, enumerated from its writers:
 *   - `Build <status>` + optional blank line + sanitized log excerpt —
 *     `buildFailureDeployDetail` in `~/server/services/blocks/build-failure-reason`.
 *     🔴 `<status>` is the status of the run's final publish step, so a failure before it
 *     arrives as `Build None`. It says nothing about the cause, so it is never rendered.
 *   - one of {@link DEPLOY_FAILURE_DETAIL} — the image built, the deploy didn't.
 *   - {@link RETRIGGER_FAILED_AUTHOR_DETAIL} — a moderator re-trigger never reached the
 *     build service.
 *
 * 🔴 THE FALLBACK IS `unknown`, AND IT NEVER BLAMES THE AUTHOR. A build step can fail for
 * reasons that have nothing to do with the app (a registry outage, a platform image
 * problem), and telling an author "fix your code" for those sends them chasing a bug they
 * don't have. Only a positive signal makes a failure the author's: the platform's build
 * pre-checks print their author-facing messages as lines starting `ERROR:`.
 */

export type BuildFailureClass = 'author' | 'security-scan' | 'platform' | 'unknown';

export type BuildFailureDescription = {
  failureClass: BuildFailureClass;
  /** A few words for the status chip. */
  badge: string;
  headline: string;
  /** What to do next. Only `author` ever says to submit a new version. */
  guidance: string;
  /** The sanitized build-log excerpt, or `null` when there is none to show. */
  excerpt: string | null;
};

/** The neutral fallback, worded as agreed for every failure we cannot attribute. */
export const UNKNOWN_FAILURE_GUIDANCE =
  "We couldn't determine the cause — retry, or contact us if it repeats.";

/** For failures that are ours: the app is fine, so a new version would not help. */
export const PLATFORM_FAILURE_GUIDANCE =
  "This is a problem on our side, not with your app, so you don't need to submit a new version. Contact us and we'll re-run the build.";

export const AUTHOR_FAILURE_GUIDANCE = 'Fix the error below, then submit a new version.';

export const SECURITY_SCAN_GUIDANCE =
  "The security scan of the finished app found a high-severity vulnerability, so this version wasn't published. " +
  "These are often in a component Civitai provides rather than in your app. If the package below isn't one your app installs, contact us and we'll handle it.";

/** The build-callback prefix — `Build ` followed by the push step's status. */
const BUILD_STATUS_PREFIX = 'Build ';

/** The scan step's own marker line for a blocking finding. */
const SCAN_BLOCKED_LINE = /^SCAN-BLOCKED\b/m;

/** The build pre-checks' author-facing message shape. */
const AUTHOR_ERROR_LINE = /^ERROR:/;

const DEPLOY_HEADLINES: Record<string, string> = {
  [DEPLOY_FAILURE_DETAIL.failed]: 'Your app built, but the deploy failed',
  [DEPLOY_FAILURE_DETAIL.timedOut]: 'Your app built, but the deploy timed out',
  [DEPLOY_FAILURE_DETAIL.couldNotStart]: 'Your app built, but the deploy could not start',
};

function unknown(excerpt: string | null): BuildFailureDescription {
  return {
    failureClass: 'unknown',
    badge: 'failed',
    headline: "This version didn't go live",
    guidance: UNKNOWN_FAILURE_GUIDANCE,
    excerpt,
  };
}

export function describeBuildFailure(
  deployDetail: string | null | undefined
): BuildFailureDescription {
  const detail = (deployDetail ?? '').trim();
  if (detail.length === 0) return unknown(null);

  if (detail === RETRIGGER_FAILED_AUTHOR_DETAIL) {
    return {
      failureClass: 'platform',
      badge: 'rebuild failed',
      headline: "The rebuild couldn't be started",
      guidance: PLATFORM_FAILURE_GUIDANCE,
      excerpt: null,
    };
  }

  const deployHeadline = DEPLOY_HEADLINES[detail];
  if (deployHeadline) {
    return {
      failureClass: 'platform',
      badge: 'deploy failed',
      headline: deployHeadline,
      guidance: PLATFORM_FAILURE_GUIDANCE,
      excerpt: null,
    };
  }

  const separator = detail.indexOf('\n\n');
  const head = separator === -1 ? detail : detail.slice(0, separator);
  const tail = separator === -1 ? '' : detail.slice(separator + 2);
  const rest = tail.trim().length > 0 ? tail : null;

  // Not a shape any writer produces today. Show it as the excerpt rather than hide it,
  // but claim nothing about the cause.
  if (!head.startsWith(BUILD_STATUS_PREFIX)) return unknown(detail);

  // From here on `head` is `Build <status>` and is dropped: it carries no cause.
  if (!rest) return unknown(null);

  if (SCAN_BLOCKED_LINE.test(rest)) {
    return {
      failureClass: 'security-scan',
      badge: 'blocked by security scan',
      headline: 'Blocked by the security scan',
      guidance: SECURITY_SCAN_GUIDANCE,
      excerpt: rest,
    };
  }

  const firstLine = rest.split('\n', 1)[0];
  if (AUTHOR_ERROR_LINE.test(firstLine)) {
    return {
      failureClass: 'author',
      badge: 'build failed',
      headline: 'The build failed — a fix is needed in your app',
      guidance: AUTHOR_FAILURE_GUIDANCE,
      excerpt: rest,
    };
  }

  return unknown(rest);
}
