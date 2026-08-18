#!/usr/bin/env node
/**
 * Compiled-branch gate.
 *
 * ---------------------------------------------------------------------------
 * What this exists to catch
 * ---------------------------------------------------------------------------
 * A bundler can emit a function whose body is not the body you wrote. Release 5.1.18
 * shipped `resolveStoreVisibilityScopeUninstrumented` as
 *
 *     async function S(e){if(await p(e))return"full"}
 *
 * — the `public-external` grant and the fail-closed `return 'none'` were absent, so the
 * function fell off the end and produced `undefined` for every non-privileged caller.
 * A `?? 'full'` default downstream turned that into a full-catalog grant to anonymous
 * callers; a `?? 'none'` default on the other read path turned the same missing value
 * into an empty store for the cohort that was supposed to see something. See
 * civitai#3983.
 *
 * That defect is STRUCTURALLY INVISIBLE to everything else we run. `tsc` type-checks the
 * source. ESLint reads the source. Vitest imports the source module. All three were green
 * — the TypeScript is correct. Only the emitted artefact was wrong, and nothing looked at
 * it. This gate looks at it.
 *
 * ---------------------------------------------------------------------------
 * How it measures — and why not by grepping the emitted JS
 * ---------------------------------------------------------------------------
 * Grepping the bundle for `return"public-external"` is the obvious approach and it is a
 * trap in at least three ways on this codebase:
 *
 *   1. Minified names are per-chunk, and one source module is inlined into ~200 chunks,
 *      so there is no stable symbol to anchor on.
 *   2. The literal `"public-external"` occurs ~481 times in the server build — every one
 *      of them an element of the closed-set array `["full","public-external","none"]`,
 *      never a return. A literal match says nothing about the position it matched in.
 *   3. The Flipt flag NAME `"app-listings-public-external"` CONTAINS the scope literal as
 *      a substring, so a naive grep finds ~238 more "hits" that are a different string.
 *
 * So the gate reads the source maps instead. Every emitted chunk ships a `.js.map` whose
 * `sources` names the source modules inlined into it and whose `mappings` says which
 * source LINE each emitted token came from. A watched line either has a mapping somewhere
 * in the server output or it does not — decoy-free, immune to renaming, and immune to the
 * minifier collapsing `if (a) return x; return y;` into `return a?x:y`, because the
 * collapsed token still maps back to both source lines.
 *
 * This needs server source maps, which this repo emits in production
 * (`productionBrowserSourceMaps: true` → Turbopack's `turbopackSourceMaps`, which covers
 * `.next/server/**`). Same dependency as `check-server-graph-singletons.mjs`.
 *
 * ---------------------------------------------------------------------------
 * Why every entry carries a positive control
 * ---------------------------------------------------------------------------
 * A reassuring "not found" is indistinguishable from a scan wired to nothing. If a module
 * simply was not emitted — renamed, moved, tree-shaken out of the server graph entirely —
 * then EVERY watched line is unmapped and the gate would report a pile of violations that
 * are really one missing input. So each entry names a control line in the same function
 * that must ALSO be mapped. Control unmapped ⇒ exit 2 ("could not observe"), never exit 1
 * ("violation"). A gate that cannot see must not report health OR breakage.
 *
 * Anchors are exact source substrings, resolved to line numbers at run time, so an entry
 * cannot silently rot when the file is reformatted or code moves. An anchor that matches
 * zero or multiple lines is itself a hard error — an ambiguous anchor would otherwise
 * check whichever line it happened to land on.
 *
 * Usage:  node scripts/assert-compiled-branches.mjs [--next-dir .next] [--json]
 * Exit:   0 = pass · 1 = a watched branch is absent from the output · 2 = the gate could
 *         not run (no build, no source maps, unresolvable anchor, unobservable control)
 */
import { existsSync, readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { COMPILED_BRANCH_WATCHLIST } from './compiled-branch-watchlist.mjs';

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}
const NEXT_DIR = argValue('--next-dir', process.env.NEXT_DIR || '.next');
const REPO_ROOT = argValue('--repo-root', process.cwd());
// Test-only seam. The suite needs to drive the "anchor matches no line" and "anchor is
// ambiguous" branches, which the real watchlist must never contain — so it supplies its
// own list instead of the gate growing a deliberately-broken entry to test against.
const WATCHLIST_PATH = argValue('--watchlist', '');
// Downgrade a VIOLATION (exit 1) to a loud report (exit 0). Deliberately does NOT
// downgrade exit 2 — "the gate could not run" must still fail the build, or a gate that
// silently stopped looking would read exactly like a gate that found nothing.
const WARN_ONLY = args.includes('--warn-only');
const SERVER_DIR = join(NEXT_DIR, 'server');
const AS_JSON = args.includes('--json');

function die(code, message) {
  console.error(`compiled-branches: ${message}`);
  process.exit(code);
}

if (!existsSync(SERVER_DIR)) {
  die(2, `no server output at ${SERVER_DIR} — was \`next build\` run first?`);
}

// ---------------------------------------------------------------------------
// Base64 VLQ, the source-map segment encoding. Inlined rather than pulled from a
// dependency: this runs inside the Docker build stage, where adding a runtime dep to the
// gate means adding it to the image.
// ---------------------------------------------------------------------------
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const CHARS = new Map([...B64].map((c, i) => [c, i]));

function decodeVLQ(segment) {
  const out = [];
  let shift = 0;
  let value = 0;
  for (const ch of segment) {
    const digit = CHARS.get(ch);
    if (digit === undefined) throw new Error(`invalid base64-VLQ character ${JSON.stringify(ch)}`);
    const hasContinuation = digit & 32;
    value += (digit & 31) << shift;
    if (hasContinuation) {
      shift += 5;
      continue;
    }
    const negative = value & 1;
    value >>= 1;
    out.push(negative ? (value === 0 ? -0x80000000 : -value) : value);
    value = 0;
    shift = 0;
  }
  return out;
}

/**
 * Union of source lines that have at least one mapping, per source module, across every
 * emitted chunk. Only the modules we watch are retained — the full set is ~4,600 modules
 * and holding all of them costs memory for nothing.
 */
function collectMappedLines(mapJson, wantedModules) {
  const hits = new Map();
  const sourceIndexToModule = (mapJson.sources ?? []).map((raw) => {
    const normalised = String(raw).replace(/\\/g, '/');
    for (const m of wantedModules) if (normalised.includes(m)) return m;
    return null;
  });
  if (!sourceIndexToModule.some(Boolean)) return hits;

  let sourceIndex = 0;
  let sourceLine = 0;
  for (const group of String(mapJson.mappings ?? '').split(';')) {
    if (!group) continue;
    for (const segment of group.split(',')) {
      if (!segment) continue;
      const fields = decodeVLQ(segment);
      if (fields.length < 4) continue; // generated-column-only segment: no source position
      sourceIndex += fields[1];
      sourceLine += fields[2];
      const mod = sourceIndexToModule[sourceIndex];
      if (!mod) continue;
      let set = hits.get(mod);
      if (!set) hits.set(mod, (set = new Set()));
      set.add(sourceLine + 1); // source maps are 0-based; humans and editors are 1-based
    }
  }
  return hits;
}

/**
 * Resolve an anchor (an exact source substring) to the 1-based line it occurs on.
 * Zero matches or more than one match is a hard error: an ambiguous anchor silently
 * checks a line the author did not mean.
 */
function resolveAnchor(sourceText, code) {
  const lines = sourceText.split('\n');
  const found = [];
  lines.forEach((line, i) => {
    if (line.includes(code)) found.push(i + 1);
  });
  if (found.length === 0) return { error: 'no line contains this anchor' };
  if (found.length > 1) return { error: `anchor is ambiguous — matches lines ${found.join(', ')}` };
  return { line: found[0] };
}

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.name.endsWith('.js.map')) out.push(full);
  }
  return out;
}

async function main() {
  let watched = COMPILED_BRANCH_WATCHLIST;
  if (WATCHLIST_PATH) {
    const mod = await import(new URL(`file://${WATCHLIST_PATH}`).href);
    watched = mod.COMPILED_BRANCH_WATCHLIST;
    if (!Array.isArray(watched)) die(2, `--watchlist ${WATCHLIST_PATH} exports no COMPILED_BRANCH_WATCHLIST array`);
  }
  if (!watched.length) die(2, 'the watchlist is empty — this gate would examine nothing');

  // ---- resolve every anchor against source BEFORE reading any map ----
  const entries = [];
  for (const entry of watched) {
    const abs = join(REPO_ROOT, entry.module);
    if (!existsSync(abs)) die(2, `[${entry.id}] source module not found: ${entry.module}`);
    const text = readFileSync(abs, 'utf8');
    const resolve = (a, kind) => {
      const r = resolveAnchor(text, a.code);
      if (r.error) die(2, `[${entry.id}] ${kind} anchor ${JSON.stringify(a.code)}: ${r.error}`);
      return { ...a, line: r.line };
    };
    if (!entry.control?.length) die(2, `[${entry.id}] has no control anchor — see the header`);
    if (!entry.required?.length) die(2, `[${entry.id}] has no required anchors`);
    entries.push({
      ...entry,
      control: entry.control.map((a) => resolve(a, 'control')),
      required: entry.required.map((a) => resolve(a, 'required')),
    });
  }

  const wantedModules = [...new Set(entries.map((e) => e.module))];

  // ---- scan the emitted maps ----
  const mapFiles = await walk(SERVER_DIR);
  if (mapFiles.length === 0) {
    die(
      2,
      `found no .js.map under ${SERVER_DIR}. This gate reads source maps; a build without ` +
        `them cannot be checked, and a scan that can see nothing must not report health.`
    );
  }

  const mapped = new Map(wantedModules.map((m) => [m, new Set()]));
  const chunkCount = new Map(wantedModules.map((m) => [m, 0]));
  let unreadable = 0;
  for (const file of mapFiles) {
    let json;
    try {
      json = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      unreadable++;
      continue;
    }
    const hits = collectMappedLines(json, wantedModules);
    for (const [mod, lines] of hits) {
      chunkCount.set(mod, chunkCount.get(mod) + 1);
      const set = mapped.get(mod);
      for (const l of lines) set.add(l);
    }
  }

  // ---- verdict ----
  const violations = [];
  const report = [];
  for (const entry of entries) {
    const lines = mapped.get(entry.module);
    const chunks = chunkCount.get(entry.module);

    const deadControls = entry.control.filter((a) => !lines.has(a.line));
    if (deadControls.length) {
      die(
        2,
        `[${entry.id}] CANNOT OBSERVE. ${entry.module} was found in ${chunks} emitted chunk(s), ` +
          `but its control anchor is not represented in any of them:\n` +
          deadControls.map((a) => `    line ${a.line}: ${a.code}`).join('\n') +
          `\n  The control is the branch that is known to survive. If it is missing, this gate ` +
          `is looking at a build that did not emit this function — a stale .next, a moved file, ` +
          `or a module dropped from the server graph — not at a violation. Fix the input, or ` +
          `update the watchlist entry if the code genuinely moved.`
      );
    }

    const missing = entry.required.filter((a) => !lines.has(a.line));
    report.push({
      id: entry.id,
      module: entry.module,
      chunks,
      required: entry.required.length,
      missing: missing.map((a) => ({ line: a.line, code: a.code, why: a.why })),
    });
    if (missing.length) violations.push({ entry, missing });
  }

  if (AS_JSON) {
    console.log(JSON.stringify({ ok: violations.length === 0, chunksScanned: mapFiles.length, report }, null, 2));
  } else {
    console.log(`compiled-branches: scanned ${mapFiles.length} source maps under ${SERVER_DIR}`);
    if (unreadable) console.log(`compiled-branches: ${unreadable} map(s) unreadable (skipped)`);
    for (const r of report) {
      const verdict = r.missing.length ? `✗ ${r.missing.length}/${r.required} MISSING` : `✓ ${r.required}/${r.required}`;
      console.log(`  ${verdict}  ${r.id}  (${r.module}, emitted into ${r.chunks} chunk(s))`);
    }
  }

  if (violations.length) {
    console.error('');
    console.error('compiled-branches: A SECURITY-RELEVANT BRANCH IS ABSENT FROM THE COMPILED OUTPUT.');
    console.error('');
    for (const { entry, missing } of violations) {
      console.error(`  ${entry.id} — ${entry.module}`);
      console.error(`    ${entry.why}`);
      for (const a of missing) {
        console.error(`    MISSING  line ${a.line}: ${a.code}`);
        console.error(`             ${a.why}`);
      }
      console.error('');
    }
    console.error(
      'The TypeScript for these branches is correct — that is the point. No source-level test\n' +
        'can see this, because every one of them exercises the TypeScript. The emitted server\n' +
        'chunk does not contain the branch, so at runtime it does not happen.\n' +
        '\n' +
        'Do NOT silence this by editing the watchlist. Read the emitted chunk, confirm what the\n' +
        'function actually became, and treat it as a build defect (civitai#3983 is the worked\n' +
        'example). Only remove an entry when the code it names is genuinely gone.'
    );
    if (WARN_ONLY) {
      console.error('');
      console.error(
        'compiled-branches: --warn-only is set, so this is NOT failing the build. That flag exists\n' +
          'for exactly one situation — a KNOWN, tracked, currently-unfixed bundler defect that would\n' +
          'otherwise make every production build red. Remove it the moment the branch above is back\n' +
          'in the output; a gate that is permanently red and permanently ignored is worse than none.'
      );
      process.exit(0);
    }
    process.exit(1);
  }

  console.log(`compiled-branches: OK — every watched branch is represented in the emitted output`);
  process.exit(0);
}

main().catch((err) => die(2, `unexpected failure: ${err?.stack || err}`));
