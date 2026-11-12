/**
 * Which paths of an app's files are never copied into a fork's seed or committed to a source
 * repo: secrets, git metadata, dependencies and build output. Pure (no I/O), shared by
 * `app-fork-start.service.ts` and `app-source-repo.plan.ts`.
 */

/** Top-level directories that hold dependencies or build output, never source. */
const BUILD_OUTPUT_DIRS = new Set([
  'dist',
  'build',
  'out',
  '.next',
  '.turbo',
  '.vercel',
  '.cache',
  '.output',
  'coverage',
]);

const SSH_KEY_RE = /^id_(rsa|dsa|ecdsa|ed25519)(_sk)?(\.pub)?$/;
const KEY_FILE_RE = /\.(pem|key|p12|pfx|p8|ppk|jks|keystore)$/i;
/** Files that commonly hold a registry token, a password or a cloud credential. */
const CREDENTIAL_FILES = new Set([
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  '.netrc',
  '.pypirc',
  '.git-credentials',
  '.dev.vars',
  '.pgpass',
  '.htpasswd',
  'credentials.json',
]);
/** Directories that hold credentials wholesale. */
const CREDENTIAL_DIRS = new Set(['.ssh', '.aws', '.docker', '.gnupg', '.kube']);

/**
 * Why `path` is left out of a fork's seed, or `null` to keep it. Secrets (`.env*`, keys,
 * the common credential files and directories), git metadata, dependencies (`node_modules` at any
 * depth) and top-level build output. A superset of what the sandbox service itself skips.
 *
 * ⚠ A DENYLIST, SO NOT A GUARANTEE: a secret in a file with an ordinary name (a hard-coded token
 * in `src/config.ts`) is copied like any other source. What the fork receives is the parent's
 * APPROVED source, which a moderator has reviewed; this list only removes the usual places a
 * credential sits beside it.
 */
export function forkSeedExclusionReason(path: string): string | null {
  const segments = path.split('/').filter(Boolean);
  const base = segments[segments.length - 1] ?? '';
  if (segments.some((s) => s === '.git')) return 'git';
  if (segments.some((s) => s.startsWith('.env'))) return 'env';
  if (segments.some((s) => s === 'node_modules')) return 'dependencies';
  if (segments.length > 1 && BUILD_OUTPUT_DIRS.has(segments[0])) return 'build-output';
  if (KEY_FILE_RE.test(base) || SSH_KEY_RE.test(base)) return 'key';
  if (CREDENTIAL_FILES.has(base) || segments.some((s) => CREDENTIAL_DIRS.has(s)))
    return 'credentials';
  return null;
}
