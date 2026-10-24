// Path identity, in one place.
//
// A leaf module rather than a corner of daemon.mjs, because worktree.mjs, cli.mjs and the selftests
// would otherwise import a module that constructs AuthHub and RgbProxy at load just to reach a
// string comparison and a `git rev-parse`. Nothing in here runs at import.
//
// One definition, because the next person to improve it (trailing separators, UNC paths, `\\?\`
// prefixes) has to improve every caller at once: a daemon and a `wt rm` that disagree about whether
// two paths are the same tree is how `wt rm` deletes one the daemon is serving.
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { relative, resolve, sep } from 'path';

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

/**
 * The checkout that owns the `.git` directory, resolved from anywhere inside it.
 *
 * The skill directory is committed, so every worktree has its own copy of it and `__dirname` names
 * whichever tree the caller happened to be standing in. Two things must not be derived that way:
 * the base of the daemon's env chain (a worktree's copy of a file the worktree does not have), and
 * the daemon's own script path — a daemon running out of a worktree holds that directory open, and
 * `wt rm` on it fails EBUSY for as long as the daemon lives.
 *
 * `git rev-parse --git-common-dir` answers with the primary's `.git` from inside any worktree,
 * which is the only spelling of this that does not depend on where the process was started. Falls
 * back to `from` when git cannot answer, which is the pre-worktree behaviour; callers that need to
 * know the difference read `derived`.
 *
 * @param {string} from — a directory inside the repository
 * @returns {{ path: string, derived: boolean, error: string | null }}
 */
export function resolvePrimaryCheckout(from) {
  try {
    const gitCommonDir = execSync('git rev-parse --path-format=absolute --git-common-dir', {
      cwd: from,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      // The daemon has no console of its own, so every console child it starts without this
      // allocates one — which Windows 11 hands to the default terminal app, popping a Windows
      // Terminal window that takes focus. Piping stdio does not prevent the allocation.
      windowsHide: true,
      // This runs at module load in the daemon, before the listener exists, so a wedged git would
      // hang it where `ensureDaemon` reports a bare "Failed to start daemon" with nothing naming git.
      timeout: 5000,
    }).trim();
    if (gitCommonDir) return { path: resolve(gitCommonDir, '..'), derived: true, error: null };
  } catch (e) {
    return { path: from, derived: false, error: e.message };
  }
  return { path: from, derived: false, error: 'git named no common dir' };
}

/**
 * True when `child` is `parent` or sits underneath it.
 *
 * Compared segment-wise rather than with `startsWith`, which calls `.../worktrees/foo-old` a child
 * of `.../worktrees/foo` and would have `wt rm` blame a daemon in a sibling tree.
 */
export function isInside(child, parent) {
  if (samePath(child, parent)) return true;
  const p = canonicalPath(parent);
  // `resolve` has already dropped any trailing separator except on a drive/filesystem root, where
  // it must stay: `c:\` + sep would be `c:\\` and match nothing.
  return canonicalPath(child).startsWith(p.endsWith(sep) ? p : p + sep);
}

/**
 * Where a daemon this process spawns should live: its script, its pid file, its cwd.
 *
 * One function because cli.mjs and console.mjs both spawn the daemon, and a version of this that
 * lived at both call sites is the shape daemon-port.mjs already documents going wrong — open-coded
 * at five sites, disagreeing at three. Two spawners that disagree about the daemon's home would put
 * a second daemon's pid in the first one's pid file.
 *
 * @param {string} callerSkillDir — the calling module's own skill directory (`__dirname`)
 * @param {string} callerProjectRoot — the checkout that directory is in
 */
export function resolveDaemonHome(callerSkillDir, callerProjectRoot) {
  const skillRelative = relative(callerProjectRoot, callerSkillDir);
  const primary = resolvePrimaryCheckout(callerProjectRoot);
  const primarySkillDir = resolve(primary.path, skillRelative);
  // Both halves checked, not just `derived`: a checkout whose skill directory has been moved or
  // removed on the primary's branch would otherwise send us to spawn a file that is not there, and
  // `ensureDaemon` reports that as a bare "Failed to start daemon".
  const fromPrimary = primary.derived && existsSync(resolve(primarySkillDir, 'scripts/daemon.mjs'));
  return {
    fromPrimary,
    primary,
    home: fromPrimary ? primary.path : callerProjectRoot,
    skillDir: fromPrimary ? primarySkillDir : callerSkillDir,
  };
}

/** The canonical spelling of a path, for use as a Map key where samePath cannot be called. */
export function canonicalPath(p) {
  const resolved = resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
