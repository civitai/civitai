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
import { isInside, samePath } from './paths.mjs';
import { resolve, sep } from 'path';

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
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
function prStatus(branch, cwd) {
  const raw = spawnGh(
    [
      'pr',
      'list',
      '--state',
      'all',
      '--head',
      branch,
      '--json',
      'number,state,isDraft',
      '--limit',
      '5',
    ],
    cwd
  );
  if (!raw) return { merged: null, label: 'PR state unknown (gh failed)' };
  try {
    return describePrRows(JSON.parse(raw));
  } catch {
    return { merged: null, label: 'PR state unknown (gh returned unparseable JSON)' };
  }
}

/**
 * Everything below the merged/not-merged split was already in hand and thrown away, so an open PR, a
 * draft, a closed-unmerged PR and a branch with no PR at all all printed `no merged PR` — the four
 * cases a person deciding whether to delete a tree most needs told apart.
 */
export function describePrRows(rows) {
  if (!Array.isArray(rows))
    return { merged: null, label: 'PR state unknown (gh returned unparseable JSON)' };
  const num = (r) => (typeof r.number === 'number' ? `#${r.number}` : 'of unknown number');
  const merged = rows.find((r) => r.state === 'MERGED');
  if (merged) return { merged: merged.number ?? null, label: `PR ${num(merged)} merged` };
  // Deliberately not "no PR exists": `gh` here has been seen switching itself to an account with no
  // visibility of this repo, which returns an empty list and exit 0. Saying none was FOUND keeps the
  // four states apart without inviting anyone to delete a tree on the strength of an empty answer.
  if (!rows.length) return { merged: null, label: 'gh found no PR for this branch' };
  const open = rows.find((r) => r.state === 'OPEN');
  if (open) {
    return { merged: null, label: `PR ${num(open)} still OPEN${open.isDraft ? ' (draft)' : ''}` };
  }
  return { merged: null, label: `PR ${num(rows[0])} closed WITHOUT merging` };
}

function spawnGh(args, cwd) {
  try {
    return execFileSync('gh', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
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

// The daemon reports where its own code lives; a daemon running out of this tree holds the
// directory open and no delete can succeed while it lives.
export async function daemonRunningFrom(target, daemonRequest) {
  return daemonHeldFrom(await daemonRequest('/'), target);
}

// The same verdict from an already-fetched `/`, so `wt stale` asks once for a dozen trees instead of
// once per tree.
//
// `checked` is separate from `holder` on purpose. A daemon that is down, unreachable, or older than
// the `skillDir` field yields no holder AND no knowledge, and the caller must not then report the
// daemon as ruled out.
export function daemonHeldFrom(res, target) {
  // A daemon that does not answer at all is not running, and a daemon that is not running holds no
  // directory open. That is the one unknown that rules ITSELF out, and keeping it separate is what
  // stops a box with no daemon from reporting every tree as unremovable forever.
  if (!res.ok) return { holder: null, checked: false, reachable: false };
  const skillDir = res.data?.skillDir;
  if (!skillDir) return { holder: null, checked: false, reachable: true };
  // Its script AND its working directory: either one alone keeps the directory open. A daemon
  // started by hand from a worktree runs the primary's script and still pins the tree by cwd.
  const held = [
    ['its running script', skillDir],
    ['its working directory', res.data.cwd],
  ].find(([, p]) => p && isInside(p, target));
  return {
    holder: held ? { pid: res.data.pid, reason: `${held[0]}: ${held[1]}` } : null,
    checked: true,
    reachable: true,
  };
}

// 🔴 UNKNOWN IS NOT NO. A daemon too old to report `skillDir` answers `/` with a bare pid, and
// 868kzk7pf is those two being indistinguishable: `wt stale` called a tree safe while the daemon ran
// out of it, then `wt rm` unlinked every reparse point and failed EBUSY. So an unanswered check
// keeps the tree in KEEP and says which of the two it is.
export function daemonBlockReason(daemon) {
  if (!daemon) return null;
  if (daemon.holder)
    return `hosts the dev-server daemon (pid ${daemon.holder.pid}) - ${daemon.holder.reason}`;
  if (!daemon.checked && daemon.reachable)
    return 'a running dev-server daemon did not say where it runs from (it predates PR #4641) - NOT ruled out';
  return null;
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
  const [running, daemonRoot] = await Promise.all([fetchRunning(daemonRequest), daemonRequest('/')]);
  const rows = [];
  for (const t of trees) {
    const isPrimary = samePath(t.path, primaryPath);
    const sessions = sessionsIn(t.path, running);
    const pr = t.branch ? prStatus(t.branch, primary) : { merged: null, label: 'detached' };
    rows.push({
      path: t.path,
      branch: t.branch,
      detached: t.detached,
      isPrimary,
      mergedPr: pr.merged,
      prLabel: pr.label,
      dirty: dirtyCount(t.path),
      unpushed: t.branch ? unpushedCount(t.branch, primary) : null,
      lastCommit: lastCommit(t.path),
      sessions: sessions.map((s) => ({ id: s.id, port: s.port, status: s.status })),
      daemon: daemonHeldFrom(daemonRoot, t.path),
    });
  }
  return rows;
}

/**
 * Which trees `wt stale` offers and which it keeps — separated from the printing so a selftest can
 * reach the decision without a git tree, a `gh` call and a daemon.
 */
export function partitionStale(rows) {
  const candidates = rows.filter((r) => !r.isPrimary);
  const removable = candidates.filter(
    (r) => r.mergedPr && !r.dirty && r.sessions.length === 0 && !daemonBlockReason(r.daemon)
  );
  return {
    candidates,
    removable,
    blocked: candidates.filter((r) => !removable.includes(r)),
    // One `/` answer decides every row, so this is one fact about the daemon rather than a tally.
    daemonUnasked: candidates.length > 0 && candidates.every((r) => daemonBlockReason(r.daemon) && !r.daemon?.checked),
  };
}

/** Every reason this tree is in KEEP, in the order they are printed. */
export function keepReasons(r, daemonUnasked) {
  const why = [];
  if (r.sessions.length) why.push(`dev server ${r.sessions.map((s) => `${s.id}:${s.port}`).join(',')}`);
  if (r.dirty) why.push(`${r.dirty} uncommitted`);
  if (!r.mergedPr) why.push(r.prLabel);
  const daemonWhy = daemonBlockReason(r.daemon);
  if (daemonWhy) why.push(daemonUnasked ? 'daemon NOT ruled out (see above)' : daemonWhy);
  return why;
}

export async function cmdStale(primary, daemonRequest) {
  const rows = await inspect(primary, daemonRequest);
  const { candidates, removable, blocked, daemonUnasked } = partitionStale(rows);

  if (daemonUnasked) {
    console.log(
      '\n[!] a dev-server daemon is running but did not say where it runs from, so NO tree can be\n' +
        '    cleared of hosting it. It predates PR #4641 and stays that way until it is restarted -\n' +
        '    which is shared, so check "cli.mjs test list" is empty and ask before restarting it.'
    );
  }

  console.log(
    `\nSAFE TO REMOVE (${removable.length}) - merged PR, clean tree, no dev server, not hosting the daemon\n`
  );
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
    console.log(`  ${r.path}`);
    console.log(`      ${r.branch || '(detached)'}  ${keepReasons(r, daemonUnasked).join('; ')}`);
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

  // Ahead of the session stops, not merely ahead of the delete. `--stop-server` stops OTHER agents'
  // dev servers in this tree, which is irreversible and cannot be undone by the refusal that would
  // otherwise follow it.
  const daemonCheck = await daemonRunningFrom(target, daemonRequest);
  // The same verdict `wt stale` prints. It used to refuse only a KNOWN holder, so the case that
  // actually cost the 40 minutes — a daemon too old to answer, which is neither a holder nor ruled
  // out — walked straight past this and failed at the `rmSync` below with the tree already gutted.
  const daemonWhy = daemonBlockReason(daemonCheck);
  if (daemonWhy) {
    fail(
      `${daemonWhy}\n` +
        (daemonCheck.holder
          ? `no delete can succeed while it lives — that path is inside the directory.\n` +
            `a daemon started by a cli.mjs carrying this fix runs from the primary checkout and never\n` +
            `blocks this; this one does not.`
          : `so this delete may be the one that unlinks the tree and then cannot remove it.`) +
        `\nit is SHARED — other agents' dev servers and queued test runs are on it — so check\n` +
        `"cli.mjs test list" reports zero running and zero queued, and ask before restarting it.`
    );
  }

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

  // Read before the delete: afterwards there is no way to learn which `.git/worktrees/<name>` was
  // this tree's, and that name is what prune reports.
  const adminDir = gitQuiet(['rev-parse', '--absolute-git-dir'], target);

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
        `could not delete ${target}: ${err.message}\n` +
          (daemonCheck.checked
            ? `the dev-server daemon was asked and is running from elsewhere, so it is not the holder.\n` +
              `look for a shell cwd'd inside, an editor, an unmanaged dev server, or a virus scan.`
            : `the dev-server daemon could not be asked where it runs from (down, unreachable, or too\n` +
              `old to report it), so it has NOT been ruled out — check it before hunting a stray shell.`)
      );
    }
    if (existsSync(target)) fail(`directory still present after delete: ${target}`);
    console.log('directory deleted');
  }

  const pruned = describePrune(git(['worktree', 'prune', '-v'], primary), adminDir);
  for (const line of pruned) console.log(line);

  if (!entry.branch) return;

  const pr = prStatus(entry.branch, primary);
  if (!pr.merged) {
    console.log(`branch KEPT: ${entry.branch} (${pr.label})`);
  } else if (unpushed) {
    console.log(
      `branch KEPT: ${entry.branch} (PR #${pr.merged} merged, but ${unpushed} commit(s) exist on no remote)`
    );
  } else {
    const sha = gitQuiet(['rev-parse', entry.branch], primary);
    git(['branch', '-D', entry.branch], primary);
    console.log(`branch deleted: ${entry.branch} (PR #${pr.merged}, was ${sha})`);
  }
}

/**
 * `git worktree prune` is repo-wide: it drops every stale registration it finds, not only the one
 * this command removed. Printing its `-v` output raw made another agent's already-deleted tree read
 * as something `wt rm <path>` had just done, and produced two false alarms in one night.
 *
 * `adminName` is the directory under `.git/worktrees/`, NOT the worktree's own basename, because
 * those differ: `git worktree add` de-duplicates a colliding basename by appending a digit, so two
 * live trees both called `mine` register as `mine` and `mine1`. Matching on the basename cannot tell
 * them apart and labels one agent's tree as the other's — the direction this function exists to
 * prevent (measured in a scratch repo, 2026-08-25). It has to be read before the delete, and when it
 * could not be read this says so rather than guessing.
 */
export function describePrune(raw, adminName) {
  const lines = String(raw ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return ['pruned: no stale worktree registrations'];

  const leaf = (p) =>
    String(p ?? '')
      .split(/[\\/]/)
      .filter(Boolean)
      .pop() || null;
  // Case-SENSITIVE: both sides are git's own spelling of the same directory (one from `rev-parse`,
  // one from prune), and on a case-sensitive filesystem `Mine` and `mine` are two different trees.
  const mineName = leaf(adminName);

  const out = [];
  let collateral = 0;
  let unknown = 0;
  for (const line of lines) {
    // git's only wording here is `Removing worktrees/<admin>: <reason>` (git/worktree.c).
    const named = line.match(/^Removing\s+worktrees\/(.+?):/);
    if (!mineName || !named) {
      unknown++;
      out.push(`pruned (could not tell whose): ${line}`);
    } else if (named[1] === mineName) {
      out.push(`pruned: ${line}`);
    } else {
      collateral++;
      out.push(`pruned (ALSO, not your target): ${line}`);
    }
  }
  if (collateral) {
    out.push(
      `note: ${collateral} of those registration(s) were stale before this command ran - prune is repo-wide`
    );
  }
  if (unknown) {
    out.push(
      `note: ${unknown} line(s) could not be attributed - prune is repo-wide, so do not read them as this removal`
    );
  }
  return out;
}

function fail(msg) {
  console.error(`\n${msg}\n`);
  process.exit(1);
}
