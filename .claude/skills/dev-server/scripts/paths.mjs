// Path identity, in one place.
//
// A leaf module rather than a corner of daemon.mjs, because worktree.mjs and the selftests would
// otherwise import a module that runs `execSync` and constructs AuthHub and RgbProxy at load, just
// to reach six lines of string comparison.
//
// One definition, because the next person to improve it (trailing separators, UNC paths, `\\?\`
// prefixes) has to improve every caller at once: a daemon and a `wt rm` that disagree about whether
// two paths are the same tree is how `wt rm` deletes one the daemon is serving.
import { resolve } from 'path';

/**
 * True when two paths name the same location.
 *
 * win32-only case folding, deliberately. An unconditional lowercase would make two genuinely
 * different trees compare equal on a case-sensitive filesystem, and `wt rm --stop-server` would then
 * stop the other one's servers.
 */
export function samePath(a, b) {
  const x = resolve(a);
  const y = resolve(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** The canonical spelling of a path, for use as a Map key where samePath cannot be called. */
export function canonicalPath(p) {
  const resolved = resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
