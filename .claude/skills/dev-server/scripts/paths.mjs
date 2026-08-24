// Path identity, in one place.
//
// This PR fixed the same comparison bug in four separate spots — the app session key, the .env chain
// dedupe, the primary-worktree refusal, and the lookup immediately below that refusal — and left the
// rule written twice, in daemon.mjs and worktree.mjs. Two copies means the next person to improve
// one (trailing separators, UNC paths, `\\?\` prefixes) improves half the callers, and the
// disagreement surfaces as `wt rm` refusing a tree the daemon is serving, or not refusing one it is.
//
// It lives in its own leaf module rather than in daemon.mjs because worktree.mjs and the selftests
// would otherwise import a module that runs `execSync` and constructs AuthHub and RgbProxy at load
// just to reach six lines of string comparison.
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
