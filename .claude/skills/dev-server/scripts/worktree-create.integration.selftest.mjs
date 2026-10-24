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
  statSync,
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

if (process.env.WT_ENV_ARGS) {
  const { cmdSkillEnv } = await import('./skill-env.mjs');
  const [primary, ...argv] = JSON.parse(process.env.WT_ENV_ARGS);
  cmdSkillEnv(primary, argv);
  process.exit(process.exitCode ?? 0);
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

const runEnv = (scratchHome, primary, ...argv) => {
  const r = spawnSync(process.execPath, [SELF], {
    env: {
      ...process.env,
      CIVITAI_SKILL_ENV_HOME: scratchHome,
      WT_ENV_ARGS: JSON.stringify([primary, ...argv]),
    },
    encoding: 'utf8',
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
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
  mkdirSync(join(seed, 'apps', 'auth'), { recursive: true });
  writeFileSync(join(seed, 'apps', 'auth', 'keep'), '');
  git(['add', '.gitignore', '.env.example', 'apps/web/keep', 'apps/auth/keep'], seed);
  git(['commit', '-qm', 'env layout'], seed);
  git(['push', '-q', 'origin', 'main'], seed);

  git(['clone', '-q', origin, primary], scratch);
  identity(primary);
  const localOnly = commit(primary, 'local-only');
  // The primary root .env's database is the dev one; a primary app .env may name another.
  const DEV = 'postgres://dev:dev@dev.example.invalid:5432/civitai';
  const DEV_REPLICA = 'postgres://dev:dev@dev-replica.example.invalid:5432/civitai';
  const PLANTED = 'postgres://u:p@example.invalid:5432/x';
  const devLines = `DATABASE_URL=${DEV}\nDATABASE_REPLICA_URL=${DEV_REPLICA}\n`;
  // The CSAM_* keys arrive with values and must leave empty, commented lines included.
  const plantedAuth =
    `AUTH=1\nDATABASE_URL=${PLANTED}\nDATABASE_REPLICA_URL=${PLANTED}\n# DATABASE_URL=${PLANTED}\n` +
    'CSAM_UPLOAD_KEY=planted-csam-key\n# CSAM_UPLOAD_SECRET=planted-csam-secret\n';
  const routedAuth = `AUTH=1\n${devLines}CSAM_UPLOAD_KEY=\n# CSAM_UPLOAD_SECRET=\n`;
  const planted = (text) => (text ?? '').split('u:p@example.invalid').length - 1;
  const plantedCsam = (text) => (text ?? '').split('planted-csam').length - 1;
  const rootSrc = (n) => `ROOT=${n}\n${devLines}CSAM_BUCKET_NAME=planted-csam-bucket\n`;
  const rootCopy = (n) => `ROOT=${n}\n${devLines}CSAM_BUCKET_NAME=\n`;
  writeFileSync(join(primary, '.env'), rootSrc(1));
  writeFileSync(join(primary, 'apps', 'auth', '.env'), plantedAuth);
  writeFileSync(join(primary, '.env.local'), 'LOCAL=1\n');
  const realMail =
    'A=1\nEMAIL_HOST=smtp.example.net\nEMAIL_PORT=587\nEMAIL_USER=real-user\nEMAIL_PASS=real-pass\n' +
    '# EMAIL_HOST=smtp.example.org\nEMAIL_FROM=Real <a@example.net>\n';
  writeFileSync(join(primary, '.env.development'), realMail);
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
  check('copies the root .env, its CSAM_* keys present and empty', read('.env'), rootCopy(1));
  check('the root copy holds no planted CSAM_* value', plantedCsam(read('.env')), 0);
  check("the auth app's copy holds no planted CSAM_* value", plantedCsam(read('apps/auth/.env')), 0);
  check('wt new names the files it emptied', /CSAM_\* emptied in 2 \(\.env, apps\/auth\/\.env\)/.test(created.out), true);
  check(
    "the auth app's copy takes the primary root .env's database, its commented line dropped",
    read('apps/auth/.env'),
    routedAuth
  );
  check("the auth app's copy holds no trace of the primary app's database", planted(read('apps/auth/.env')), 0);
  check(
    "the primary's own auth .env is untouched",
    readFileSync(join(primary, 'apps', 'auth', '.env'), 'utf8'),
    plantedAuth
  );
  check('wt new names the files it routed', /DATABASE_URL.*apps\/auth\/\.env/.test(created.out), true);
  check('copies a .env.* variant', read('.env.local'), 'LOCAL=1\n');
  check('copies a per-app .env', read('apps/web/.env'), 'WEB=1\n');
  check('skips a .env backup', read('.env.bak-123'), null);
  const catcherMail =
    'A=1\n\n# Email: local catcher (Mailpit, docker-compose.base.yml)\nEMAIL_HOST=localhost\n' +
    'EMAIL_PORT=1025\nEMAIL_SECURE=false\nEMAIL_USER=local\nEMAIL_PASS=local\n' +
    'EMAIL_FROM="Civitai Dev <noreply@localhost>"\n';
  check(
    'a copied .env has its mail lines, commented ones too, replaced by the catcher',
    read('.env.development'),
    catcherMail
  );
  check('skips an app the branch does not have', existsSync(join(tree, 'apps', 'gone')), false);
  check('the copies stay out of git', git(['status', '--porcelain'], tree), '');

  // `wt env --refresh`: re-copies what the primary edited since, fills nothing over a newer file
  const { syncAppEnv } = await import('./app-env.mjs');
  writeFileSync(join(tree, 'apps', 'web', '.env'), 'WEB=tree\n');
  const past = new Date(Date.now() - 60_000);
  utimesSync(join(tree, 'apps', 'web', '.env'), past, past);
  writeFileSync(join(primary, '.env'), rootSrc(2));
  check('without --refresh, an existing file is kept', syncAppEnv(primary, tree).refreshed.join(), '');
  check('without --refresh, the old value stays', read('.env'), rootCopy(1));
  const refreshed = syncAppEnv(primary, tree, { refresh: true }).refreshed;
  check('--refresh re-copies files the primary edited later', refreshed.join(), '.env,apps/web/.env');
  check('--refresh brings the new value', read('.env'), rootCopy(2));
  writeFileSync(join(tree, '.env.development'), 'A=tree\n');
  utimesSync(join(tree, '.env.development'), past, past);
  writeFileSync(join(primary, '.env.development'), realMail);
  syncAppEnv(primary, tree, { refresh: true });
  check('--refresh routes mail to the catcher too', read('.env.development'), catcherMail);
  writeFileSync(join(primary, '.env.example'), 'KEY=edited-in-primary\n');
  syncAppEnv(primary, tree, { refresh: true });
  check('never copies a tracked .env.example', /edited-in-primary/.test(read('.env.example')), false);

  // `wt env` repairs a tree copied before the routing existed: a KEPT file is routed in place, its
  // mtime left alone so a later primary edit still looks newer to --refresh.
  const home = join(scratch, 'skill-env-home');
  const treeAuth = join(tree, 'apps', 'auth', '.env');
  writeFileSync(treeAuth, plantedAuth);
  utimesSync(treeAuth, past, past);
  const repaired = runEnv(home, primary, tree);
  check('wt env exits 0 on a repair', repaired.code, 0);
  check('wt env routes a kept file to the primary root database', read('apps/auth/.env'), routedAuth);
  check('... leaving none of the planted value', planted(read('apps/auth/.env')), 0);
  check('... and keeps its mtime', Math.round(statSync(treeAuth).mtimeMs / 1000), Math.round(past.getTime() / 1000));
  check('... and says which file', /db\s+apps\/auth\/\.env/.test(repaired.out), true);
  check('wt env empties the planted CSAM_* values in a kept file', plantedCsam(read('apps/auth/.env')), 0);
  check('... and says which file', /emptied\s+apps\/auth\/\.env/.test(repaired.out), true);
  const future = new Date(Date.now() + 60_000);
  writeFileSync(treeAuth, plantedAuth);
  utimesSync(treeAuth, future, future);
  check('wt env --refresh exits 0', runEnv(home, primary, tree, '--refresh').code, 0);
  check('wt env --refresh routes a kept file too', read('apps/auth/.env'), routedAuth);

  // A file only the tree has: its CSAM_* keys are emptied, its database left as the tree wrote it.
  const handMade = join(tree, 'apps', 'auth', '.env.local');
  writeFileSync(handMade, `LOCAL=1\nDATABASE_URL=${PLANTED}\nCSAM_UPLOAD_KEY=planted-csam-local\n`);
  const ownRun = runEnv(home, primary, tree);
  check('wt env exits 0 with a tree-only env file', ownRun.code, 0);
  check(
    "wt env empties a tree-only file's CSAM_* keys and keeps its database",
    read('apps/auth/.env.local'),
    `LOCAL=1\nDATABASE_URL=${PLANTED}\nCSAM_UPLOAD_KEY=\n`
  );
  check('... and says which file', /emptied\s+apps\/auth\/\.env\.local/.test(ownRun.out), true);
  rmSync(handMade);

  // No dev database to route to: refuse, and write nothing.
  writeFileSync(join(primary, '.env'), 'ROOT=3\n');
  writeFileSync(treeAuth, plantedAuth);
  const noDev = runEnv(home, primary, tree);
  check('wt env exits 1 when the primary root .env has no DATABASE_URL', noDev.code, 1);
  check('... naming the key', /no active DATABASE_URL/.test(noDev.out), true);
  check('... and leaves the tree file as it was', read('apps/auth/.env'), plantedAuth);
  const noDevNew = run(primary, 'four', 'feat/four');
  check('wt new exits 1 when the primary root .env has no DATABASE_URL', noDevNew.code, 1);
  check('... naming the key', /no active DATABASE_URL/.test(noDevNew.out), true);
  check(
    '... and copies no auth .env',
    existsSync(join(reposRoot, 'worktrees', 'four', 'apps', 'auth', '.env')),
    false
  );
  writeFileSync(join(primary, '.env'), rootSrc(2));

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
