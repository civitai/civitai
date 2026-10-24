// Worktree sessions start with Turbopack's dev filesystem cache off; the primary checkout keeps it,
// and an explicit NEXT_DEV_FS_CACHE in the session's .env chain wins over the default. The env is
// built by the real loadEnvChain over real .env files, so a worktree opt-in is tested where it lives.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { applyDevFsCacheDefault, loadEnvChain } from './daemon.mjs';

const failures = [];
let checks = 0;

function check(name, actual, expected) {
  checks++;
  if (actual !== expected) {
    failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const root = mkdtempSync(join(tmpdir(), 'dev-fs-cache-'));
const primary = join(root, 'model-share');
const worktree = join(root, 'worktrees', 'feature');
mkdirSync(primary, { recursive: true });
mkdirSync(worktree, { recursive: true });
writeFileSync(join(primary, '.env'), 'PORT=3000\n');

function sessionEnv(worktreeEnv) {
  writeFileSync(join(worktree, '.env'), worktreeEnv);
  return loadEnvChain([join(primary, '.env'), join(worktree, '.env')]);
}

try {
  check(
    'worktree defaults to off',
    applyDevFsCacheDefault(sessionEnv(''), { worktree, primary, worktreeOptIn: false })
      .NEXT_DEV_FS_CACHE,
    'false'
  );
  check(
    'primary keeps the cache',
    applyDevFsCacheDefault(loadEnvChain([join(primary, '.env')]), {
      worktree: primary,
      primary,
      worktreeOptIn: false,
    }).NEXT_DEV_FS_CACHE,
    undefined
  );
  check(
    'primary spelled with a trailing separator is still the primary',
    applyDevFsCacheDefault({}, { worktree: primary + '/', primary, worktreeOptIn: false })
      .NEXT_DEV_FS_CACHE,
    undefined
  );
  check(
    'worktree .env NEXT_DEV_FS_CACHE=true wins',
    applyDevFsCacheDefault(sessionEnv('NEXT_DEV_FS_CACHE=true\n'), {
      worktree,
      primary,
      worktreeOptIn: false,
    }).NEXT_DEV_FS_CACHE,
    'true'
  );
  check(
    'skill WORKTREE_DEV_FS_CACHE opt-in keeps it for worktrees',
    applyDevFsCacheDefault(sessionEnv(''), { worktree, primary, worktreeOptIn: true })
      .NEXT_DEV_FS_CACHE,
    undefined
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failures.length) {
  console.error('FAIL');
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log(`dev-fs-cache selftest: ${checks} checks passed`);
