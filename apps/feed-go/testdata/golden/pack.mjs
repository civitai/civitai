// Packs golden-fixture Redis values with msgpackr's module-level `pack`, the encoder the Node app's
// cache writes go through (packages/civitai-redis/src/client.ts: `import { pack } from 'msgpackr'`).
//
// A value is written in fixtures as JSON with two markers, so a fixture stays readable and diffable:
//   {"$date": "2026-06-15T11:55:00.000Z"}  -> a JS Date (msgpackr: timestamp extension -1)
//   {"$undefined": true}                   -> undefined (msgpackr: fixext1 type 0)
// The packed bytes are stored next to the value as base64 (`packed`); the Go harness reads only that.
//
//   node apps/feed-go/testdata/golden/pack.mjs <fixture.json>...   re-pack every `value` in place
//
// msgpackr must resolve from the repo's node_modules (run from a clone with `pnpm install` done), or
// set GOLDEN_NODE_MODULES to a node_modules directory that has it.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

/** Resolves a package from the repo (or GOLDEN_NODE_MODULES) and imports it. */
export async function importDep(name) {
  const paths = process.env.GOLDEN_NODE_MODULES ? [process.env.GOLDEN_NODE_MODULES] : undefined;
  let resolved;
  try {
    resolved = require.resolve(name, paths ? { paths } : undefined);
  } catch {
    if (!paths) throw new Error(`cannot resolve ${name}; set GOLDEN_NODE_MODULES`);
    resolved = require.resolve(join(paths[0], name));
  }
  return import(pathToFileURL(resolved).href);
}

const msgpackr = await importDep('msgpackr');
const pack = msgpackr.pack ?? msgpackr.default.pack;

/** JSON-with-markers -> the JS value Node would hold. */
export function revive(v) {
  if (Array.isArray(v)) return v.map(revive);
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === '$date') return new Date(v.$date);
    if (keys.length === 1 && keys[0] === '$undefined') return undefined;
    const out = {};
    for (const k of keys) out[k] = revive(v[k]);
    return out;
  }
  return v;
}

/** The JS value -> JSON-with-markers (the inverse of revive). */
export function mark(v) {
  if (v instanceof Date) return { $date: v.toISOString() };
  if (v === undefined) return { $undefined: true };
  if (Array.isArray(v)) return v.map(mark);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = mark(x);
    return out;
  }
  return v;
}

/** Packs a JSON-with-markers value as Node's cache writer does; base64. */
export function packMarked(value) {
  return Buffer.from(pack(revive(value))).toString('base64');
}

function repackFile(path) {
  const fixture = JSON.parse(readFileSync(path, 'utf8'));
  let n = 0;
  for (const entry of Object.values(fixture.redis ?? {})) {
    if (entry && 'value' in entry) {
      entry.packed = packMarked(entry.value);
      n++;
    }
  }
  writeFileSync(path, JSON.stringify(fixture, null, 2) + '\n');
  return n;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  for (const path of process.argv.slice(2)) console.log(`${path}: ${repackFile(path)} values packed`);
}
