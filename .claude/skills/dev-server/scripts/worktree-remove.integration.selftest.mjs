/**
 * `node .claude/skills/dev-server/scripts/worktree-remove.integration.selftest.mjs`
 *
 * `wt rm`'s daemon guard, against a real throwaway repository.
 *
 * It lives apart from `worktree.selftest.mjs` because `cmdRemove` cannot be called in-process: it
 * reports refusals through `fail()`, which is `process.exit(1)`. So each case runs in a child, and
 * what is asserted is the pair a person actually sees — the exit code and the refusal text.
 *
 * Why a guard on this command is worth a repository to test: `wt rm` unlinks every reparse point in
 * the tree BEFORE it deletes, so a guard that lets one through does not fail cleanly, it fails with
 * the tree already gutted. Both defects found in review on 868kzk7pf were in exactly this logic, and
 * both were found by reading rather than by a test.
 *
 * The three refusal cases never reach a delete — the daemon check is the first thing `cmdRemove`
 * does after confirming the target is a registered worktree. The two proceeding cases do delete,
 * which is the point: a scratch worktree, and the assertion is that it is gone.
 */

import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { join, resolve } from 'path';

const SELF = fileURLToPath(import.meta.url);
const TREE_IN_CHILD = process.env.WT_RM_TARGET;

const skillOf = (root) => `${root}/.claude/skills/dev-server`;

// The child. One case, one process, because a refusal ends the process.
if (TREE_IN_CHILD) {
  const { cmdRemove } = await import('./worktree.mjs');
  const daemonRoot = JSON.parse(process.env.WT_RM_DAEMON);
  const daemonRequest = async (path) =>
    path === '/' ? daemonRoot : { ok: true, status: 200, data: { sessions: [], apps: [] } };
  await cmdRemove(
    process.env.WT_RM_PRIMARY,
    TREE_IN_CHILD,
    { stopServer: false, force: process.env.WT_RM_FORCE === '1' },
    daemonRequest
  );
  process.exit(0);
}

let failures = 0;
function check(name, actual, expected) {
  const pass = actual === expected;
  if (!pass) failures++;
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  ${name}\n        got=${JSON.stringify(actual)}\n       want=${JSON.stringify(expected)}`
  );
}

const git = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const scratch = mkdtempSync(join(tmpdir(), 'wt-rm-'));
const primary = join(scratch, 'primary');

try {
  git(['init', '-q', '-b', 'main', primary], scratch);
  // Local identity only: a box whose global git has no user configured must not fail here, and one
  // that does must not have this commit attributed to them.
  git(['config', 'user.email', 'selftest@example.invalid'], primary);
  git(['config', 'user.name', 'wt rm selftest'], primary);
  writeFileSync(join(primary, 'README'), 'scratch\n');
  git(['add', 'README'], primary);
  git(['commit', '-qm', 'base'], primary);

  let n = 0;
  const freshTree = () => {
    const path = join(scratch, `wt-${++n}`);
    git(['worktree', 'add', '-q', path, '-b', `feat/case-${n}`, 'main'], primary);
    return path;
  };

  // `run` returns what the operator sees: the exit code, and the two streams joined, since a
  // refusal goes to stderr and a proceed-anyway notice goes to stdout.
  const run = (target, daemon, force) => {
    const r = spawnSync(process.execPath, [SELF], {
      encoding: 'utf8',
      env: {
        ...process.env,
        WT_RM_TARGET: target,
        WT_RM_PRIMARY: primary,
        WT_RM_DAEMON: JSON.stringify(daemon),
        WT_RM_FORCE: force ? '1' : '0',
      },
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };

  const held = (tree) => ({
    ok: true,
    status: 200,
    data: { pid: 999, skillDir: skillOf(tree), cwd: primary },
  });
  const atPrimary = {
    ok: true,
    status: 200,
    data: { pid: 999, skillDir: skillOf(primary), cwd: primary },
  };
  const tooOld = { ok: true, status: 200, data: { pid: 46332 } };

  // 1-2. A NAMED holder is absolute. `--force` is offered on the usage line, so an agent will try
  // it; it must not work here, because no delete can succeed while that process lives.
  for (const force of [false, true]) {
    const tree = freshTree();
    const r = run(tree, held(tree), force);
    const label = force ? 'with --force' : 'without --force';
    check(`a named holder refuses ${label}`, r.code, 1);
    check(
      `  and names the pid ${label}`,
      r.out.includes('hosts the dev-server daemon (pid 999)'),
      true
    );
    check(`  and says --force will not help ${label}`, r.out.includes('--force does NOT'), true);
    check(`  and the tree is still there ${label}`, existsSync(tree), true);
  }

  // 3. The case the whole ticket is about: a daemon too old to say where it runs from is neither a
  // holder nor ruled out. Before this it walked straight through and failed at the delete.
  {
    const tree = freshTree();
    const r = run(tree, tooOld, false);
    check('an unanswered daemon refuses', r.code, 1);
    check('  and says it is not ruled out', r.out.includes('NOT ruled out'), true);
    check('  and offers --force', r.out.includes('--force'), true);
    check('  and the tree is still there', existsSync(tree), true);
  }

  // 4. ...but overridably, or one stale daemon freezes worktree removal on the whole box until
  // somebody restarts a SHARED daemon.
  {
    const tree = freshTree();
    const r = run(tree, tooOld, true);
    check('--force overrides an unanswered daemon', r.code, 0);
    check('  and says that is why it proceeded', r.out.includes('proceeding because --force'), true);
    check('  and the tree is gone', existsSync(tree), false);
  }

  // 5. The negative control. Without it every assertion above is also satisfied by a `cmdRemove`
  // that refuses everything, which would be a worse command than the one being fixed.
  {
    const tree = freshTree();
    const r = run(tree, atPrimary, false);
    check('a daemon at the primary blocks nothing', r.code, 0);
    check('  and says nothing about the daemon', r.out.includes('dev-server daemon'), false);
    check('  and the tree is gone', existsSync(tree), false);
  }
} finally {
  // `git worktree remove` would refuse the trees already deleted above, so the directory goes
  // wholesale and the repository it registered with goes with it.
  rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
  if (existsSync(resolve(scratch))) console.log(`note: could not clean up ${scratch}`);
}

console.log(failures ? `\n${failures} FAILURES` : '\nall green');
process.exit(failures ? 1 : 0);
