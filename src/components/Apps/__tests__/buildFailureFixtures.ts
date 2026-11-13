import {
  buildFailureDeployDetail,
  sanitizeBuildFailureReason,
} from '~/server/services/blocks/build-failure-reason';

/**
 * Stored `deploy_detail` values for a failed approved version, built by the callback's own
 * writer (`buildFailureDeployDetail`): `Build <status>`, a blank line, then the sanitized
 * log excerpt. Each `*_EXCERPT` is that sanitized excerpt — what the author is shown.
 *
 * The excerpts are what the pipeline actually delivered to authors, with anything that
 * identifies the build platform removed: the scanner's own notice lines are dropped,
 * everything after the `SCAN-BLOCKED` marker is reworded generically, and the vulnerable
 * package in the table is replaced by a neutral name. The table layout (in the raw input),
 * the `SCAN-BLOCKED` marker, the pre-check message and the `Build None` headline are kept
 * verbatim, because those are what the classifier reads.
 *
 * `Build None` is real: the reported status is the final publish step's, so a run that
 * failed before it arrives as `None`.
 */

/** A blocking security-scan finding in a platform-provided package. */
const SCAN_BLOCKED_RAW = [
  ' Library      Vulnerability  Severity  Status  Installed Version  Fixed Version   Title',
  ' libexample   CVE-2000-0001  HIGH      fixed   1.0.0-r0           1.0.1-r0        libexample: ...',
  'SCAN-BLOCKED: the security scan found blocking vulnerabilities in the app image -- failing the build before publish. See the table above.',
].join('\n');
export const SCAN_BLOCKED_DETAIL = buildFailureDeployDetail('None', SCAN_BLOCKED_RAW);
export const SCAN_BLOCKED_EXCERPT = sanitizeBuildFailureReason(SCAN_BLOCKED_RAW) as string;

/** A build pre-check that the author can fix (the lockfile message, verbatim). */
export const RECIPE_ERROR_EXCERPT =
  "ERROR: no package-lock.json is committed. Commit your lockfile -- the platform build installs strictly from it (npm ci) so builds are reproducible. If your app uses pnpm or yarn, set the manifest buildCommand to that package manager (e.g. 'pnpm run build' -- add a matching 'build' script to package.json if you currently declare the bare 'vite build' form) and commit that lockfile instead.";
export const RECIPE_ERROR_DETAIL = buildFailureDeployDetail('None', RECIPE_ERROR_EXCERPT);

/** A build that failed with no excerpt at all. */
export const BUILD_NONE_DETAIL = buildFailureDeployDetail('None', undefined);

/** A failure whose log tail carries no recognised marker (here: a registry error). */
export const NPM_TAIL_EXCERPT = [
  'npm error code E404',
  'npm error 404 Not Found - GET https://registry.npmjs.org/left-padd - Not found',
  'npm error A complete log of this run can be found in: <build-path>/npm-debug.log',
].join('\n');
export const NPM_TAIL_DETAIL = buildFailureDeployDetail('Failed', NPM_TAIL_EXCERPT);

/** The apply step timed out after a successful build. */
export const DEPLOY_TIMED_OUT_DETAIL = 'Deploy timed out';

const ESC = String.fromCharCode(0x1b);

/**
 * Tenant-controlled bytes: markup, a terminal escape sequence and a single very long line.
 * Built by hand, NOT through the writer, on purpose: the server strips escape sequences
 * before storing, but the renderer must be safe on its own, so this keeps one the
 * sanitizer would have removed.
 */
export const HOSTILE_EXCERPT = [
  '</script><script>alert(1)</script>',
  '<img src=x onerror="alert(2)"> <b>bold?</b>',
  `${ESC}[31mred${ESC}[0m`,
  'x'.repeat(5000),
].join('\n');
export const HOSTILE_DETAIL = `Build None\n\n${HOSTILE_EXCERPT}`;
