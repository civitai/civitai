/**
 * App env files: copy the primary checkout's `.env` files into a worktree.
 *
 * Every worktree gets a full copy of each one — the root `.env` and every per-app `.env` —
 * so a tree works the same whether it is run through the daemon or through a bare
 * `pnpm` / `prisma` command that reads `.env` itself. Skill credentials
 * (`.claude/skills/*​/.env`) are `skill-env.mjs`'s and are left out here.
 *
 * A copy is a snapshot: an edit to the primary's file later does not reach the tree.
 * `wt env <tree> --refresh` re-copies every file the primary holds a newer version of.
 *
 * 🔴 NEVER PRINTS A VALUE. Reports are paths only.
 */

import { execFileSync } from 'child_process';
import { copyFileSync, existsSync, statSync } from 'fs';
import { dirname, join, posix } from 'path';
import { samePath } from './paths.mjs';

// `.env`, `.env.local`, `.env.development`, … — not examples or hand-made backups.
const ENV_NAME = /^\.env(\.[\w.-]+)?$/;
const NOT_ENV = /example|sample|template|bak/i;

function lsOthers(primary, extra) {
  const out = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z', ...extra], {
    cwd: primary,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\0').filter(Boolean);
}

/**
 * Repo-relative paths (forward slashes) of the primary's untracked `.env` files, sorted.
 *
 * Found through git rather than a directory walk: `--directory` collapses ignored directories
 * (`node_modules`, `.next`) to one entry, so this costs a git call, not a crawl of the install.
 * A `.env` inside a wholly ignored directory is therefore not found — none lives in one today.
 */
export function findAppEnvFiles(primary) {
  const paths = new Set([
    ...lsOthers(primary, ['--ignored', '--directory']),
    ...lsOthers(primary, []),
  ]);
  return [...paths]
    .filter((p) => !p.endsWith('/'))
    .filter((p) => !p.startsWith('.claude/skills/'))
    .filter((p) => {
      const name = posix.basename(p);
      return ENV_NAME.test(name) && !NOT_ENV.test(name);
    })
    .sort();
}

/**
 * Copy the primary's app env files into `target`.
 *
 * Fills gaps only, unless `refresh`: then a tree file is also overwritten when the primary's
 * copy was modified more recently — including over the tree's own edit, if that is older.
 * A file whose directory does not exist in the target (an app the branch predates) is skipped.
 */
export function syncAppEnv(primary, target, { refresh = false } = {}) {
  if (samePath(primary, target))
    return { skipped: 'same-tree', copied: [], refreshed: [], kept: [], noDir: [] };

  const result = { copied: [], refreshed: [], kept: [], noDir: [] };
  for (const rel of findAppEnvFiles(primary)) {
    const from = join(primary, rel);
    const to = join(target, rel);
    if (!existsSync(dirname(to))) {
      result.noDir.push(rel);
      continue;
    }
    if (existsSync(to)) {
      if (refresh && statSync(from).mtimeMs > statSync(to).mtimeMs) {
        copyFileSync(from, to);
        result.refreshed.push(rel);
      } else result.kept.push(rel);
      continue;
    }
    copyFileSync(from, to);
    result.copied.push(rel);
  }
  return result;
}
