#!/usr/bin/env node
// The per-PR unit tier: the unit tests RELATED to what a pull request changed, plus a fixed SMOKE
// set, with a fallback rule that runs the smoke set alone and defers the rest to the main batch.
//
// The full unit suite does not run on a pull request (lint.yml, the `unit` job): it is verified in
// batches on `main` (unit-batched.yml), and on a PR only with the `full-ci` label. This job is what
// a PR without the label gets instead, so a break in the code it touched usually shows on the PR
// rather than an hour or two after merge. It is a FAST signal, never the verdict: the batch still
// runs every file on `main`, and a PR this job deferred is covered there and nowhere earlier.
//
//   node scripts/ci/related-tests.mjs plan <since> <out-dir> <shards>
//       In lint.yml's `related-plan` job, ONCE per run. Lists the files changed since <since> (the
//       PR merge commit's first parent), decides related vs smoke-only (planRun below), splits the
//       files to run into <shards> balanced lists (splitShards), and writes <out-dir>/files.txt (all
//       of them), <out-dir>/shard-<i>.txt and <out-dir>/plan.json, plus the decision to the step
//       summary. The shard jobs download that directory, so the selection (up to ~160 s of import-
//       graph walking) is paid once, not once per shard.
//   node scripts/ci/related-tests.mjs shard <plan-dir> <i> <report>
//       In each `related-tests` matrix job: runs <plan-dir>/shard-<i>.txt and writes the JSON report.
//       Exit 1 when the run failed or wrote no report.
//   node scripts/ci/related-tests.mjs assert <files.txt> <report.json>
//       In the `related-ledger` job, over the merged shard reports: every listed file must appear.
//       vitest given a filter that matches nothing still exits 0, so a green run alone proves
//       nothing. (The merge itself fails on a missing shard, a file in two shards, or a shard index
//       out of range: scripts/ci/merge-component-shard-reports.mjs.)
//
// THE SPLIT (splitShards) balances by each file's recent cost: the per-file p50 over the newest
// main batch runs' `test-times-unit-*` reports (the same per-test timing artifacts the unit job
// uploads; fileWeights), plus a fixed per-file overhead for import, which those timings do not
// cover. A file with no timing gets the median weight; with no timings at all the split is by
// count. Every file lands in exactly one shard; the split is deterministic for a given input.
//
// THE RELATED SELECTION is vitest's own (`related` + getRelevantTestSpecifications, the code
// `vitest related` runs): every unit test whose static import graph reaches a changed file. Two
// things it cannot see, which is what the fallback is for:
//   - a file a test reads at RUNTIME (readFileSync, readdirSync, a glob over the tree). Hundreds of
//     unit test files do. So a changed file that is not JavaScript/TypeScript source is a forced
//     trigger (FORCED below), and the tests that read files as text are the SMOKE SET, which always
//     runs (isSmoke, the content rule below).
//   - a change that alters how every test runs: the vitest/vite config, the unit projects' setup
//     files AND every module they import, transitively (derived from the config at run time,
//     setupClosure), test/, fixtures, tsconfig, package manifests and the lockfile, the Prisma
//     schema and the generated db-schema package, the test-cache scripts, CI workflows. Also
//     forced triggers.
//
// THE SMOKE SET (isSmoke): a unit test file whose NAME is a repo-scan name (`no-*`, `*.ledger`,
// `*.seam`, `*parity*`, `*.schema-drift`, case-insensitive), OR that is listed in
// scripts/ci/smoke-scanners.txt: the tests that read repo source as text or walk a source tree
// (that file's header says what qualifies). The list was derived once by review and is checked in;
// a scanner missing from it is still verified by the main batch. A listed path that no longer
// exists, or is not a unit-project test file, fails the job naming it (checkManifest), so the list
// cannot rot silently.
//
// THE CAP. A change to a widely imported module reaches most of the suite (when this was rejected
// as #7199, 7 of 20 sampled PRs selected the whole suite and the median was 557 of ~3,930 files).
// Past CAP files the related run would cost about what the batch costs, on every push, so it is
// deferred instead and the smoke set runs alone. Override with RELATED_UNIT_CAP.
//
// Node built-ins only, except `plan`, which loads vitest's node API from the installed tree.

import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Related unit files above which the run is deferred to the batch. */
export const DEFAULT_CAP = 250;

/** Source files the import graph can follow. Anything else changed is a forced trigger. */
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;

/**
 * Trees no unit test reads (lint.yml's `paths:` filter skips a PR that changes only these, and its
 * header says no unit test opens a file there). Changing one forces nothing.
 */
const IGNORED = [/^docs\//, /^claudedocs\//];

/**
 * [pattern, reason]. First match wins; the reason is what the step summary prints. The unit setup
 * files and their imports are not listed here: they come from the config (setupClosure), so a new
 * setup file or a new import of one needs no edit.
 */
export const FORCED = [
  [/(^|\/)(vitest|vite)\.(config|workspace)\.[^/]+$/, 'vitest/vite config'],
  [/^test\//, 'test setup (test/)'],
  [/(^|\/)(__fixtures__|fixtures)\//, 'test fixtures'],
  [/(^|\/)tsconfig[^/]*\.json$/, 'tsconfig'],
  [/(^|\/)package\.json$/, 'package.json'],
  [/^(pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|\.nvmrc)$/, 'dependencies / toolchain'],
  [/^patches\//, 'dependency patches'],
  [/\.prisma$/, 'Prisma schema'],
  [/^packages\/civitai-db-schema\//, 'generated db-schema package'],
  [/^scripts\/test-cache\//, 'test-cache scripts'],
  [/^\.github\//, 'CI workflows'],
  [/^event-engine-common$/, 'submodule pin'],
];

/** Smoke-set names (case-insensitive), matched on the file name. See the header. */
export const SMOKE_NAMES = [
  /^no-[^/]*\.test\.ts$/i,
  /\.ledger\.test\.ts$/i,
  /\.seam\.test\.ts$/i,
  /parity[^/]*\.test\.ts$/i,
  /\.schema-drift\.test\.ts$/i,
];

/** The checked-in list of tree-scanning tests. See the header. */
export const SCANNERS_FILE = 'scripts/ci/smoke-scanners.txt';

/** The manifest's paths: one per line, `#` comments and blank lines dropped. */
export function parseManifest(text) {
  return text
    .split('\n')
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter(Boolean);
}

/**
 * The manifest's problems, as messages naming each path: a path that does not exist (`exists`),
 * one that is not a unit-project test file, or one listed twice. Empty when the list is sound.
 */
export function checkManifest(paths, exists) {
  const errors = [];
  const seen = new Set();
  for (const f of paths) {
    if (seen.has(f)) errors.push(`${SCANNERS_FILE}: listed twice: ${f}`);
    seen.add(f);
    if (!UNIT_INCLUDE.test(f))
      errors.push(
        `${SCANNERS_FILE}: not a unit-project test file (src|scripts/**/*.test.ts): ${f}`
      );
    else if (!exists(f)) errors.push(`${SCANNERS_FILE}: no such file: ${f}`);
  }
  return errors;
}

/** The unit project's `include` (vitest.config.mts): `src/**\/*.test.ts`, `scripts/**\/*.test.ts`. */
const UNIT_INCLUDE = /^(src|scripts)\/.+\.test\.ts$/;

/** Is this tracked file in the smoke set? `scanners`: the manifest's paths (a Set). */
export function isSmoke(file, scanners = new Set()) {
  if (!UNIT_INCLUDE.test(file)) return false;
  const base = file.slice(file.lastIndexOf('/') + 1);
  return SMOKE_NAMES.some((re) => re.test(base)) || scanners.has(file);
}

/**
 * Every module `entries` import, transitively, entries included: `depsOf(file)` returns a
 * module's local imports (absolute paths). Pure; see setupClosure for the real `depsOf`.
 */
export async function importClosure(entries, depsOf) {
  const seen = new Set();
  const visit = async (f) => {
    if (seen.has(f)) return;
    seen.add(f);
    for (const d of (await depsOf(f)) ?? []) await visit(d);
  };
  for (const e of entries) await visit(e);
  return seen;
}

/**
 * Why a change forces the fallback, or null. `status` is git's name-status letter (A, M, D, R...);
 * for a rename, `file` is the OLD path, which is the one that went away.
 */
export function forcedReason(file, status = 'M', setup = new Set()) {
  if (IGNORED.some((re) => re.test(file))) return null;
  for (const [re, reason] of FORCED) if (re.test(file)) return `${reason}: ${file}`;
  if (setup.has(file)) return `unit setup file or a module it imports: ${file}`;
  if (!CODE.test(file)) return `not import-visible (a test may read it at runtime): ${file}`;
  if (status === 'D' || status.startsWith('R'))
    return `source file removed or renamed (its importers cannot be traced): ${file}`;
  return null;
}

/**
 * Parse `git diff --name-status` output into [{status, file}], one entry per path a change
 * touches: a rename contributes its OLD path with status R (the path that went away) and its NEW
 * path with status A.
 */
export function parseNameStatus(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const [status, a, b] = line.split('\t');
    if (status.startsWith('R') || status.startsWith('C')) {
      if (status.startsWith('R')) out.push({ status, file: a });
      out.push({ status: 'A', file: b });
    } else out.push({ status, file: a });
  }
  return out;
}

/**
 * The decision, pure. `changes` from parseNameStatus; `related(codeFiles)` is vitest's related
 * selection (only consulted when nothing forced the fallback); `smoke` the smoke set; `setup` the
 * repo-relative setup closure. Returns { mode: 'related' | 'smoke', reason, related, files }:
 * `files` is what runs, the smoke set always included, sorted and deduplicated.
 */
export function planRun({ changes, smoke, related = () => [], cap = DEFAULT_CAP, setup }) {
  const smokeSet = [...new Set(smoke)].sort();
  const forced = changes.map((c) => forcedReason(c.file, c.status, setup)).filter(Boolean);
  if (forced.length)
    return {
      mode: 'smoke',
      reason: `forced trigger (${forced.length}): ${forced.slice(0, 5).join('; ')}${
        forced.length > 5 ? '; ...' : ''
      }`,
      related: null,
      files: smokeSet,
    };
  const code = changes.filter((c) => c.status !== 'D' && CODE.test(c.file)).map((c) => c.file);
  const sel = [...new Set(code.length ? related(code) : [])].sort();
  if (sel.length > cap)
    return {
      mode: 'smoke',
      reason: `related selection is ${sel.length} files, over the cap of ${cap}`,
      related: sel.length,
      files: smokeSet,
    };
  return {
    mode: 'related',
    reason: `${sel.length} related file(s) for ${code.length} changed source file(s)`,
    related: sel.length,
    files: [...new Set([...smokeSet, ...sel])].sort(),
  };
}

/** The step summary for a plan. Deferred runs say so in words a reader can search for. */
export function summaryLines(plan, smokeCount) {
  const lines = ['### Related unit tests (PR tier)', ''];
  if (plan.mode === 'smoke') {
    lines.push(
      `**Deferred to batch.** Ran the smoke set only (${smokeCount} files): ${plan.reason}.`,
      '',
      'The full unit suite verifies this change on `main` in the next batch run. For a verdict' +
        ' before merging, add the `full-ci` label.'
    );
  } else {
    lines.push(
      `Ran ${plan.files.length} file(s): the smoke set (${smokeCount}) and ${plan.reason}.`,
      '',
      'Not the full suite: the main batch still runs every unit test after merge.'
    );
  }
  return lines;
}

/** Listed files the JSON report does not contain. Report names are absolute. */
export function missingFromReport(listed, report, root) {
  const ran = new Set(
    (report.testResults ?? []).map((t) => (isAbsolute(t.name) ? relative(root, t.name) : t.name))
  );
  return listed.filter((f) => !ran.has(f));
}

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20 });

/**
 * The unit projects' setup files and every module they import, repo-relative. The setup files are
 * read from the resolved config (each unit project's `setupFiles`), the imports through vite's
 * own transform (the same resolution `vitest related` uses), so aliases resolve as in a run.
 */
async function setupClosure(vitest, root) {
  const projects = vitest.projects.filter((p) => p.name.startsWith('unit'));
  const out = new Set();
  for (const project of projects) {
    const env = project.vite.environments.ssr;
    const depsOf = async (file) => {
      const t =
        env.moduleGraph.getModuleById(file)?.transformResult ?? (await env.transformRequest(file));
      return [...(t?.deps ?? []), ...(t?.dynamicDeps ?? [])]
        .map((d) => (d.startsWith('/@fs/') ? d.slice(4) : join(project.config.root, d)))
        .filter((f) => !f.includes('node_modules') && existsSync(f));
    };
    for (const f of await importClosure(project.config.setupFiles ?? [], depsOf))
      out.add(relative(root, f));
  }
  return out;
}

/** The p50 of a non-empty list of numbers (the lower middle for an even count). */
export function p50(values) {
  const v = [...values].sort((a, b) => a - b);
  return v[Math.floor((v.length - 1) / 2)];
}

/**
 * Per-file weights (ms) from vitest JSON reports: `runs` is [[report, ...], ...], one array per
 * batch run (a run's shard reports together). A file's weight is the p50 over the runs of its
 * test time (endTime - startTime) plus `overheadMs` for its import, which the JSON reporter's
 * per-file times leave out. Repo-relative paths.
 */
export function fileWeights(runs, root, overheadMs = 1000) {
  const per = new Map();
  for (const reports of runs) {
    const seen = new Map();
    for (const r of reports)
      for (const t of r.testResults ?? []) {
        if (typeof t.startTime !== 'number' || typeof t.endTime !== 'number') continue;
        const f = isAbsolute(t.name) ? relative(root, t.name) : t.name;
        seen.set(f, Math.max(0, t.endTime - t.startTime));
      }
    for (const [f, ms] of seen) per.set(f, [...(per.get(f) ?? []), ms]);
  }
  const out = new Map();
  for (const [f, v] of per) out.set(f, p50(v) + overheadMs);
  return out;
}

/**
 * Split `files` into `n` shards, pure and deterministic. With weights: longest-first onto the
 * lightest shard (ties: path order, then the lowest shard), a file without a weight taking the
 * median of the known ones. With no weights at all: by count, sorted path order round-robin.
 * Returns { shards: string[][], by: 'timings' | 'count', loads: number[] }.
 */
export function splitShards(files, weights, n) {
  const sorted = [...new Set(files)].sort();
  const known = sorted.filter((f) => weights?.has(f)).map((f) => weights.get(f));
  const shards = Array.from({ length: n }, () => []);
  if (!known.length) {
    sorted.forEach((f, i) => shards[i % n].push(f));
    return { shards, by: 'count', loads: shards.map((s) => s.length) };
  }
  const fallback = p50(known);
  const w = (f) => (weights.has(f) ? weights.get(f) : fallback);
  const order = [...sorted].sort((a, b) => w(b) - w(a) || (a < b ? -1 : 1));
  const loads = Array(n).fill(0);
  for (const f of order) {
    let k = 0;
    for (let i = 1; i < n; i++) if (loads[i] < loads[k]) k = i;
    shards[k].push(f);
    loads[k] += w(f);
  }
  for (const s of shards) s.sort();
  return { shards, by: 'timings', loads: loads.map(Math.round) };
}

/**
 * The newest main batch runs' unit timing reports, for fileWeights: [[report, ...], ...]. Best
 * effort: any error, or no run, returns [] and the split falls back to count.
 */
function batchTimings(dir, maxRuns = 3) {
  try {
    const repo = process.env.GITHUB_REPOSITORY;
    const q = 'branch=main&event=workflow_dispatch&status=completed&per_page=10';
    const runs = JSON.parse(
      sh('gh', [
        'api',
        `repos/${repo}/actions/workflows/lint.yml/runs?${q}`,
        '-q',
        '.workflow_runs',
      ])
    ).filter((r) => r.actor?.login === 'github-actions[bot]');
    const out = [];
    for (const r of runs) {
      if (out.length >= maxRuns) break;
      const d = join(dir, String(r.id));
      try {
        sh('gh', ['run', 'download', String(r.id), '-R', repo, '-p', 'test-times-unit-*', '-D', d]);
      } catch {
        continue;
      }
      const reports = [];
      const visit = (p) => {
        for (const e of readdirSync(p, { withFileTypes: true })) {
          const q2 = join(p, e.name);
          if (e.isDirectory()) visit(q2);
          else if (e.name.endsWith('.json')) reports.push(JSON.parse(readFileSync(q2, 'utf8')));
        }
      };
      if (existsSync(d)) visit(d);
      if (reports.length) out.push(reports);
    }
    return out;
  } catch (err) {
    console.log(`no batch timings (${String(err.message).split('\n')[0]}): splitting by count`);
    return [];
  }
}

/** The CLI's environment, which the node API does not set (measured: two suites fail without). */
function vitestEnv() {
  process.env.TEST = 'true';
  process.env.VITEST = 'true';
  process.env.NODE_ENV ??= 'test';
}

async function plan(since, outDir, shardsRaw) {
  const n = Number(shardsRaw);
  if (!Number.isInteger(n) || n < 1) {
    console.error(`::error::bad shard count: ${shardsRaw}`);
    process.exit(2);
  }
  const root = process.cwd();
  mkdirSync(outDir, { recursive: true });
  const changes = parseNameStatus(sh('git', ['diff', '--name-status', '-M', since, 'HEAD']));
  const unitFiles = sh('git', ['ls-files', 'src', 'scripts'])
    .split('\n')
    .filter((f) => UNIT_INCLUDE.test(f));
  const manifest = parseManifest(readFileSync(SCANNERS_FILE, 'utf8'));
  const manifestErrors = checkManifest(manifest, existsSync);
  if (manifestErrors.length) {
    for (const e of manifestErrors) console.error(`::error file=${SCANNERS_FILE}::${e}`);
    console.error(`${manifestErrors.length} problem(s) in ${SCANNERS_FILE}; fix the list.`);
    process.exit(1);
  }
  const scanners = new Set(manifest);
  const smoke = unitFiles.filter((f) => isSmoke(f, scanners));
  if (!smoke.length) {
    console.error('::error::the smoke set is empty; this job would have checked nothing.');
    process.exit(1);
  }
  const cap = Number(process.env.RELATED_UNIT_CAP || DEFAULT_CAP);
  const t0 = Date.now();
  vitestEnv();
  const { createVitest } = await import('vitest/node');
  const vitest = await createVitest('test', {
    watch: false,
    run: true,
    project: ['unit*'],
    passWithNoTests: true,
  });
  let p;
  try {
    const setup = await setupClosure(vitest, root);
    const forced = changes.some((c) => forcedReason(c.file, c.status, setup));
    const code = changes.filter((c) => c.status !== 'D' && CODE.test(c.file)).map((c) => c.file);
    let sel = [];
    if (!forced && code.length) {
      vitest.config.related = code.map((f) => resolve(root, f));
      const specs = await vitest.getRelevantTestSpecifications();
      sel = [...new Set(specs.map((s) => relative(root, s.moduleId)))];
    }
    p = planRun({ changes, smoke, related: () => sel, cap, setup });
  } finally {
    await vitest.close();
  }
  const planMs = Date.now() - t0;
  const t1 = Date.now();
  const weights = fileWeights(batchTimings(join(outDir, 'timings')), root);
  const split = splitShards(p.files, weights, n);
  const timingMs = Date.now() - t1;
  writeFileSync(join(outDir, 'files.txt'), `${p.files.join('\n')}\n`);
  split.shards.forEach((s, i) =>
    writeFileSync(join(outDir, `shard-${i + 1}.txt`), `${s.join('\n')}\n`)
  );
  writeFileSync(
    join(outDir, 'plan.json'),
    JSON.stringify(
      {
        ...p,
        smoke: smoke.length,
        changed: changes.length,
        cap,
        planMs,
        timingMs,
        split: { by: split.by, loads: split.loads, sizes: split.shards.map((s) => s.length) },
      },
      null,
      2
    )
  );
  const lines = summaryLines(p, smoke.length);
  lines.push(
    '',
    `Selection took ${Math.round(planMs / 1000)} s. Split ${n} ways by ${split.by} (${Math.round(
      timingMs / 1000
    )} s): ${split.shards
      .map((s, i) => `shard ${i + 1} ${s.length} files, load ${split.loads[i]}`)
      .join('; ')}.`
  );
  console.log(lines.join('\n'));
  console.log(`changed files (${changes.length}):`);
  for (const c of changes) console.log(`  ${c.status}\t${c.file}`);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  rmSync(join(outDir, 'timings'), { recursive: true, force: true });
}

async function shard(planDir, i, report) {
  const files = readFileSync(join(planDir, `shard-${i}.txt`), 'utf8')
    .split('\n')
    .filter(Boolean);
  if (!files.length) {
    console.error(`::error::shard ${i} has no files; the plan split nothing to it.`);
    process.exit(1);
  }
  console.log(`shard ${i}: ${files.length} file(s)`);
  vitestEnv();
  const { createVitest } = await import('vitest/node');
  const vitest = await createVitest('test', {
    watch: false,
    run: true,
    project: ['unit*'],
    passWithNoTests: true,
    reporters: ['default', 'json'],
    outputFile: { json: report },
  });
  try {
    await vitest.start(files);
  } finally {
    await vitest.close();
  }
  if (!existsSync(report)) {
    console.error(`::error::${report} was never written: vitest did not finish.`);
    process.exit(1);
  }
  const r = JSON.parse(readFileSync(report, 'utf8'));
  process.exit(r.success === false || (r.numFailedTests ?? 0) > 0 ? 1 : 0);
}

function assertRan(listFile, reportFile) {
  const listed = readFileSync(listFile, 'utf8').split('\n').filter(Boolean);
  if (!listed.length) {
    console.error('::error::no test files were listed; this job would have checked nothing.');
    process.exit(1);
  }
  if (!existsSync(reportFile)) {
    console.error(`::error::${reportFile} was never written: vitest did not finish.`);
    process.exit(1);
  }
  const report = JSON.parse(readFileSync(reportFile, 'utf8'));
  const missing = missingFromReport(listed, report, process.cwd());
  console.log(`vitest ran ${report.testResults?.length ?? 0} file(s); ${listed.length} listed.`);
  if (missing.length) {
    console.error(
      `::error::vitest did not run ${missing.length} of ${listed.length} listed file(s): ${missing
        .slice(0, 10)
        .join(', ')}`
    );
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, a, b] = process.argv.slice(2);
  const c = process.argv[5];
  if (cmd === 'plan') await plan(a, b, c);
  else if (cmd === 'shard') await shard(a, b, c);
  else if (cmd === 'assert') assertRan(a, b);
  else {
    console.error(
      'usage: related-tests.mjs plan <since> <out-dir> <shards> | shard <plan-dir> <i> <report> | assert <files.txt> <report.json>'
    );
    process.exit(2);
  }
}
