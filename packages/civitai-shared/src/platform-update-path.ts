// Import-free so the assistant runner (which bundles only workspace packages) applies the same
// rule as civitai's platform-update write path.

/**
 * Why `path` is not a repo-relative path a platform update may name, or `null` when it is: empty
 * or past 400 characters, absolute, a backslash, a control character, or an empty, `.` or `..`
 * segment. The shape half of civitai's `platformUpdatePathRefusal`, which adds what a source repo
 * never holds; the assistant runner writes a staff update's files into the sandbox by this alone.
 */
export function platformUpdatePathShapeRefusal(path: string): string | null {
  if (!path || path.length > 400) return 'is empty or too long';
  // eslint-disable-next-line no-control-regex
  if (path.startsWith('/') || path.includes('\\') || /[\x00-\x1f\x7f]/.test(path))
    return 'is not a relative repo path';
  if (path.split('/').some((s) => s === '' || s === '.' || s === '..'))
    return 'is not a relative repo path';
  return null;
}
