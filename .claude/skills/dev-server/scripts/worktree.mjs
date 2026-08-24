/**
 * Worktree teardown and staleness reporting.
 *
 * Links are unlinked before the recursive delete for SPEED, not safety: pnpm makes nearly every
 * package a reparse point (8,180 under node_modules in one measured tree), and removing them as
 * links avoids walking ~200k files through them. Seven delete instruments were tested against a
 * sentinel behind a junction on 2026-08-12 and none followed the link, so the widely-repeated
 * "recursive delete eats the junction target" did not reproduce — don't restore that claim without
 * a fixture that shows it. The assert-zero gate stays as insurance against a tool or link type
 * that behaves differently.
 */

import { execFileSync } from 'child_process';
import { readdirSync, lstatSync, rmdirSync, rmSync, unlinkSync, existsSync } from 'fs';
import { samePath } from './paths.mjs';
import { resolve, sep } from 'path';

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gitQuiet(args, cwd) {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

export function listWorktrees(primary) {
  const out = git(['worktree', 'list', '--porcelain'], primary);
  const trees = [];
  let cur = null;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      cur = { path: resolve(line.slice(9)), branch: null, detached: false, locked: false };
      trees.push(cur);
    } else if (!cur) {
      continue;
    } else if (line.startsWith('branch refs/heads/')) {
      cur.branch = line.slice('branch refs/heads/'.length);
    } else if (line === 'detached') {
      cur.detached = true;
    } else if (line.startsWith('locked')) {
      cur.locked = true;
    }
  }
  return trees;
}

/** Depth-first, and deliberately does NOT descend into reparse points. */
function findReparsePoints(root) {
  const found = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const full = dir + sep + entry.name;
      let link = false;
      try {
        link = lstatSync(full).isSymbolicLink();
      } catch {
        continue;
      }
      if (link) found.push(full);
      else if (entry.isDirectory()) stack.push(full);
    }
  }
  return found.sort((a, b) => b.split(sep).length - a.split(sep).length);
}

/**
 * Removes the link itself, never its target. Which call does that is platform-specific and each
 * one errors on the other's link type: a POSIX symlink needs `unlink` and gives ENOTDIR to
 * `rmdir`, a Windows directory junction is the reverse and gives EPERM to `unlink`. Trying only
 * `rmdir` is what made `wt rm` unusable on macOS against any tree that had been `pnpm install`ed.
 */
function unlinkReparsePoint(link) {
  try {
    if (process.platform === 'win32') rmdirSync(link);
    else unlinkSync(link);
  } catch (err) {
    if (err.code !== 'ENOTDIR' && err.code !== 'EPERM' && err.code !== 'EISDIR') throw err;
    if (process.platform === 'win32') unlinkSync(link);
    else rmdirSync(link);
  }
}

/**
 * `--is-ancestor` is useless here: the repo squash-merges, so a merged branch's tip is never an
 * ancestor of origin/main. It reported "not merged" for 24 of 26 branches on one run.
 */
function mergedPr(branch, cwd) {
  const raw = spawnGh(
    ['pr', 'list', '--state', 'all', '--head', branch, '--json', 'number,state', '--limit', '5'],
    cwd
  );
  if (!raw) return null;
  let rows;
  try {
    rows = JSON.parse(raw);
  } catch {
    return null;
  }
  const merged = rows.find((r) => r.state === 'MERGED');
  return merged ? merged.number : null;
}

function spawnGh(args, cwd) {
  try {
    return execFileSync('gh', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

/** `git log --not --remotes` with no positive rev prints nothing and reads as "clean". */
function unpushedCount(branch, cwd) {
  const n = gitQuiet(['rev-list', '--count', branch, '--not', '--remotes'], cwd);
  return n === null ? null : Number(n);
}

function dirtyCount(worktreePath) {
  const out = gitQuiet(['status', '--porcelain'], worktreePath);
  if (out === null) return null;
  return out === '' ? 0 : out.split(/\r?\n/).length;
}

function lastCommit(worktreePath) {
  return gitQuiet(['log', '-1', '--format=%ci'], worktreePath);
}

// Both lists in one round-trip, so a caller looping over worktrees does not re-fetch per iteration.
async function fetchRunning(daemonRequest) {
  const [sessionRes, appRes] = await Promise.all([
    daemonRequest('/sessions'),
    daemonRequest('/apps'),
  ]);
  return {
    sessions: sessionRes.ok ? sessionRes.data.sessions || [] : [],
    apps: appRes.ok ? appRes.data.apps || [] : [],
  };
}

// Main-app sessions AND app sessions, because both hold a port and a live process in this tree.
// While apps were global singletons they were invisible here, so `wt rm` would delete a worktree
// out from under a running moderator and report a clean removal.
function sessionsIn(worktreePath, running) {
  const inTree = (s) => s.worktree && samePath(s.worktree, worktreePath);

  const found = [];
  for (const s of running.sessions.filter(inTree)) {
    found.push({ id: s.id, port: s.port, status: s.status, stopPath: `/sessions/${s.id}` });
  }
  for (const a of running.apps.filter(inTree)) {
    found.push({
      id: `app:${a.name}`,
      port: a.port,
      status: a.status,
      stopPath: `/app/${a.name}/stop?worktree=${encodeURIComponent(a.worktree)}`,
    });
  }
  return found;
}

// `git worktree list` puts the main worktree first, always. The caller's `primary` is only the
// directory git is run from — invoked through a worktree's own copy of the CLI it IS that worktree,
// which inverts every isPrimary test: the real main checkout reads as a removable candidate and the
// worktree you are standing in reads as the thing to protect.
export function primaryOf(trees, fallback) {
  return trees.length ? trees[0].path : resolve(fallback);
}

export async function inspect(primary, daemonRequest) {
  const trees = listWorktrees(primary);
  const primaryPath = primaryOf(trees, primary);
  const running = await fetchRunning(daemonRequest);
  const rows = [];
  for (const t of trees) {
    const isPrimary = samePath(t.path, primaryPath);
    const sessions = sessionsIn(t.path, running);
    rows.push({
      path: t.path,
      branch: t.branch,
      detached: t.detached,
      isPrimary,
      mergedPr: t.branch ? mergedPr(t.branch, primary) : null,
      dirty: dirtyCount(t.path),
      unpushed: t.branch ? unpushedCount(t.branch, primary) : null,
      lastCommit: lastCommit(t.path),
      sessions: sessions.map((s) => ({ id: s.id, port: s.port, status: s.status })),
    });
  }
  return rows;
}

export async function cmdStale(primary, daemonRequest) {
  const rows = await inspect(primary, daemonRequest);
  const candidates = rows.filter((r) => !r.isPrimary);

  const removable = candidates.filter((r) => r.mergedPr && !r.dirty && r.sessions.length === 0);
  const blocked = candidates.filter((r) => !removable.includes(r));

  console.log(`\nSAFE TO REMOVE (${removable.length}) - merged PR, clean tree, no dev server\n`);
  if (!removable.length) console.log('  (none)');
  for (const r of removable) {
    const age = r.lastCommit ? r.lastCommit.slice(0, 10) : '?';
    const warn = r.unpushed
      ? `  [!] ${r.unpushed} commit(s) on no remote - branch will be KEPT`
      : '';
    console.log(`  ${r.path}`);
    console.log(`      ${r.branch || '(detached)'}  PR #${r.mergedPr}  last commit ${age}${warn}`);
  }

  console.log(`\nKEEP (${blocked.length})\n`);
  for (const r of blocked) {
    const why = [];
    if (r.sessions.length)
      why.push(`dev server ${r.sessions.map((s) => `${s.id}:${s.port}`).join(',')}`);
    if (r.dirty) why.push(`${r.dirty} uncommitted`);
    if (!r.mergedPr) why.push(r.branch ? 'no merged PR' : 'detached');
    console.log(`  ${r.path}`);
    console.log(`      ${r.branch || '(detached)'}  ${why.join('; ')}`);
  }
  console.log('\nRemove one with:  node .claude/skills/dev-server/cli.mjs wt rm <path>\n');
}

export async function cmdRemove(primary, targetArg, opts, daemonRequest) {
  const target = resolve(targetArg);
  const trees = listWorktrees(primary);
  const primaryPath = primaryOf(trees, primary);

  if (samePath(target, primaryPath)) fail('refusing to remove the primary worktree');

  const entry = trees.find((t) => samePath(t.path, target));
  if (!entry) fail(`not a registered worktree: ${target}\nrun: git worktree list`);

  const sessions = sessionsIn(target, await fetchRunning(daemonRequest));
  const live = sessions.filter((s) => s.status === 'running');
  if (live.length && !opts.stopServer) {
    fail(
      `dev server running for this worktree (${live
        .map((s) => `${s.id} on ${s.port}`)
        .join(', ')})\n` + `stop it first, or re-run with --stop-server`
    );
  }
  for (const s of sessions) {
    // An app stops through POST /app/<name>/stop; a main-app session through DELETE /sessions/<id>.
    // Both release the port — the difference is only which endpoint owns the reservation.
    await daemonRequest(s.stopPath, { method: s.id.startsWith('app:') ? 'POST' : 'DELETE' });
    console.log(`stopped ${s.id}`);
  }

  const dirty = dirtyCount(target);
  if (dirty && !opts.force) {
    fail(`${dirty} uncommitted change(s) in ${target}\ninspect them, or re-run with --force`);
  }

  const unpushed = entry.branch ? unpushedCount(entry.branch, primary) : null;

  if (!existsSync(target)) {
    console.log('directory already gone; pruning');
  } else {
    const links = findReparsePoints(target);
    console.log(`reparse points: ${links.length}`);
    for (const link of links) {
      unlinkReparsePoint(link);
    }
    const left = findReparsePoints(target);
    if (left.length) {
      fail(
        `${left.length} reparse point(s) still present - refusing to delete\n  ${left
          .slice(0, 5)
          .join('\n  ')}`
      );
    }
    console.log('reparse points remaining: 0');

    try {
      rmSync(target, { recursive: true, force: true });
    } catch (err) {
      fail(
        `could not delete ${target}: ${err.message}\nsomething is holding it open (a shell cwd'd inside it?)`
      );
    }
    if (existsSync(target)) fail(`directory still present after delete: ${target}`);
    console.log('directory deleted');
  }

  console.log(git(['worktree', 'prune', '-v'], primary) || 'pruned');

  if (!entry.branch) return;

  const pr = mergedPr(entry.branch, primary);
  if (!pr) {
    console.log(`branch KEPT: ${entry.branch} (no merged PR found)`);
  } else if (unpushed) {
    console.log(
      `branch KEPT: ${entry.branch} (PR #${pr} merged, but ${unpushed} commit(s) exist on no remote)`
    );
  } else {
    const sha = gitQuiet(['rev-parse', entry.branch], primary);
    git(['branch', '-D', entry.branch], primary);
    console.log(`branch deleted: ${entry.branch} (PR #${pr}, was ${sha})`);
  }
}

function fail(msg) {
  console.error(`\n${msg}\n`);
  process.exit(1);
}
