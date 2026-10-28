/**
 * App env files: copy the primary checkout's `.env` files into a worktree.
 *
 * Every worktree gets a copy of each one — the root `.env` and every per-app `.env` —
 * so a tree works the same whether it is run through the daemon or through a bare
 * `pnpm` / `prisma` command that reads `.env` itself. Skill credentials
 * (`.claude/skills/*​/.env`) are `skill-env.mjs`'s and are left out here.
 *
 * EMAIL_* lines are rewritten to the local mail catcher's on the way in (`local-mail.mjs`), so a
 * copy never carries real mail credentials. DATABASE_URL / DATABASE_REPLICA_URL take the primary
 * root `.env`'s values (`dev-db.mjs`) on the way in AND in files a tree already has, so a primary
 * app `.env` that points elsewhere never reaches a worktree. The keys `blank-keys.mjs` names keep
 * their lines with an empty value, the same way.
 *
 * A copy is a snapshot: an edit to the primary's file later does not reach the tree.
 * `wt env <tree> --refresh` re-copies every file the tree has not edited since the last copy, which
 * it knows from a sha256 per file kept in the tree's git dir (`RECORD`); `--force` re-copies the rest.
 *
 * 🔴 NEVER PRINTS A VALUE. Reports are paths only.
 */

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, readFileSync, statSync, utimesSync, writeFileSync } from 'fs';
import { dirname, join, posix } from 'path';
import { samePath } from './paths.mjs';
import { routeEnvTextToCatcher } from './local-mail.mjs';
import { DevDbMissingError, devDbFromEnvText, routeEnvTextToDevDb } from './dev-db.mjs';
import { blankEnvText } from './blank-keys.mjs';

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

const RECORD = 'dev-server-app-env.json';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/**
 * Where `target`'s record lives, or null when it is not a git checkout of its own. The `.git` check
 * keeps git from walking up and answering with an enclosing repo's dir.
 */
function recordPath(target) {
  if (!existsSync(join(target, '.git'))) return null;
  try {
    const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
      cwd: target,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim();
    return join(gitDir, RECORD);
  } catch {
    return null;
  }
}

function readRecord(path) {
  if (!path || !existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Copy the primary's app env files into `target`.
 *
 * Fills gaps only, unless `refresh`: then a tree file is also overwritten with the primary's when the
 * tree has not edited it, i.e. its sha256 is the one recorded when it was last written. A file that
 * differs from its record is skipped (`edited`); one with no record yet is skipped when it differs
 * from what a copy would write now (`unrecorded`), and recorded when it does not. `force` overwrites
 * both. A file whose directory does not exist in the target (an app the branch predates) is skipped.
 * Files left in place still have their DB lines routed (`dbRouted`) and their blanked keys emptied
 * (`blanked`), which is how `wt env` repairs a tree copied before either existed. Env files only the
 * tree has get their blanked keys emptied too.
 *
 * Throws DevDbMissingError, writing nothing, when a file has an active DB line and the primary
 * root `.env` has no DATABASE_URL to give it.
 */
export function syncAppEnv(primary, target, { refresh = false, force = false } = {}) {
  const result = {
    copied: [],
    refreshed: [],
    kept: [],
    edited: [],
    unrecorded: [],
    noDir: [],
    dbRouted: [],
    blanked: [],
  };
  if (samePath(primary, target)) return { skipped: 'same-tree', ...result };
  refresh ||= force;

  const rootEnv = join(primary, '.env');
  const devDb = existsSync(rootEnv) ? devDbFromEnvText(readFileSync(rootEnv, 'utf8')) : null;
  const recordFile = recordPath(target);
  const record = readRecord(recordFile);
  const recorded = { ...record };
  const writes = [];
  const missing = [];
  const copyOf = (from) => {
    const blanked = blankEnvText(routeEnvTextToCatcher(readFileSync(from, 'utf8')));
    const routed = routeEnvTextToDevDb(blanked.text, devDb);
    return {
      text: routed.text,
      missing: routed.missing,
      dbRouted: routed.changed,
      blanked: blanked.changed,
    };
  };
  for (const rel of findAppEnvFiles(primary)) {
    const from = join(primary, rel);
    const to = join(target, rel);
    if (!existsSync(dirname(to))) {
      result.noDir.push(rel);
      continue;
    }
    const fresh = !existsSync(to);
    const have = fresh ? null : readFileSync(to, 'utf8');
    const copy = copyOf(from);
    const local = fresh
      ? false
      : record[rel]
        ? sha256(have) !== record[rel]
        : copy.missing || have !== copy.text;
    if (fresh || (refresh && (!local || force))) {
      if (copy.missing) missing.push(rel);
      recorded[rel] = sha256(copy.text);
      if (have === copy.text) {
        result.kept.push(rel);
        continue;
      }
      if (copy.dbRouted) result.dbRouted.push(rel);
      if (copy.blanked) result.blanked.push(rel);
      writes.push({ to, text: copy.text });
      (fresh ? result.copied : result.refreshed).push(rel);
      continue;
    }
    if (refresh) (record[rel] ? result.edited : result.unrecorded).push(rel);
    if (!local) recorded[rel] = sha256(have);
    const blanked = blankEnvText(have);
    const routed = routeEnvTextToDevDb(blanked.text, devDb);
    if (routed.missing) missing.push(rel);
    else if (routed.changed || blanked.changed) {
      writes.push({ to, text: routed.text, stat: statSync(to) });
      if (routed.changed) result.dbRouted.push(rel);
      if (blanked.changed) result.blanked.push(rel);
      if (!local) recorded[rel] = sha256(routed.text);
    }
    result.kept.push(rel);
  }
  // A file only the tree has (a hand-made `.env.local`, say) is the tree's own edit: its database
  // stays as written, but its blanked keys are emptied like every other.
  const fromPrimary = new Set([
    ...result.copied,
    ...result.refreshed,
    ...result.kept,
    ...result.noDir,
  ]);
  const own = existsSync(join(target, '.git')) ? findAppEnvFiles(target) : [];
  for (const rel of own.filter((r) => !fromPrimary.has(r))) {
    const to = join(target, rel);
    const blanked = blankEnvText(readFileSync(to, 'utf8'));
    if (!blanked.changed) continue;
    writes.push({ to, text: blanked.text, stat: statSync(to) });
    result.blanked.push(rel);
  }
  if (missing.length) throw new DevDbMissingError(missing);
  for (const { to, text, stat } of writes) {
    writeFileSync(to, text);
    if (stat) utimesSync(to, stat.atime, stat.mtime);
  }
  if (recordFile && JSON.stringify(recorded) !== JSON.stringify(record)) {
    writeFileSync(recordFile, `${JSON.stringify(recorded, null, 2)}\n`);
  }
  return result;
}

/** One line per file `--refresh` left alone, each naming `--force`. */
export function appEnvSkipLines(result) {
  return [
    ...result.edited.map(
      (p) => `  skipped   ${p} (edited in this tree since the last refresh; --force overwrites it)`
    ),
    ...result.unrecorded.map(
      (p) =>
        `  skipped   ${p} (no refresh record yet and it differs from the primary; --force overwrites it)`
    ),
  ];
}
