#!/usr/bin/env node
/**
 * Bundle budget — per-page First Load JS, brotli-sized.
 *
 * Next 16 (Turbopack) emits opaque hashed chunks with no stable
 * framework-/main-/_app- filenames, and removed the per-route build-stats
 * table, so a glob tool (size-limit) can only see a coarse total. This script
 * reads `.next/build-manifest.json` instead and reconstructs the real metric
 * Next used to print:
 *
 *   First Load JS for a route = brotli( union( pages[route], pages["/_app"],
 *                                              polyfillFiles ) )
 *   Shared by all pages       = brotli( pages["/_app"] + polyfillFiles )
 *
 * It runs inside the Dockerfile builder stage (where `.next` exists), so there
 * is no extra build. Report-only by default; pass `--gate` to exit non-zero on
 * a budget breach (for when we promote this to a hard gate).
 *
 * Budgets live in `.bundle-budget.json`:
 *   { "shared": "350 kB", "routeMax": "1.5 MB", "routes": { "/x": "2 MB" } }
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { brotliCompressSync, constants as zc } from 'node:zlib';
import { join } from 'node:path';

const NEXT_DIR = process.env.NEXT_DIR || '.next';
const MANIFEST = join(NEXT_DIR, 'build-manifest.json');
const BUDGET_FILE = process.env.BUNDLE_BUDGET_FILE || '.bundle-budget.json';
const GATE = process.argv.includes('--gate');
// `--json` also writes a machine-readable per-route snapshot (bytes, brotli),
// consumed by the perf-trend baseline job + the future PR bundle-regression
// gate. Report-only; independent of --gate.
const JSON_OUT = process.argv.includes('--json');
const JSON_FILE = process.env.BUNDLE_JSON_FILE || 'bundle-budget.json';
const TOP = Number(process.env.BUNDLE_TOP || 20);

const isJs = (f) => typeof f === 'string' && f.endsWith('.js');
const uniq = (arr) => [...new Set(arr)];

function parseSize(s) {
  if (typeof s === 'number') return s;
  const m = String(s).trim().match(/^([\d.]+)\s*(b|kb|mb|gb)?$/i);
  if (!m) return NaN;
  const n = parseFloat(m[1]);
  const unit = (m[2] || 'b').toLowerCase();
  return n * { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[unit];
}
function human(b) {
  if (b >= 1024 ** 2) return (b / 1024 ** 2).toFixed(2) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(1) + ' kB';
  return b + ' B';
}

if (!existsSync(MANIFEST)) {
  console.error(`bundle-budget: no manifest at ${MANIFEST} — was the build run?`);
  process.exit(GATE ? 1 : 0);
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const budget = existsSync(BUDGET_FILE) ? JSON.parse(readFileSync(BUDGET_FILE, 'utf8')) : {};
const sharedBudget = budget.shared != null ? parseSize(budget.shared) : Infinity;
const routeMax = budget.routeMax != null ? parseSize(budget.routeMax) : Infinity;
const routeOverrides = budget.routes || {};

// Brotli each file once (files are shared across many routes → cache).
const sizeCache = new Map();
function brSize(file) {
  if (sizeCache.has(file)) return sizeCache.get(file);
  const abs = join(NEXT_DIR, file);
  let size = 0;
  if (existsSync(abs)) {
    size = brotliCompressSync(readFileSync(abs), {
      params: { [zc.BROTLI_PARAM_QUALITY]: 11 },
    }).length;
  } else {
    console.error(`bundle-budget: WARN missing chunk ${file}`);
  }
  sizeCache.set(file, size);
  return size;
}
const sumBr = (files) => files.reduce((s, f) => s + brSize(f), 0);

const pages = manifest.pages || {};
const sharedFiles = uniq([...(pages['/_app'] || []), ...(manifest.polyfillFiles || [])]).filter(isJs);
const sharedSize = sumBr(sharedFiles);

const SKIP = new Set(['/_app', '/_error', '/_document']);
const routes = Object.keys(pages)
  .filter((r) => !SKIP.has(r))
  .map((route) => {
    const files = uniq([...(pages[route] || []), ...sharedFiles]).filter(isJs);
    return { route, files: files.length, size: sumBr(files) };
  })
  .sort((a, b) => b.size - a.size);

// Coarse total = brotli of every referenced client .js (deduped via cache).
const allFiles = uniq(Object.values(pages).flat().filter(isJs).concat(sharedFiles));
const totalSize = sumBr(allFiles);

// ---- machine-readable snapshot (for the perf-trend baseline + future gate) ----
if (JSON_OUT) {
  const snapshot = {
    // Build provenance — best-effort from common CI env vars; null if absent.
    commit:
      process.env.BUILD_SHA ||
      process.env.SOURCE_COMMIT ||
      process.env.GIT_SHA ||
      process.env.GITHUB_SHA ||
      null,
    builtAt: new Date().toISOString(),
    unit: 'bytes-brotli',
    shared: sharedSize,
    total: totalSize,
    routes: Object.fromEntries(routes.map((r) => [r.route, r.size])),
  };
  writeFileSync(JSON_FILE, JSON.stringify(snapshot, null, 2));
  console.log(`bundle-budget: wrote ${JSON_FILE} (${routes.length} routes)`);
}

// ---- report ----
const breaches = [];
const flag = (ok) => (ok ? 'OK' : 'OVER');

console.log('===== bundle budget — First Load JS (brotli) =====');
{
  const ok = sharedSize <= sharedBudget;
  if (!ok) breaches.push(`shared ${human(sharedSize)} > ${human(sharedBudget)}`);
  const limit = sharedBudget === Infinity ? '—' : human(sharedBudget);
  console.log(
    `Shared by all pages : ${human(sharedSize).padStart(9)}  (${sharedFiles.length} files)  [budget ${limit}]  ${flag(ok)}`
  );
}
console.log(`Total client JS     : ${human(totalSize).padStart(9)}  (${allFiles.length} files)`);
console.log(`Routes analysed     : ${routes.length}`);
console.log('');
console.log(`Heaviest ${Math.min(TOP, routes.length)} routes by First Load JS:`);
for (const r of routes.slice(0, TOP)) {
  const limit = routeOverrides[r.route] != null ? parseSize(routeOverrides[r.route]) : routeMax;
  const ok = r.size <= limit;
  if (!ok) breaches.push(`${r.route} ${human(r.size)} > ${human(limit)}`);
  const limTxt = limit === Infinity ? '—' : human(limit);
  console.log(`  ${human(r.size).padStart(9)}  ${r.route.padEnd(42)} [budget ${limTxt}] ${flag(ok)}`);
}
// routes outside the top-N can still breach
for (const r of routes.slice(TOP)) {
  const limit = routeOverrides[r.route] != null ? parseSize(routeOverrides[r.route]) : routeMax;
  if (r.size > limit) breaches.push(`${r.route} ${human(r.size)} > ${human(limit)}`);
}
console.log('');

if (breaches.length) {
  console.log(`${breaches.length} budget breach(es):`);
  for (const b of breaches) console.log(`  ✗ ${b}`);
  console.log(GATE ? 'FAIL (gating)' : 'breaches found (report-only — not gating)');
  process.exit(GATE ? 1 : 0);
}
console.log(GATE ? 'PASS' : 'within budget (report-only)');
process.exit(0);
