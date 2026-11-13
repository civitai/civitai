// Every env the daemon spawns sends mail to the local catcher, whatever the .env chain or the
// daemon's own environment says.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadEnvChain, spawnEnvFor } from './daemon.mjs';
import { LOCAL_MAIL_ENV } from './local-mail.mjs';
import { redactedMismatch } from './selftest-redact.mjs';

const failures = [];
let checks = 0;

function check(name, actual, expected) {
  checks++;
  if (actual !== expected) failures.push(`${name}: ${redactedMismatch(actual, expected)}`);
}

function checkCatcher(name, env) {
  for (const [key, value] of Object.entries(LOCAL_MAIL_ENV))
    check(`${name} ${key}`, env[key], value);
}

const REAL =
  'EMAIL_HOST=smtp.example.net\nEMAIL_PORT=587\nEMAIL_SECURE=true\n' +
  'EMAIL_USER=real-user\nEMAIL_PASS=real-pass\nEMAIL_FROM=Real <a@example.net>\n';

const root = mkdtempSync(join(tmpdir(), 'local-mail-'));
const primary = join(root, 'model-share');
const worktree = join(root, 'worktrees', 'feature');
mkdirSync(primary, { recursive: true });
mkdirSync(worktree, { recursive: true });

try {
  writeFileSync(join(primary, '.env'), 'DATABASE_URL=postgres://x\n');
  writeFileSync(join(worktree, '.env'), REAL);
  const worktreeEnv = spawnEnvFor(loadEnvChain([join(primary, '.env'), join(worktree, '.env')]));
  checkCatcher('worktree .env with real mail:', worktreeEnv);
  check('the rest of the chain survives', worktreeEnv.DATABASE_URL, 'postgres://x');

  writeFileSync(join(primary, '.env'), REAL);
  checkCatcher('primary .env with real mail:', spawnEnvFor(loadEnvChain([join(primary, '.env')])));

  process.env.EMAIL_HOST = 'smtp.example.net';
  process.env.EMAIL_PASS = 'real-pass';
  checkCatcher('daemon process.env with real mail:', spawnEnvFor({}));
} finally {
  rmSync(root, { recursive: true, force: true });
}

// The two spawn sites: the main app session, and the auth hub / sibling apps (AppSession inherits
// AuthHub.spawnEnv). A site that builds its own env object would bypass the catcher.
const daemonSource = readFileSync(new URL('./daemon.mjs', import.meta.url), 'utf8');
check(
  'main app session spawns on spawnEnvFor',
  daemonSource.includes('const env = spawnEnvFor(envVars, '),
  true
);
check(
  'auth hub and apps spawn on spawnEnvFor',
  daemonSource.includes('this.spawnEnvCache = spawnEnvFor('),
  true
);

if (failures.length) {
  console.error(`local-mail: ${failures.length}/${checks} failed`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`local-mail: ${checks} checks passed`);
