#!/usr/bin/env node
// Decides what the `Unit tests` job in .github/workflows/lint.yml runs on a pull request.
//
//   node scripts/ci/unit-targets.mjs <base-ref> [out-file]
//
// FULL      every unit test file, on the existing 4-shard matrix. Chosen when the PR changes
//           anything that can move a test result OUTSIDE the import graph (see fullRunTriggers).
// NARROWED  the test files whose import graph reaches a changed file (vitest's own `related`
//           walk), plus the tests that read source files by path (readsSourceByPath), split into
//           as few jobs as carry the load (planShards). Zero files is a legitimate answer.
//
// Writes <out-file> (default unit-targets.json; each narrowed job reads its chunk from it) and,
// when $GITHUB_OUTPUT is set, `mode` and `shards` (the matrix) to it.
//
// Run only on a PR. A push to `main` runs the full suite without consulting this, and that run is
// the backstop for anything a narrowed PR run misses.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEPENDENCY_TRIGGERS, changedFiles, matchesAny } from './full-run-triggers.mjs';

// Things the import graph cannot see, each able to change a result for a test that imports
// nothing the PR touched.
const UNIT_TRIGGERS = [
  ...DEPENDENCY_TRIGGERS,
  /(^|\/)package\.json$/, // apps/* too: src imports workspace packages by their manifests
  /^pnpm-workspace\.yaml$/,
  /^patches\//, // pnpm patches rewrite node_modules
  /^\.nvmrc$/,
  /^event-engine-common$/, // the submodule pointer; src imports from it
  /(^|\/)tsconfig[^/]*\.json$/, // path aliases resolve every import
  /(^|\/)vite(st)?\.config\.[cm]?[jt]s$/,
  /^scripts\/test-unit-run\.mjs$/,
  /^scripts\/ci\/(unit-targets|full-run-triggers|assert-shard-ran|assert-unit-files-ran)\.mjs$/,
];

// The only files the import graph can account for. A changed file of any other kind (markdown,
// SQL, JSON fixtures, the Prisma schema, .svelte, workflow YAML) may be read by a test by path,
// and the unit tests do read such files: CLAUDE.md files, .claude/rules, app READMEs and sources,
// migrations, workflow files. Rather than keep a list of which, any such change runs everything.
const MODULE_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

// Docs no unit test reads; the workflow's `paths` filter already skips docs-only PRs, so these
// matter only when a PR changes docs AND code. The one docs file a test reads stays a trigger.
const UNREAD_DOCS = /^(docs|claudedocs)\//;
const READ_DOCS = new Set(['docs/dev/convention-guards.md']);

/** Changed paths that force a full run; empty means the import graph can decide. */
export function fullRunTriggers(changed) {
  return changed.filter((f) => {
    if (matchesAny(UNIT_TRIGGERS, f)) return true;
    if (READ_DOCS.has(f)) return true;
    if (UNREAD_DOCS.test(f)) return false;
    return !MODULE_EXT.has(extname(f));
  });
}

// A test that reads SOURCE files by path (convention guards, parity pins, import-graph checks)
// depends on files it never imports, so `related` cannot select it. Reads of non-module files
// are covered by the full-run rule above; this catches the module-file case.
//
// 🔴 A HEURISTIC, and it errs toward running more: a test (or a test-support module it imports)
// that loads fs or child_process AND walks a directory, spawns a process, or names a module-file
// path. One that hides all three behind a non-test helper is missed, and the push run on `main`
// catches what that misses. The deterministic alternative is a per-file read manifest recorded
// by a full run (scripts/test-cache/fs-tracker.mjs records exactly that, locally).
const LOADS_FS =
  /(?:\bfrom|\bimport\s*\(|\brequire\s*\()\s*['"](?:node:)?(?:fs|fs\/promises|child_process)['"]/;
const REACHES_SOURCE =
  /\b(?:readdirSync|readdir|opendirSync|opendir|globSync|glob|execFileSync|execSync|execFile|spawnSync|spawn)\s*\(|['"`][^'"`\n]*\.(?:[cm]?[jt]sx?|svelte)['"`]/;

export const readsSourceByPath = (text) => LOADS_FS.test(text) && REACHES_SOURCE.test(text);

const TEST_SUPPORT = /(^|\/)(__tests__|test)\/|\.(harness|fixture)\.[cm]?[jt]s$/;

// A narrowed job carries at most one full shard's share of files, so it can't run longer than a
// full-run shard does. Past 3 shards a narrowed run saves nothing worth the extra moving part.
const FULL_SHARDS = 4;
const MAX_NARROWED_SHARDS = 3;

/**
 * Splits `files` (sorted) round-robin into the fewest chunks of at most total/FULL_SHARDS files.
 * Returns null when that takes more than MAX_NARROWED_SHARDS, meaning: run the full suite instead.
 */
export function planShards(files, total) {
  if (files.length === 0) return [];
  const n = Math.ceil(files.length / Math.ceil(total / FULL_SHARDS));
  if (n > MAX_NARROWED_SHARDS) return null;
  const chunks = Array.from({ length: n }, () => []);
  files.forEach((f, i) => chunks[i % n].push(f));
  return chunks;
}

/** The decision, from plain inputs, so it can be tested without vitest or git. */
export function decide({ changed, allTests, related, sourceReaders }) {
  const triggers = fullRunTriggers(changed);
  if (triggers.length) return { mode: 'full', reason: 'trigger', triggers };
  const all = new Set(allTests);
  const selected = [...new Set([...related, ...(changed.length ? sourceReaders : [])])]
    .filter((f) => all.has(f))
    .sort();
  // 🔴 POSITIVE CONTROL on the graph walk: a changed unit test file must select itself. If the
  // walk silently returned nothing (unresolved base, unloaded project), this is where it shows.
  const missing = changed.filter((f) => all.has(f) && !selected.includes(f));
  if (missing.length) {
    throw new Error(`changed test files missing from the selection: ${missing.join(', ')}`);
  }
  const chunks = planShards(selected, allTests.length);
  if (chunks === null) return { mode: 'full', reason: 'size', selected };
  return { mode: 'narrowed', selected, chunks };
}

const UNIT_PROJECT = /^unit/;

async function collect(root, changed) {
  const { createVitest } = await import('vitest/node');
  const vitest = await createVitest('test', {
    watch: false,
    project: ['unit*'],
    // `related`, not `--changed`: vitest's own git query adds untracked and modified files, and
    // `pnpm install` rewrites tracked generated files in CI.
    related: changed.map((f) => resolve(root, f)),
  });
  try {
    const rel = (f) => relative(root, f);
    const allSpecs = (await vitest.globTestSpecifications()).filter((s) =>
      UNIT_PROJECT.test(s.project.name)
    );
    const relatedSpecs = await vitest.getRelevantTestSpecifications();

    // vitest's walk starts at each test file, so it never sees what a setup file imports, yet
    // every test runs that code. Walk the setup files' graphs the same way vitest walks a test's.
    const deps = async (project, file, seen) => {
      if (seen.has(file)) return;
      seen.add(file);
      const env = project.vite.environments.ssr;
      const t =
        env.moduleGraph.getModuleById(file)?.transformResult ?? (await env.transformRequest(file));
      for (const d of [...(t?.deps ?? []), ...(t?.dynamicDeps ?? [])]) {
        const p = d.startsWith('/@fs/') ? d.slice(4) : join(project.config.root, d);
        if (!p.includes('node_modules') && existsSync(p)) await deps(project, p, seen);
      }
    };
    const setupGraph = new Set();
    const unitProjects = vitest.projects.filter((p) => UNIT_PROJECT.test(p.name));
    for (const p of unitProjects) for (const s of p.config.setupFiles) await deps(p, s, setupGraph);

    // Test-support modules a test imports count as the test's own code for readsSourceByPath.
    const readsCache = new Map();
    const reads = async (project, file, seen = new Set()) => {
      if (readsCache.has(file)) return readsCache.get(file);
      if (seen.has(file)) return false;
      seen.add(file);
      let hit = readsSourceByPath(readFileSync(file, 'utf8'));
      if (!hit) {
        const env = project.vite.environments.ssr;
        const t =
          env.moduleGraph.getModuleById(file)?.transformResult ??
          (await env.transformRequest(file));
        for (const d of t?.deps ?? []) {
          const p = d.startsWith('/@fs/') ? d.slice(4) : join(project.config.root, d);
          if (TEST_SUPPORT.test(rel(p)) && !p.includes('node_modules') && existsSync(p)) {
            if (await reads(project, p, seen)) {
              hit = true;
              break;
            }
          }
        }
      }
      readsCache.set(file, hit);
      return hit;
    };
    const sourceReaders = [];
    for (const s of allSpecs)
      if (await reads(s.project, s.moduleId)) sourceReaders.push(rel(s.moduleId));

    return {
      allTests: [...new Set(allSpecs.map((s) => rel(s.moduleId)))],
      related: relatedSpecs
        .filter((s) => UNIT_PROJECT.test(s.project.name))
        .map((s) => rel(s.moduleId)),
      setupGraph: [...setupGraph].map(rel),
      sourceReaders,
    };
  } finally {
    await vitest.close();
  }
}

async function main() {
  const [baseRef, outFile = 'unit-targets.json'] = process.argv.slice(2);
  if (!baseRef) {
    console.error('usage: unit-targets.mjs <base-ref> [out-file]');
    process.exit(2);
  }
  const root = process.cwd();
  const changed = changedFiles(baseRef, root);
  console.log(`changed (${changed.length}) on ${baseRef}...HEAD:`);
  for (const f of changed) console.log(`  ${f}`);

  let result;
  const triggers = fullRunTriggers(changed);
  if (triggers.length) {
    result = { mode: 'full', reason: 'trigger', triggers };
  } else {
    const c = await collect(root, changed);
    const inSetup = changed.filter((f) => c.setupGraph.includes(f));
    console.log(
      `unit test files: ${c.allTests.length}; related by import graph: ${c.related.length}; ` +
        `read source by path: ${c.sourceReaders.length}; setup-file graph: ${c.setupGraph.length} modules`
    );
    if (c.allTests.length === 0) throw new Error('the unit projects resolved no test files');
    result = inSetup.length
      ? { mode: 'full', reason: 'setup', triggers: inSetup }
      : { ...decide({ changed, ...c }), total: c.allTests.length };
  }

  if (result.mode === 'full') {
    const why = {
      trigger: 'it changes files the import graph cannot see',
      setup: 'it changes code the unit setup files load, which every test runs',
      size: `it selects ${result.selected?.length} files, more than ${MAX_NARROWED_SHARDS} narrowed shards hold`,
    }[result.reason];
    console.log(`mode=full: ${why}.`);
    for (const f of result.triggers ?? []) console.log(`  ${f}`);
  } else {
    console.log(
      `mode=narrowed: ${result.selected.length} of ${result.total} test files in ` +
        `${result.chunks.length} job(s) (${result.chunks.map((c) => c.length).join(' + ')}).`
    );
  }

  writeFileSync(outFile, JSON.stringify(result, null, 2) + '\n');
  if (process.env.GITHUB_OUTPUT) {
    const shards = result.mode === 'full' ? [1, 2, 3, 4] : result.chunks.map((_, i) => i + 1);
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `mode=${result.mode}\nshards=${JSON.stringify(shards)}\n`
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err?.stack ?? String(err));
    process.exit(1);
  });
}
