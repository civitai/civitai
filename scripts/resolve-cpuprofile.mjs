#!/usr/bin/env node
// @ts-check
//
// resolve-cpuprofile.mjs — de-minify V8 .cpuprofile stacks using server source maps.
//
// WHY: prod pods emit V8 `.cpuprofile`s to find what blocks the event loop, but the
// standalone build's server chunks are minified, so frames read like
// `p @ chunks/_0eaaij7._.js:4398:12` — unnameable. This tool loads the matching
// `.js.map` files and rewrites each frame's `(url, lineNumber, columnNumber)` back to
// its original `source.ts:line:col` + original function name via `source-map`.
//
// Server source maps are NOT shipped in the runtime image (they added ~761 MB per
// prod pod). They are published per build as a separate, fetched-on-demand artifact
// image `ghcr.io/civitai/civitai-web-maps:<tag>` keyed by the SAME tag as the runtime
// image. This tool can fetch that artifact for a given tag (`--image`) and resolve
// against it, OR resolve against a local maps dir (`--maps`).
//
// USAGE:
//   # Fetch the maps for the build that produced the profile, then resolve:
//   node scripts/resolve-cpuprofile.mjs <profile.cpuprofile> --image <tag-or-ref> [options]
//   # Or resolve against a local directory of .js.map files:
//   node scripts/resolve-cpuprofile.mjs <profile.cpuprofile> --maps <dir-of-js.map> [options]
//
// OPTIONS:
//   --image <ref>       Fetch this build's server maps from the maps artifact image,
//                       then resolve. <ref> may be a bare tag (e.g. v5.0.1806-datapacket
//                       or 20260610123456-abc1234) — expanded against --maps-repo
//                       (default ghcr.io/civitai/civitai-web-maps) — or a full
//                       repo:tag reference. Requires `crane` (or `oras`) on PATH and
//                       registry read auth (e.g. `crane auth login ghcr.io`, or a
//                       docker config already logged in). Mutually exclusive with --maps.
//   --image-sha <sha>   Like --image, but you pass only the commit sha. The runtime
//                       image tag (<ts1>-<sha>) and the maps tag (<ts2>-<sha>) share
//                       the sha but not the build timestamp, so a runtime tag would
//                       404 as a maps tag. This lists --maps-repo via `crane ls` and
//                       picks the newest tag ending in `-<sha>`. If both --image and
//                       --image-sha are given, --image-sha wins. Mutually exclusive
//                       with --maps.
//   --maps-repo <repo>  Override the maps artifact repo used to expand a bare --image
//                       tag (default ghcr.io/civitai/civitai-web-maps).
//   --maps <dir>        Directory to search recursively for `<chunk>.js.map` files
//                       (offline/local mode; e.g. an already-extracted maps tree).
//   --top <n>           Show the N hottest self-time functions (default 25).
//   --block             Run the "longest synchronous block" analysis (see below) and
//                       print its stack, de-minified.
//   --json              Emit the full resolved profile as JSON instead of a report.
//   --no-resolve        Skip map resolution (raw frames) — useful to diff before/after.
//
// Exactly one of --image / --image-sha or --maps is required (unless --no-resolve).
//
// "Longest synchronous block": V8 sampling profiles record per-sample deltas
// (`timeDeltas`). A run of consecutive samples that stay inside the same top-of-stack
// leaf (no return to the scheduler) approximates an uninterrupted synchronous block.
// We find the single longest such run and print its (de-minified) leaf stack — the
// likely event-loop culprit.
//
// V8 coordinate convention: callFrame.lineNumber / columnNumber are 0-based.
// `source-map` originalPositionFor wants { line: 1-based, column: 0-based }.

import { readFile, readdir, stat, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_MAPS_REPO = 'ghcr.io/civitai/civitai-web-maps';

// `source-map` is a direct dependency (package.json). Imported lazily so --no-resolve
// and --help work even if it's somehow absent.
async function loadSourceMapModule() {
  try {
    return await import('source-map');
  } catch {
    console.error(
      "error: the 'source-map' package is required for resolution.\n" +
        '       run `pnpm add -D source-map` (it is already a dependency of this repo),\n' +
        '       or pass --no-resolve to print raw frames.'
    );
    process.exit(1);
  }
}

function parseArgs(argv) {
  const args = {
    profile: /** @type {string | null} */ (null),
    mapsDir: /** @type {string | null} */ (null),
    image: /** @type {string | null} */ (null),
    imageSha: /** @type {string | null} */ (null),
    mapsRepo: DEFAULT_MAPS_REPO,
    top: 25,
    block: false,
    json: false,
    resolve: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--maps') args.mapsDir = argv[++i];
    else if (a === '--image') args.image = argv[++i];
    else if (a === '--image-sha') args.imageSha = argv[++i];
    else if (a === '--maps-repo') args.mapsRepo = argv[++i];
    else if (a === '--top') args.top = Number(argv[++i]);
    else if (a === '--block') args.block = true;
    else if (a === '--json') args.json = true;
    else if (a === '--no-resolve') args.resolve = false;
    else if (a === '-h' || a === '--help') {
      printHelp();
      process.exit(0);
    } else if (!a.startsWith('-') && !args.profile) args.profile = a;
    else {
      console.error(`error: unexpected argument: ${a}`);
      process.exit(1);
    }
  }
  return args;
}

function printHelp() {
  console.log(
    'Usage: node scripts/resolve-cpuprofile.mjs <profile.cpuprofile> (--image <tag-or-ref> | --image-sha <sha> | --maps <dir>)\n' +
      '         [--maps-repo <repo>] [--top N] [--block] [--json] [--no-resolve]'
  );
}

// Resolve a bare tag to a full maps-image reference. A value that already contains
// a '/' (a repo path) or starts with a registry host is treated as a full ref; a
// bare tag is expanded against mapsRepo.
function resolveImageRef(image, mapsRepo) {
  if (image.includes('/')) return image; // already repo[:tag] or registry/repo:tag
  // bare tag (possibly with a leading ':' someone added) -> repo:tag
  const tag = image.startsWith(':') ? image.slice(1) : image;
  return `${mapsRepo}:${tag}`;
}

// Resolve a bare commit sha to a full maps-image reference by listing the maps repo
// and picking the newest tag ending in `-<sha>`. The runtime image tag and the maps
// tag share the sha but carry different build timestamps (`<ts>-<sha>`), so a caller
// who only knows the runtime sha can't name the maps tag directly. Requires `crane`
// on PATH and registry read auth.
//
// Tag selection: build tags are `<timestamp>-<sha>`, but a floating `sha-<sha>` alias
// may also match `-<sha>`. Prefer the newest *timestamped* tag (largest numeric
// prefix = newest build); fall back to the lexically-largest match only when no
// timestamped tag is present. Pure/side-effect-free so it can be unit-tested.
function pickTagBySha(tags, sha) {
  const matches = tags.map((t) => t.trim()).filter((t) => t && t.endsWith(`-${sha}`));
  if (!matches.length) return null;
  const timestamped = matches
    .filter((t) => /^\d+-/.test(t))
    .sort((a, b) => Number(a.split('-')[0]) - Number(b.split('-')[0]));
  if (timestamped.length) return timestamped[timestamped.length - 1];
  return matches.sort()[matches.length - 1];
}

function resolveTagBySha(sha, mapsRepo) {
  const r = spawnSync('crane', ['ls', mapsRepo], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(
      `crane ls ${mapsRepo} failed (exit ${r.status}): ${(r.stderr || '').trim()}. ` +
        'Ensure `crane` is on PATH and registry read auth is configured.'
    );
  }
  const tag = pickTagBySha(r.stdout.split('\n'), sha);
  if (!tag) throw new Error(`no maps tag ending in -${sha} found in ${mapsRepo}`);
  return `${mapsRepo}:${tag}`;
}

// Fetch the server maps for a build into a fresh temp dir and return that dir.
// Prefers `crane export` (single static binary, already cached in the Tekton build
// node); falls back to `oras pull`. The maps artifact stores files under
// /server-maps mirroring .next/server, so we return <tmp>/server-maps if present
// (else <tmp>, so a differently-rooted artifact still resolves).
//
// Auth: relies on ambient registry auth — a docker config already logged in to the
// registry (DOCKER_CONFIG / ~/.docker/config.json) or `crane auth login ghcr.io`.
// No credentials are embedded here.
async function fetchMapsImage(ref) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'cpuprofile-maps-'));
  const haveCrane = spawnSync('crane', ['version'], { stdio: 'ignore' }).status === 0;
  const haveOras = !haveCrane && spawnSync('oras', ['version'], { stdio: 'ignore' }).status === 0;

  if (!haveCrane && !haveOras) {
    await rm(tmp, { recursive: true, force: true });
    throw new Error(
      "neither 'crane' nor 'oras' found on PATH. Install one " +
        '(e.g. `go install github.com/google/go-containerregistry/cmd/crane@latest`) ' +
        'or download a release binary, then ensure registry read auth is configured.'
    );
  }

  console.error(`info: fetching maps artifact ${ref} via ${haveCrane ? 'crane' : 'oras'} ...`);
  let res;
  if (haveCrane) {
    // `crane export` streams the image filesystem as a tar; pipe it into tar -x.
    // Using a shell pipeline keeps memory flat for large map sets.
    res = spawnSync('sh', ['-c', `crane export "${ref}" - | tar -x -C "${tmp}"`], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
  } else {
    res = spawnSync('oras', ['pull', ref, '-o', tmp], { stdio: ['ignore', 'inherit', 'inherit'] });
  }
  if (res.status !== 0) {
    await rm(tmp, { recursive: true, force: true });
    throw new Error(
      `failed to fetch maps artifact ${ref} (exit ${res.status}). ` +
        'Check the tag exists in the maps repo and that registry read auth is configured.'
    );
  }

  const nested = path.join(tmp, 'server-maps');
  const dir = existsSync(nested) ? nested : tmp;
  return { dir, cleanup: () => rm(tmp, { recursive: true, force: true }) };
}

// Recursively index every *.js.map under dir, keyed by the basename of the
// chunk it maps (i.e. `<chunk>.js`). Turbopack/webpack name maps `<chunk>.js.map`.
async function indexMaps(dir) {
  /** @type {Map<string, string>} */
  const byChunkBasename = new Map();
  /** @type {Map<string, string>} */
  const byMapBasename = new Map();

  /** @param {string} d */
  async function walk(d) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile() && e.name.endsWith('.js.map')) {
        const mapBase = e.name; // e.g. _0eaaij7._.js.map
        const chunkBase = e.name.slice(0, -'.map'.length); // e.g. _0eaaij7._.js
        // First write wins; collisions across dirs are rare for hashed chunk names.
        if (!byChunkBasename.has(chunkBase)) byChunkBasename.set(chunkBase, full);
        if (!byMapBasename.has(mapBase)) byMapBasename.set(mapBase, full);
      }
    }
  }
  await walk(dir);
  return { byChunkBasename, byMapBasename };
}

// Extract the chunk basename from a frame url. Frame urls in the wild look like:
//   /app/.next/server/chunks/_0eaaij7._.js
//   file:///app/.next/server/chunks/27592.js
//   chunks/src_17njnbr._.js
//   27592.js
// We reduce to the trailing `<name>.js` basename and look that up in the map index.
function chunkBasenameFromUrl(url) {
  if (!url) return null;
  // strip query/hash and protocol
  let u = url.replace(/[?#].*$/, '');
  if (u.startsWith('file://')) u = u.slice('file://'.length);
  const base = u.split('/').pop() || '';
  if (!base.endsWith('.js')) return null;
  // ignore node internals / non-chunk urls
  if (u.startsWith('node:') || base === 'server.js') return null;
  return base;
}

/**
 * Build per-map SourceMapConsumer lazily and cache it. Returns a resolver fn that,
 * given (chunkBasename, line0, col0), returns the original frame or null.
 */
function makeResolver(SourceMapConsumer, mapIndex) {
  /** @type {Map<string, Promise<import('source-map').BasicSourceMapConsumer | null>>} */
  const consumerCache = new Map();

  /** @param {string} chunkBase */
  function getConsumer(chunkBase) {
    if (consumerCache.has(chunkBase)) return consumerCache.get(chunkBase);
    const p = (async () => {
      const mapPath = mapIndex.byChunkBasename.get(chunkBase);
      if (!mapPath) return null;
      try {
        const raw = await readFile(mapPath, 'utf8');
        const json = JSON.parse(raw);
        return await new SourceMapConsumer(json);
      } catch (err) {
        console.error(`warn: failed to load map for ${chunkBase}: ${err.message}`);
        return null;
      }
    })();
    consumerCache.set(chunkBase, p);
    return p;
  }

  /**
   * @param {string} chunkBase
   * @param {number} line0  0-based line (V8)
   * @param {number} col0   0-based column (V8)
   */
  async function resolve(chunkBase, line0, col0) {
    const consumer = await getConsumer(chunkBase);
    if (!consumer) return null;
    const pos = consumer.originalPositionFor({
      line: (line0 ?? 0) + 1, // source-map is 1-based for lines
      column: col0 ?? 0, // 0-based for columns (matches V8)
      bias: SourceMapConsumer.LEAST_UPPER_BOUND,
    });
    if (pos.source == null && pos.line == null) return null;
    return { source: pos.source, line: pos.line, column: pos.column, name: pos.name };
  }

  function destroy() {
    for (const p of consumerCache.values()) {
      Promise.resolve(p).then((c) => c && c.destroy && c.destroy());
    }
  }

  return { resolve, destroy };
}

function formatFrame(original, callFrame) {
  const rawFn = callFrame.functionName || '(anonymous)';
  if (original) {
    const fn = original.name || rawFn;
    const loc = original.source
      ? `${original.source}:${original.line ?? '?'}:${original.column ?? '?'}`
      : '(unknown source)';
    return `${fn} @ ${loc}`;
  }
  const url = callFrame.url || '';
  const base = url ? url.split('/').pop() : '(native)';
  return `${rawFn} @ ${base}:${callFrame.lineNumber ?? '?'}:${callFrame.columnNumber ?? '?'} [unresolved]`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.profile) {
    printHelp();
    process.exit(1);
  }
  if ((args.image || args.imageSha) && args.mapsDir) {
    console.error('error: pass only one of --image / --image-sha or --maps, not both.');
    process.exit(1);
  }
  if (args.resolve && !args.mapsDir && !args.image && !args.imageSha) {
    console.error(
      'error: --image <tag-or-ref>, --image-sha <sha>, or --maps <dir> is required (or pass --no-resolve).'
    );
    process.exit(1);
  }
  if (args.mapsDir && !existsSync(args.mapsDir)) {
    console.error(`error: maps dir not found: ${args.mapsDir}`);
    process.exit(1);
  }

  const profileRaw = await readFile(args.profile, 'utf8');
  /** @type {{ nodes: any[], samples: number[], timeDeltas: number[] }} */
  const profile = JSON.parse(profileRaw);
  if (!Array.isArray(profile.nodes)) {
    console.error('error: not a V8 .cpuprofile (missing `nodes` array).');
    process.exit(1);
  }

  // If --image was given, fetch that build's maps artifact into a temp dir and
  // resolve against it (cleaned up before we return).
  let mapsDir = args.mapsDir;
  let fetchCleanup = null;
  if (args.resolve && (args.image || args.imageSha)) {
    // --image-sha wins if both are passed: it auto-resolves the maps tag from the
    // commit sha, whereas --image expects an exact tag/ref.
    const ref = args.imageSha
      ? resolveTagBySha(args.imageSha, args.mapsRepo)
      : resolveImageRef(args.image, args.mapsRepo);
    if (args.imageSha) console.error(`info: resolved --image-sha ${args.imageSha} -> ${ref}`);
    const fetched = await fetchMapsImage(ref);
    mapsDir = fetched.dir;
    fetchCleanup = fetched.cleanup;
  }

  let resolver = null;
  // try/finally so a fetched maps temp dir (can be ~hundreds of MB) is always
  // cleaned up, even if resolution throws partway through.
  try {
  if (args.resolve) {
    const sm = await loadSourceMapModule();
    const mapIndex = await indexMaps(mapsDir);
    if (mapIndex.byChunkBasename.size === 0) {
      console.error(`warn: no .js.map files found under ${mapsDir} — frames will be unresolved.`);
    } else {
      console.error(`info: indexed ${mapIndex.byChunkBasename.size} source maps under ${mapsDir}`);
    }
    resolver = makeResolver(sm.SourceMapConsumer, mapIndex);
  }

  // Resolve every node's callFrame once, cache by node id.
  /** @type {Map<number, { callFrame: any, original: any, label: string }>} */
  const nodeInfo = new Map();
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));

  for (const node of profile.nodes) {
    const cf = node.callFrame || {};
    let original = null;
    if (resolver) {
      const chunkBase = chunkBasenameFromUrl(cf.url);
      if (chunkBase) {
        original = await resolver.resolve(chunkBase, cf.lineNumber, cf.columnNumber);
      }
    }
    nodeInfo.set(node.id, { callFrame: cf, original, label: formatFrame(original, cf) });
  }

  // --- self-time accounting (hottest leaves) ---
  // Each sample attributes its timeDelta to the sampled (leaf) node's self time.
  /** @type {Map<number, number>} */
  const selfTime = new Map();
  const samples = profile.samples || [];
  const deltas = profile.timeDeltas || [];
  for (let i = 0; i < samples.length; i++) {
    const id = samples[i];
    const dt = deltas[i] ?? 0;
    selfTime.set(id, (selfTime.get(id) || 0) + dt);
  }

  if (args.json) {
    const out = profile.nodes.map((n) => {
      const info = nodeInfo.get(n.id);
      const o = info.original;
      return {
        id: n.id,
        // Resolved location. `original` is { source, line, column, name } with no
        // `url` key, so add a `url` alias (== source) for consumers that key on
        // `.url`, plus a ready-made "fn @ source:line:col" label.
        original: o ? { ...o, url: o.source ?? null } : null,
        label: info.label,
        callFrame: n.callFrame,
        selfTimeMicros: selfTime.get(n.id) || 0,
      };
    });
    process.stdout.write(JSON.stringify({ nodes: out }, null, 2) + '\n');
    if (resolver) resolver.destroy();
    if (fetchCleanup) await fetchCleanup();
    return;
  }

  // ancestry map (child id -> parent id) for printing stacks
  /** @type {Map<number, number>} */
  const parentOf = new Map();
  for (const node of profile.nodes) {
    for (const child of node.children || []) parentOf.set(child, node.id);
  }
  /** @param {number} id */
  function stackOf(id) {
    const out = [];
    let cur = id;
    const seen = new Set();
    while (cur != null && !seen.has(cur)) {
      seen.add(cur);
      const info = nodeInfo.get(cur);
      if (info) out.push(info.label);
      cur = parentOf.get(cur);
    }
    return out;
  }

  const totalMicros = deltas.reduce((a, b) => a + (b || 0), 0);
  console.log(`\n=== CPU profile: ${path.basename(args.profile)} ===`);
  console.log(`samples=${samples.length}  duration=${(totalMicros / 1000).toFixed(1)}ms\n`);

  console.log(`--- Top ${args.top} self-time functions ---`);
  const ranked = [...selfTime.entries()].sort((a, b) => b[1] - a[1]).slice(0, args.top);
  for (const [id, micros] of ranked) {
    const info = nodeInfo.get(id);
    const pct = totalMicros ? ((micros / totalMicros) * 100).toFixed(1) : '?';
    console.log(`  ${(micros / 1000).toFixed(1).padStart(8)}ms ${pct.padStart(5)}%  ${info ? info.label : id}`);
  }

  if (args.block) {
    // Longest run of consecutive samples sharing the same leaf node id.
    let bestLeaf = null;
    let bestMicros = 0;
    let curLeaf = null;
    let curMicros = 0;
    for (let i = 0; i < samples.length; i++) {
      const id = samples[i];
      const dt = deltas[i] ?? 0;
      if (id === curLeaf) {
        curMicros += dt;
      } else {
        curLeaf = id;
        curMicros = dt;
      }
      if (curMicros > bestMicros) {
        bestMicros = curMicros;
        bestLeaf = curLeaf;
      }
    }
    console.log(`\n--- Longest synchronous block ---`);
    if (bestLeaf != null) {
      console.log(`  duration=${(bestMicros / 1000).toFixed(1)}ms  leaf stack (innermost first):`);
      for (const frame of stackOf(bestLeaf)) console.log(`    at ${frame}`);
    } else {
      console.log('  (no samples)');
    }
  }

  } finally {
    if (resolver) resolver.destroy();
    if (fetchCleanup) await fetchCleanup();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
