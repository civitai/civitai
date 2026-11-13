/**
 * Turbopack's dev filesystem cache is several GB per checkout, and worktrees multiply it across a
 * disk. This sweep keeps the total under a budget by deleting the cache of worktrees nobody is
 * running, oldest first. The cache is only a warm start: a deleted one is rebuilt on the next start.
 *
 * Only `.next/dev/cache` goes (and its per-branch twins), never `.next` itself, and never the primary
 * checkout, which is long-lived and earns its cache.
 */
import { existsSync, readdirSync, rmSync, statSync } from 'fs';
import { resolve } from 'path';
import { samePath } from './paths.mjs';

/** A cache written this recently may belong to a server the daemon does not know about. */
export const DEFAULT_MIN_IDLE_MS = 10 * 60 * 1000;

/**
 * Size and the newest mtime of anything under `dir`. A directory's own mtime only moves when entries
 * are added or removed directly in it, so a live server writing deeper down would look idle.
 */
export function dirStats(dir) {
  let size = 0;
  let newest = 0;
  try {
    newest = statSync(dir).mtimeMs;
  } catch (e) {}
  const stack = [dir];
  while (stack.length) {
    let entries;
    try {
      entries = readdirSync(stack.pop(), { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const entry of entries) {
      const full = resolve(entry.parentPath ?? entry.path, entry.name);
      if (entry.isDirectory()) stack.push(full);
      try {
        const st = statSync(full);
        if (!entry.isDirectory()) size += st.size;
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      } catch (e) {}
    }
  }
  return { size, newest };
}

export const dirSize = (dir) => dirStats(dir).size;

/** `.next/dev/cache`, plus `.next/branches/<slug>/dev/cache` when PER_BRANCH_DIST_DIR has been on. */
export function cacheDirsOf(worktree) {
  const dirs = [resolve(worktree, '.next', 'dev', 'cache')];
  try {
    for (const e of readdirSync(resolve(worktree, '.next', 'branches'), { withFileTypes: true })) {
      if (e.isDirectory())
        dirs.push(resolve(worktree, '.next', 'branches', e.name, 'dev', 'cache'));
    }
  } catch (e) {}
  return dirs.filter((d) => existsSync(d));
}

/**
 * @param trees     [{ path }] from `git worktree list`
 * @param primary   path of the primary checkout, which is never touched
 * @param isBusy    (worktreePath) => true when the daemon has a session or app there
 * @param maxBytes  budget for the summed caches; 0 or less turns the sweep off
 * @returns {{ total, remaining, removed: [{dir, size}], kept: [{dir, size, why}] }}
 */
export function sweepWorktreeCaches({
  trees,
  primary,
  isBusy,
  maxBytes,
  minIdleMs = DEFAULT_MIN_IDLE_MS,
  now = Date.now(),
  log,
  statsOf = dirStats,
  remove = (d) => rmSync(d, { recursive: true, force: true }),
}) {
  const report = { total: 0, remaining: 0, removed: [], kept: [] };
  if (!(maxBytes > 0)) return report;

  const entries = [];
  for (const tree of trees) {
    if (samePath(tree.path, primary)) continue;
    for (const dir of cacheDirsOf(tree.path)) {
      const { size, newest } = statsOf(dir);
      entries.push({ tree: tree.path, dir, size, mtime: newest });
    }
  }

  const gb = (n) => (n / 1024 ** 3).toFixed(1);
  let total = entries.reduce((sum, e) => sum + e.size, 0);
  report.total = total;
  log?.(
    'info',
    `Worktree dev caches: ${entries.length} dirs, ${gb(total)} GB (budget ${gb(maxBytes)} GB)`
  );

  for (const e of entries.sort((a, b) => a.mtime - b.mtime)) {
    if (total <= maxBytes) break;
    const why = isBusy(e.tree)
      ? 'has a running session'
      : now - e.mtime < minIdleMs
      ? 'written in the last few minutes'
      : null;
    if (why) {
      report.kept.push({ dir: e.dir, size: e.size, why });
      continue;
    }
    try {
      remove(e.dir);
      total -= e.size;
      report.removed.push({ dir: e.dir, size: e.size });
      log?.('info', `Evicted dev cache ${e.dir} (${gb(e.size)} GB, over worktree budget)`);
    } catch (err) {
      log?.('warn', `Could not evict ${e.dir}: ${err.message}`);
    }
  }

  report.remaining = total;
  if (total > maxBytes) {
    log?.(
      'warn',
      `Worktree dev caches still ${gb(total)} GB, over the ${gb(
        maxBytes
      )} GB budget: the rest are in use or fresh`
    );
  }
  return report;
}
