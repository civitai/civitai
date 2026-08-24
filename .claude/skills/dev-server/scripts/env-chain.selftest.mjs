// Layering check for loadEnvChain. The regression this guards is not "the merge is wrong" but
// "the merge is gone": before it, a worktree .env REPLACED the primary, so a two-key override file
// started the server with no DATABASE_URL. The first case fails loudly on exactly that revert.
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { loadEnvChain } from './daemon.mjs';

const dir = mkdtempSync(resolve(tmpdir(), 'env-chain-'));
const base = resolve(dir, 'base.env');
const overlay = resolve(dir, 'overlay.env');
const failures = [];

function check(name, actual, expected) {
  if (actual !== expected) failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

try {
  writeFileSync(base, 'DATABASE_URL=postgres://base\nSHARED=from-base\nREDIS_URL=redis://base\n');
  writeFileSync(overlay, 'SHARED=from-overlay\n');

  const merged = loadEnvChain([base, overlay]);
  check('overlay wins on a restated key', merged.SHARED, 'from-overlay');
  check('base survives a key the overlay omits', merged.DATABASE_URL, 'postgres://base');
  check('base survives a second omitted key', merged.REDIS_URL, 'redis://base');

  const missingOverlay = loadEnvChain([base, resolve(dir, 'nope.env')]);
  check('a missing overlay contributes nothing', missingOverlay.DATABASE_URL, 'postgres://base');

  check('an empty chain is empty', Object.keys(loadEnvChain([])).length, 0);

  // Order is the whole contract — assert it in both directions so a reversed loop is caught.
  check('reversed order reverses the winner', loadEnvChain([overlay, base]).SHARED, 'from-base');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failures.length) {
  console.error('FAIL');
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log('env-chain selftest: 6 checks passed');
