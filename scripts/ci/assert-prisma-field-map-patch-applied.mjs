#!/usr/bin/env node
/**
 * Blocking guard: the INSTALLED Prisma client does not rebuild a model's field map on every
 * single-record call.
 *
 * Prisma 6.x resolves `findUnique`/`findFirst`/`create`/`update`/`upsert`/`delete` (and the
 * `OrThrow` variants) through a helper that rebuilds a name->field map for the model with a
 * spread-reduce each time the method is looked up. That is O(fields^2) allocation per call:
 * on our widest model (User) it measured ~0.8 ms CPU and over 1 MB of garbage per query.
 * `patches/@prisma__client@6.13.0.patch` memoises the map. The unit test
 * `src/server/db/__tests__/prisma-field-map-memo.test.ts` is the behavioural guard, but the
 * unit job is `continue-on-error`, so this is the half that can fail a build.
 *
 * It reads node_modules rather than `patches/`, so a patch that exists but did not apply is
 * caught, and it is version-agnostic: it passes on any Prisma whose runtime has no
 * spread-reduce field map (patched, or fixed upstream as Prisma 7 does) and fails on one that
 * has it. A Prisma bump also fails `pnpm install` outright (ERR_PNPM_UNUSED_PATCH) because the
 * patch key is version-pinned; whoever hits either decides between re-porting the patch and
 * dropping it because upstream fixed it.
 *
 * Usage:  node scripts/ci/assert-prisma-field-map-patch-applied.mjs [path/to/runtime/library.js]
 * Exit:   0 = no per-call field-map rebuild · 1 = rebuild present, or nothing was read
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// The single-record method list the field-map helper is dispatched from. Its presence proves
// we read the runtime that contains the helper, so an absent rebuild is not a vacuous pass.
const SINGLE_RECORD_ACTIONS = '"findUnique","findUniqueOrThrow","findFirst"';
const SPREAD_REDUCE_FIELD_MAP =
  /\.fields\.reduce\(\((\w+),(\w+)\)=>\(\{\.\.\.\1,\[\2\.name\]:\2\}\),\{\}\)/;

function resolveRuntime() {
  if (process.argv[2]) return process.argv[2];
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve('@prisma/client/package.json')), 'runtime/library.js');
}

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

let file;
try {
  file = resolveRuntime();
} catch (error) {
  fail(
    `could not resolve the installed @prisma/client; this check measured nothing. (${error.message})`
  );
}
if (!existsSync(file)) fail(`${file} does not exist; this check measured nothing.`);

const source = readFileSync(file, 'utf8');
if (!source.includes(SINGLE_RECORD_ACTIONS)) {
  fail(
    `${file} has no single-record action list, so this is not the runtime the check was written ` +
      'for and it proved nothing. Re-read the Prisma runtime and update this script.'
  );
}

const rebuild = SPREAD_REDUCE_FIELD_MAP.exec(source);
if (rebuild) {
  fail(
    `${file} rebuilds the model field map with a spread-reduce (${rebuild[0]}) on every\n` +
      'single-record call. patches/@prisma__client@6.13.0.patch replaces it with a memoised\n' +
      'map; it is either not applied (re-run `pnpm install`) or Prisma was bumped and the patch\n' +
      'needs porting to the new runtime.'
  );
}

console.log(`ok  ${file} has no per-call spread-reduce field map`);
