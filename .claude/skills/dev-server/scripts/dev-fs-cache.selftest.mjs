// Worktree sessions start with Turbopack's dev filesystem cache ON, like the primary checkout;
// WORKTREE_DEV_FS_CACHE=false opts out, and an explicit NEXT_DEV_FS_CACHE in the session's .env chain
// wins over the default. The env is built by the real loadEnvChain over real .env files, so a
// worktree override is tested where it lives. The second half covers the cross-worktree cache sweep.
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  utimesSync,
  statSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { applyDevFsCacheDefault, loadEnvChain } from './daemon.mjs';
import { sweepWorktreeCaches } from './dev-cache-sweep.mjs';

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
    'worktree defaults to on',
    applyDevFsCacheDefault(sessionEnv(''), { worktree, primary, worktreeCache: true })
      .NEXT_DEV_FS_CACHE,
    undefined
  );
  check(
    'WORKTREE_DEV_FS_CACHE=false turns it off for a worktree',
    applyDevFsCacheDefault(sessionEnv(''), { worktree, primary, worktreeCache: false })
      .NEXT_DEV_FS_CACHE,
    'false'
  );
  check(
    'primary keeps the cache even when worktrees opt out',
    applyDevFsCacheDefault(loadEnvChain([join(primary, '.env')]), {
      worktree: primary,
      primary,
      worktreeCache: false,
    }).NEXT_DEV_FS_CACHE,
    undefined
  );
  check(
    'primary spelled with a trailing separator is still the primary',
    applyDevFsCacheDefault({}, { worktree: primary + '/', primary, worktreeCache: false })
      .NEXT_DEV_FS_CACHE,
    undefined
  );
  check(
    'worktree .env NEXT_DEV_FS_CACHE=true wins over the opt-out',
    applyDevFsCacheDefault(sessionEnv('NEXT_DEV_FS_CACHE=true\n'), {
      worktree,
      primary,
      worktreeCache: false,
    }).NEXT_DEV_FS_CACHE,
    'true'
  );
  check(
    'worktree .env NEXT_DEV_FS_CACHE=false wins over the default',
    applyDevFsCacheDefault(sessionEnv('NEXT_DEV_FS_CACHE=false\n'), {
      worktree,
      primary,
      worktreeCache: true,
    }).NEXT_DEV_FS_CACHE,
    'false'
  );

  // --- sweep ---
  const MB = 1024 ** 2;
  const HOUR = 3600 * 1000;
  const now = Date.now();
  const make = (name, mbBytes, ageHours) => {
    const path = join(root, 'sweep', name);
    const cache = join(path, '.next', 'dev', 'cache');
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, 'data'), Buffer.alloc(mbBytes * MB));
    const t = new Date(now - ageHours * HOUR);
    utimesSync(join(cache, 'data'), t, t);
    utimesSync(cache, t, t);
    return { path, cache };
  };
  const oldest = make('oldest', 3, 30);
  const middle = make('middle', 3, 20);
  const live = make('live', 3, 40); // oldest of all, but running
  const fresh = make('fresh', 3, 0.01); // written seconds ago
  const prim = make('primary', 3, 50);
  const trees = [oldest, middle, live, fresh, prim].map((t) => ({ path: t.path }));
  const run = (isBusy, maxMb) =>
    sweepWorktreeCaches({
      trees,
      primary: prim.path,
      isBusy,
      maxBytes: maxMb * MB,
      now,
    });
  const liveOnly = (p) => p === live.path;

  const r = run(liveOnly, 10); // 4 worktree caches = 12 MB; need to shed 3 MB
  check('sweep removes the oldest idle cache first', existsSync(oldest.cache), false);
  check('sweep stops once under budget', existsSync(middle.cache), true);
  check('sweep leaves a running worktree alone', existsSync(live.cache), true);
  check('sweep never touches the primary', existsSync(prim.cache), true);
  check('sweep reports the freed cache', r.removed.length, 1);

  const r2 = run(liveOnly, 1); // far over budget: everything evictable goes
  check('over budget removes the other idle cache', existsSync(middle.cache), false);
  check('a running worktree survives an impossible budget', existsSync(live.cache), true);
  check('a cache written minutes ago survives', existsSync(fresh.cache), true);
  check(
    'sweep says what it could not free',
    r2.kept
      .map((k) => k.why)
      .sort()
      .join('|'),
    'has a running session|written in the last few minutes'
  );
  check('budget 0 turns the sweep off', run(() => false, 0).removed.length, 0);

  // A top-level dir mtime that is old must not hide a server writing deeper down.
  const deep = make('deep', 3, 30);
  const nested = join(deep.cache, 'turbopack', 'segment');
  mkdirSync(nested, { recursive: true });
  const old = new Date(now - 30 * HOUR);
  utimesSync(deep.cache, old, old);
  utimesSync(join(deep.cache, 'turbopack'), old, old);
  writeFileSync(join(nested, 'fresh.sst'), 'x'); // mtime: now
  utimesSync(deep.cache, old, old); // creating the subdirs moved it; put it back
  trees.push({ path: deep.path });
  const topMtime = statSync(deep.cache).mtimeMs;
  run(() => false, 1);
  check(
    'a fresh file deep in the cache keeps it despite an old top-dir mtime',
    existsSync(deep.cache),
    true
  );
  // Control: the same layout judged by the directory mtime alone would be evicted.
  check('CONTROL: top-dir mtime alone says idle', now - topMtime > 10 * 60 * 1000, true);

  // Positive control: with the running-session guard broken the same sweep deletes the live tree,
  // so the "survives" checks above could have failed.
  run(() => false, 1);
  check('POSITIVE CONTROL: broken guard deletes the live cache', existsSync(live.cache), false);
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failures.length) {
  console.error('FAIL');
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log(`dev-fs-cache selftest: ${checks} checks passed`);
