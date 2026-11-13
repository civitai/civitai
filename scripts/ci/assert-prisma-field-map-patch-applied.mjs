#!/usr/bin/env node
/**
 * Blocking guard: the Prisma runtime our generated client ACTUALLY LOADS carries the field-map
 * memo from `patches/@prisma__client@6.13.0.patch`.
 *
 * Prisma 6.x rebuilds a model's name->field map with a spread-reduce every time a single-record
 * method (`findUnique`, `findFirst`, `create`, `update`, `upsert`, `delete`, the `OrThrow`
 * variants) is looked up: O(fields^2) allocation per call, ~2.5 ms per `user.findUnique` with
 * the engine stubbed out. The unit test `src/server/db/__tests__/prisma-field-map-memo.test.ts`
 * is the behavioural guard, but the unit job does not run on pull requests, so this is the half
 * that can.
 *
 * - It reads the runtime file(s) named by the generated client's own `require(...)`, not a
 *   hardcoded path: the patch covers `runtime/library.js` only, so a generator change that
 *   loads a different runtime must fail here rather than pass over a file nobody loads.
 * - It requires the patch's marker, not just the absence of the old pattern: a re-minified
 *   rebuild in another shape would otherwise pass.
 * - A Prisma bump already fails `pnpm install` (ERR_PNPM_UNUSED_PATCH: the patch key is
 *   version-pinned). If the new version fixes this upstream (Prisma 7 does), delete the patch
 *   and this step; otherwise port both.
 *
 * Usage:  node scripts/ci/assert-prisma-field-map-patch-applied.mjs [runtime.js ...]
 * Exit:   0 = every loaded runtime is patched · 1 = one is not, or nothing was read
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const PATCH_MARKER = 'civitaiFieldMap(';
const SPREAD_REDUCE_FIELD_MAP =
  /\.fields\.reduce\(\((\w+),(\w+)\)=>\(\{\.\.\.\1,\[\2\.name\]:\2\}\),\{\}\)/;
const RUNTIME_REQUIRE = /require\('@prisma\/client\/(runtime\/[\w.-]+)'\)/g;

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function loadedRuntimes() {
  const require = createRequire(import.meta.url);
  const clientRoot = dirname(require.resolve('@prisma/client/package.json'));
  const generated = require.resolve('.prisma/client/index.js', { paths: [clientRoot] });
  const paths = new Set(
    [...readFileSync(generated, 'utf8').matchAll(RUNTIME_REQUIRE)].map((m) => m[1])
  );
  if (paths.size === 0) fail(`${generated} requires no @prisma/client runtime; nothing was read.`);
  return [...paths].map((p) => join(clientRoot, p.endsWith('.js') ? p : `${p}.js`));
}

let files;
try {
  files = process.argv.length > 2 ? process.argv.slice(2) : loadedRuntimes();
} catch (error) {
  fail(`could not resolve the generated Prisma client; nothing was read. (${error.message})`);
}

for (const file of files) {
  if (!existsSync(file)) fail(`${file} does not exist; nothing was read.`);
  const source = readFileSync(file, 'utf8');
  const rebuild = SPREAD_REDUCE_FIELD_MAP.exec(source);
  if (rebuild || !source.includes(PATCH_MARKER)) {
    fail(
      `${file} is not patched: ${
        rebuild ? `it rebuilds the field map per call (${rebuild[0]})` : `no ${PATCH_MARKER} marker`
      }.\n` +
        'Re-run `pnpm install`. If Prisma was bumped or the generator now loads another runtime,\n' +
        'port patches/@prisma__client@6.13.0.patch to it, or delete patch and check if upstream fixed it.'
    );
  }
  console.log(`ok  ${file} is patched`);
}
