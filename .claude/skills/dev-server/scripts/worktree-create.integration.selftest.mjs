/**
 * `node .claude/skills/dev-server/scripts/worktree-create.integration.selftest.mjs`
 *
 * `wt new`, against a real throwaway repository. Each case runs in a child because `cmdCreate`
 * refuses through `fail()`, which is `process.exit(1)`.
 *
 * The local `main` is deliberately one commit ahead of what was cloned AND behind the remote, so a
 * branch forked from local HEAD, from a stale `origin/main`, or left tracking `main` each fails a
 * different assertion.
 */

import { execFileSync, spawnSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { join } from 'path';

const SELF = fileURLToPath(import.meta.url);

if (process.env.WT_NEW_ARGS) {
  const { cmdCreate } = await import('./worktree.mjs');
  const [primary, name, branch, base] = JSON.parse(process.env.WT_NEW_ARGS);
  await cmdCreate(primary, name, branch, { base, noInstall: true });
  process.exit(0);
}

let failures = 0;
function check(name, actual, expected) {
  const pass = actual === expected;
  if (!pass) failures++;
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  ${name}\n        got=${JSON.stringify(
      actual
    )}\n       want=${JSON.stringify(expected)}`
  );
}

const git = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gitQuiet = (args, cwd) => {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
};
const identity = (repo) => {
  git(['config', 'user.email', 'selftest@example.invalid'], repo);
  git(['config', 'user.name', 'wt new selftest'], repo);
};
const commit = (repo, file) => {
  writeFileSync(join(repo, file), `${file}\n`);
  git(['add', file], repo);
  git(['commit', '-qm', file], repo);
  return git(['rev-parse', 'HEAD'], repo);
};

const run = (primary, name, branch, base) => {
  const r = spawnSync(process.execPath, [SELF], {
    env: { ...process.env, WT_NEW_ARGS: JSON.stringify([primary, name, branch, base]) },
    encoding: 'utf8',
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

// The CLI's argument parsing, which the in-process cases below bypass.
const { parseNewArgs } = await import('./worktree.mjs');
const args = (tail) => JSON.stringify(parseNewArgs(tail));
check(
  'parses <name> <branch>',
  args(['one', 'feat/one']),
  JSON.stringify({ name: 'one', branch: 'feat/one', noInstall: false })
);
check(
  'parses --base anywhere',
  args(['--base', 'origin/feat/x', 'one', 'feat/one']),
  JSON.stringify({ name: 'one', branch: 'feat/one', base: 'origin/feat/x', noInstall: false })
);
check(
  'parses --no-install',
  args(['one', 'feat/one', '--no-install']),
  JSON.stringify({ name: 'one', branch: 'feat/one', noInstall: true })
);

const scratch = mkdtempSync(join(tmpdir(), 'wt-new-'));

try {
  const origin = join(scratch, 'origin.git');
  const seed = join(scratch, 'seed');
  const reposRoot = join(scratch, 'repos');
  const primary = join(reposRoot, 'primary');
  mkdirSync(reposRoot);

  git(['init', '-q', '--bare', '-b', 'main', origin], scratch);
  git(['clone', '-q', origin, seed], scratch);
  identity(seed);
  commit(seed, 'a');
  // apps/web exists on the branch; apps/gone does not, so its .env has nowhere to go
  mkdirSync(join(seed, 'apps', 'web'), { recursive: true });
  writeFileSync(join(seed, '.gitignore'), '.env\n.env.*\n!.env.example\n');
  writeFileSync(join(seed, '.env.example'), 'KEY=\n');
  writeFileSync(join(seed, 'apps', 'web', 'keep'), '');
  git(['add', '.gitignore', '.env.example', 'apps/web/keep'], seed);
  git(['commit', '-qm', 'env layout'], seed);
  git(['push', '-q', 'origin', 'main'], seed);

  git(['clone', '-q', origin, primary], scratch);
  identity(primary);
  const localOnly = commit(primary, 'local-only');
  writeFileSync(join(primary, '.env'), 'ROOT=1\n');
  writeFileSync(join(primary, '.env.local'), 'LOCAL=1\n');
  writeFileSync(join(primary, '.env.bak-123'), 'OLD=1\n');
  writeFileSync(join(primary, 'apps', 'web', '.env'), 'WEB=1\n');
  mkdirSync(join(primary, 'apps', 'gone'), { recursive: true });
  writeFileSync(join(primary, 'apps', 'gone', '.env'), 'GONE=1\n');

  const remoteTip = commit(seed, 'c');
  git(['push', '-q', 'origin', 'main'], seed);

  const created = run(primary, 'one', 'feat/one');
  const tree = join(reposRoot, 'worktrees', 'one');
  check('creates the worktree', created.code, 0);
  check('places it under <repos-root>/worktrees/<name>', existsSync(tree), true);
  check(
    'forks from the FETCHED origin/main, not local HEAD',
    git(['rev-parse', 'HEAD'], tree),
    remoteTip
  );
  check(
    'local-only commit is not on the branch',
    gitQuiet(['merge-base', '--is-ancestor', localOnly, 'HEAD'], tree),
    null
  );
  check('branch has no upstream', gitQuiet(['config', 'branch.feat/one.merge'], primary), null);
  check(
    'status line is the branch alone',
    git(['status', '-sb'], tree).split('\n')[0],
    '## feat/one'
  );
  const read = (rel) => (existsSync(join(tree, rel)) ? readFileSync(join(tree, rel), 'utf8') : null);
  check('copies the root .env', read('.env'), 'ROOT=1\n');
  check('copies a .env.* variant', read('.env.local'), 'LOCAL=1\n');
  check('copies a per-app .env', read('apps/web/.env'), 'WEB=1\n');
  check('skips a .env backup', read('.env.bak-123'), null);
  check('skips an app the branch does not have', existsSync(join(tree, 'apps', 'gone')), false);
  check('the copies stay out of git', git(['status', '--porcelain'], tree), '');

  // `wt env --refresh`: re-copies what the primary edited since, fills nothing over a newer file
  const { syncAppEnv } = await import('./app-env.mjs');
  writeFileSync(join(tree, 'apps', 'web', '.env'), 'WEB=tree\n');
  const past = new Date(Date.now() - 60_000);
  utimesSync(join(tree, 'apps', 'web', '.env'), past, past);
  writeFileSync(join(primary, '.env'), 'ROOT=2\n');
  check('without --refresh, an existing file is kept', syncAppEnv(primary, tree).refreshed.join(), '');
  check('without --refresh, the old value stays', read('.env'), 'ROOT=1\n');
  const refreshed = syncAppEnv(primary, tree, { refresh: true }).refreshed;
  check('--refresh re-copies files the primary edited later', refreshed.join(), '.env,apps/web/.env');
  check('--refresh brings the new value', read('.env'), 'ROOT=2\n');
  writeFileSync(join(primary, '.env.example'), 'KEY=edited-in-primary\n');
  syncAppEnv(primary, tree, { refresh: true });
  check('never copies a tracked .env.example', /edited-in-primary/.test(read('.env.example')), false);

  const dupBranch = run(primary, 'two', 'feat/one');
  check('refuses an existing branch name', dupBranch.code, 1);
  check('says why', /branch already exists/.test(dupBranch.out), true);

  const dupPath = run(primary, 'one', 'feat/other');
  check('refuses an existing path', dupPath.code, 1);

  const localBase = run(primary, 'three', 'feat/three', 'main');
  check('refuses a local --base', localBase.code, 1);
  check('creates nothing on refusal', existsSync(join(reposRoot, 'worktrees', 'three')), false);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
