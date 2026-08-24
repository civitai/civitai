// Layering checks for the .env chain. The regression this guards is not "the merge is wrong" but
// "the merge is gone": before it, a worktree .env REPLACED the primary, so a two-key override file
// started the server with no DATABASE_URL.
//
// It deliberately covers BOTH halves. loadEnvChain honours the order of the array it is handed, and
// appEnvChain decides what that order is — testing only the first leaves the mirror-image outage
// (every worktree override silently ignored, primary always winning) passing green.
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { loadEnvChain, appEnvChain, APP_REGISTRY, primaryCheckout, AppSession } from './daemon.mjs';

const dir = mkdtempSync(resolve(tmpdir(), 'env-chain-'));
const base = resolve(dir, 'base.env');
const overlay = resolve(dir, 'overlay.env');
const failures = [];
let checks = 0;

function check(name, actual, expected) {
  checks++;
  if (actual !== expected) {
    failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

try {
  writeFileSync(base, 'DATABASE_URL=postgres://base\nSHARED=from-base\nREDIS_URL=redis://base\nBLANKED=real-secret\n');
  writeFileSync(overlay, 'SHARED=from-overlay\nBLANKED=\n');

  // --- loadEnvChain: the merge itself ---
  const merged = loadEnvChain([base, overlay]);
  check('overlay wins on a restated key', merged.SHARED, 'from-overlay');
  check('base survives a key the overlay omits', merged.DATABASE_URL, 'postgres://base');
  check('base survives a second omitted key', merged.REDIS_URL, 'redis://base');

  // An empty value in the overlay UNSETS the base value rather than being skipped. Pinned because
  // the plausible future edit here is "don't let a blank line clobber a real secret" (`if (v)`),
  // which silently reverses this and passes every other check in this file.
  check('an empty overlay value blanks the base value', merged.BLANKED, '');

  const missingOverlay = loadEnvChain([base, resolve(dir, 'nope.env')]);
  check('a missing overlay contributes nothing', missingOverlay.DATABASE_URL, 'postgres://base');

  check('an empty chain is empty', Object.keys(loadEnvChain([])).length, 0);
  check('a chain of one is that one file', loadEnvChain([base]).SHARED, 'from-base');

  // Order is the contract, so assert it in both directions — a reversed loop passes a one-direction
  // test whenever the fixtures happen to agree.
  check('reversed order reverses the winner', loadEnvChain([overlay, base]).SHARED, 'from-base');

  // --- appEnvChain: who BUILDS the array ---
  const worktree = resolve(dir, 'worktree');
  mkdirSync(worktree, { recursive: true });
  const chain = appEnvChain(worktree, 'moderator');
  const relative = APP_REGISTRY.moderator.path;

  check('app chain is base-then-overlay, two entries', chain.length, 2);
  check('app chain BASE is the primary checkout', chain[0], resolve(primaryCheckout, relative, '.env'));
  check('app chain TOP is the worktree', chain[chain.length - 1], resolve(worktree, relative, '.env'));

  // Started from the primary checkout the two paths are identical; a duplicate would make the log
  // read `Env: a <- a` and is pure noise.
  const selfChain = appEnvChain(primaryCheckout, 'moderator');
  check('the primary checkout does not chain onto itself', selfChain.length, 1);

  // --- WHICH OBJECT, not how it parses ---
  // The DATABASE_URL warning and the "no env" refusal both read spawnEnv(), and the bug they were
  // fixed for was not a parsing bug — it was reading the CHAIN when the child is handed
  // `{ ...process.env, ...chain }`. Reverting to loadEnvChain(this.envPaths) passes every check in
  // db-host.selftest.mjs, because all of those call the parser directly. This is the one that sees it.
  const probe = new AppSession('moderator', worktree, 5174, [base]);
  const env = probe.spawnEnv();
  check('spawnEnv layers the chain over process.env', env.SHARED, 'from-base');
  check('spawnEnv keeps a key only process.env has', env.PATH, process.env.PATH);
  check('spawnEnv is stable within one start', probe.spawnEnv(), env);

  // An empty chain means "this daemon does not supply this process's env" — the auth hub, which lets
  // Vite load its own .env. spawnEnv must then be process.env itself, and the warning must stay
  // quiet rather than naming an inherited candidate the process may not even use.
  const hubLike = new AppSession('moderator', worktree, 5174, []);
  check('an empty chain is process.env itself', hubLike.spawnEnv(), process.env);

  // Stability is the benign half; STALENESS is the half with teeth. Without the per-start
  // invalidation, editing an .env to point away from production and restarting spawns with the old
  // DATABASE_URL — and because dbHost reads the same cached object, the warning line then confirms
  // the host you just changed away from.
  writeFileSync(base, 'SHARED=edited-on-disk\n');
  check('the cache does not notice a file edit on its own', probe.spawnEnv().SHARED, 'from-base');
  probe.invalidateSpawnEnv();
  check('invalidating picks up the edit', probe.spawnEnv().SHARED, 'edited-on-disk');

  // The method is only half of it — #start() has to CALL it. Testable without spawning anything: a
  // start against a path that does not exist invalidates first and then fails at the probes, so no
  // child is ever created. Without the call, a restart after an .env edit spawns with the old
  // DATABASE_URL, and dbHost reads the same cached object — so the warning line confirms the host
  // you just changed away from.
  writeFileSync(base, 'SHARED=edited-again\n');
  const wired = new AppSession('moderator', resolve(dir, 'no-such-worktree'), 5174, [base]);
  wired.spawnEnvCache = { SHARED: 'stale-from-a-previous-start' };
  const result = await wired.start();
  check('a start on a missing path errors without spawning', result.status, 'error');
  check('start() invalidates the cached env', wired.spawnEnv().SHARED, 'edited-again');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failures.length) {
  console.error('FAIL');
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log(`env-chain selftest: ${checks} checks passed`);
