#!/usr/bin/env node
/**
 * Server-graph module-identity gate.
 *
 * ---------------------------------------------------------------------------
 * What this exists to catch
 * ---------------------------------------------------------------------------
 * A module's top-level bindings are per RUNTIME MODULE, and the bundler decides how many
 * runtime modules a source file becomes. Turbopack merges source modules into larger
 * runtime modules, so one `.ts` file is routinely INLINED into many of them: on a
 * production build of this repo `src/server/logging/client.ts` is emitted 14 times.
 *
 * Anything that has to be a process-wide singleton therefore cannot live in a
 * module-scope `const`. It has to be reached through `globalThis`, which is the only
 * thing every copy shares.
 *
 * This failure is STRUCTURALLY INVISIBLE to every other gate we run. `tsc` type-checks
 * one source file, not N emitted copies of it. ESLint reads source. Vitest loads each
 * module exactly once, so a module-scope singleton looks like a singleton. Only the
 * bundler knows, and it does not complain — it just quietly hands each copy its own
 * object. That is how the OTel logs bridge shipped delivering 1.3% of records with a
 * green typecheck, a green lint and a green suite: `setStructuredLogSink()` armed one of
 * 14 sink objects, and nothing anywhere could see it.
 *
 * ---------------------------------------------------------------------------
 * How it measures
 * ---------------------------------------------------------------------------
 * Turbopack's production output uses opaque NUMERIC module ids, so the emitted JS cannot
 * be attributed to a source file by reading it. The source maps can: each emitted chunk
 * ships a `.js.map` whose `sources` array names every source module inlined into it. A
 * source file that appears in N chunks' `sources` is N runtime modules.
 *
 * This needs server source maps, which this repo emits in production
 * (`productionBrowserSourceMaps: true` → Turbopack's `turbopackSourceMaps`, which covers
 * `.next/server/**` too). If no maps are found the gate EXITS NON-ZERO rather than
 * passing: a scan that cannot see anything must never be reported as "nothing wrong".
 *
 * ---------------------------------------------------------------------------
 * Rules
 * ---------------------------------------------------------------------------
 *  SHARED_STATE — the module may be emitted any number of times, but every emitted copy
 *                 must reference the named `globalThis` key. A copy without it owns
 *                 private state that the registration path can never reach.
 *
 *  SINGLETON    — the module must be emitted EXACTLY once. Its module scope is
 *                 deliberately graph-local (a memoized handle, a set of counters), so a
 *                 second copy is a second, silently-unregistered instance.
 *
 * Usage:  node scripts/check-server-graph-singletons.mjs [--next-dir .next] [--json]
 * Exit:   0 = pass · 1 = violation · 2 = the gate could not run (env/usage)
 */
import { readFileSync, existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

// The watchlist lives in its own module so the gate and its test suite share ONE list —
// see the header of ./server-graph-watchlist.mjs for why that matters.
import { WATCHLIST } from './server-graph-watchlist.mjs';

// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}
const NEXT_DIR = argValue('--next-dir', process.env.NEXT_DIR || '.next');
const SERVER_DIR = join(NEXT_DIR, 'server');
const AS_JSON = args.includes('--json');

function die(code, message) {
  console.error(`server-graph-singletons: ${message}`);
  process.exit(code);
}

if (!existsSync(SERVER_DIR)) {
  die(2, `no server output at ${SERVER_DIR} — was \`next build\` run first?`);
}

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = await walk(SERVER_DIR);
const mapFiles = files.filter((f) => f.endsWith('.js.map'));

if (mapFiles.length === 0) {
  // A zero here is indistinguishable from "everything is fine" unless we refuse it.
  die(
    2,
    `found 0 source maps under ${SERVER_DIR}. This gate reads \`.js.map\` \`sources\` to attribute emitted code to source modules; without them it can see nothing. Server maps come from \`productionBrowserSourceMaps: true\` in next.config.mjs (Turbopack maps both client and server chunks from that flag).`
  );
}

// chunk (relative .js path) -> Set(source modules inlined into it)
const chunkSources = new Map();
// The same key -> the absolute .js path, so reading a chunk never goes back through
// the key. The key is a NAME: it is what every violation above prints, so it carries
// posix separators on all platforms rather than whatever the host filesystem uses.
const chunkFiles = new Map();
for (const m of mapFiles) {
  let sources;
  try {
    sources = JSON.parse(readFileSync(m, 'utf8')).sources;
  } catch {
    continue; // an unparseable map is not evidence of a violation
  }
  if (!Array.isArray(sources)) continue;
  const abs = m.replace(/\.map$/, '');
  const rel = relative(SERVER_DIR, abs).replace(/\\/g, '/');
  chunkSources.set(rel, sources);
  chunkFiles.set(rel, abs);
}

const readChunk = (rel) => {
  try {
    return readFileSync(chunkFiles.get(rel) ?? join(SERVER_DIR, rel), 'utf8');
  } catch {
    return '';
  }
};

// ---------------------------------------------------------------------------
const results = [];
let failed = 0;

for (const entry of WATCHLIST) {
  const copies = [];
  for (const [chunk, sources] of chunkSources) {
    if (sources.some((s) => typeof s === 'string' && s.endsWith(entry.module))) copies.push(chunk);
  }

  const result = { ...entry, copies: copies.length, violations: [] };

  // POSITIVE CONTROL, always. A watchlist entry that matches nothing means the path was
  // renamed/deleted or the scan is looking in the wrong place — either way the rule below
  // would "pass" without having examined anything, which is the failure mode this whole
  // gate exists to prevent. Refuse it.
  if (copies.length === 0) {
    result.violations.push(
      `matched 0 emitted chunks — this rule examined NOTHING. Either \`${entry.module}\` no longer exists / is no longer reachable from the server build, or its path in this watchlist is stale. Fix the path or drop the entry; do not leave a rule that cannot observe its subject.`
    );
  } else if (entry.rule === 'SINGLETON') {
    if (copies.length > 1) {
      result.violations.push(
        `emitted ${copies.length} times, expected exactly 1. ${entry.why}\n    copies: ${copies
          .slice(0, 10)
          .join(', ')}${copies.length > 10 ? `, +${copies.length - 10} more` : ''}`
      );
    }
  } else if (entry.rule === 'SHARED_STATE') {
    const unpinned = copies.filter((c) => !readChunk(c).includes(entry.globalKey));
    result.pinned = copies.length - unpinned.length;
    if (unpinned.length > 0) {
      result.violations.push(
        `${unpinned.length} of ${copies.length} emitted copies do NOT reference \`globalThis.${
          entry.globalKey
        }\`, so each of those holds PRIVATE module-scope state. ${
          entry.why
        }\n    unpinned copies: ${unpinned.slice(0, 10).join(', ')}${
          unpinned.length > 10 ? `, +${unpinned.length - 10} more` : ''
        }`
      );
    }
  } else {
    result.violations.push(`unknown rule \`${entry.rule}\` — the gate cannot evaluate it.`);
  }

  if (result.violations.length) failed++;
  results.push(result);
}

// ---------------------------------------------------------------------------
if (AS_JSON) {
  console.log(JSON.stringify({ serverDir: SERVER_DIR, maps: mapFiles.length, results }, null, 2));
} else {
  console.log('===== server-graph module identity =====');
  console.log(
    `scanned ${chunkSources.size} emitted chunks (${mapFiles.length} source maps) under ${SERVER_DIR}`
  );
  console.log('');
  for (const r of results) {
    const detail =
      r.rule === 'SHARED_STATE'
        ? `${r.copies} emitted cop${r.copies === 1 ? 'y' : 'ies'}, ${
            r.pinned ?? 0
          } referencing globalThis.${r.globalKey}`
        : `${r.copies} emitted cop${r.copies === 1 ? 'y' : 'ies'}`;
    console.log(`  ${r.violations.length ? 'FAIL' : ' OK '}  ${r.rule.padEnd(12)} ${r.module}`);
    console.log(`        ${detail}`);
    for (const v of r.violations) console.log(`        ✗ ${v}`);
  }
  console.log('');
}

if (failed) {
  console.error(`server-graph-singletons: ${failed} violation(s) — FAIL`);
  process.exit(1);
}
console.log('server-graph-singletons: PASS');
process.exit(0);
