#!/usr/bin/env node
// Change-scoped test selection for the `unit` and `component` suites in .github/workflows/lint.yml.
//
// SHADOW MODE BY DEFAULT. The workflow still runs every test; the `affected` job computes
// what a scoped run WOULD have run and records each failing test file that fell outside that
// selection (a "miss"). Enforcement is the repo variable SELECTIVE_TESTS_ENFORCE=true, off.
//
//   node scripts/ci/test-selection.mjs select <base-sha|-> <out.json>
//   node scripts/ci/test-selection.mjs ledger <selection.json> <reports-dir> <out.json>
//   node scripts/ci/test-selection.mjs files <selection.json> <project> [--shard=i/N]
//
// `select` diffs <base>...HEAD, applies FULL_RUN_RULES, then walks vitest's own module graph (the
// one `vitest related` walks) once per project and selects every test file that reaches a changed
// file, plus ALWAYS_RUN tests. `-` as the base means "no base", which is a full run.
// `ledger` reads the full run's vitest JSON reports and writes one record per run.
// `files` prints the selected files for one project (one absolute path per line), for enforce mode.
//
// 🔴 FAIL OPEN IS THE WHOLE SAFETY MODEL: anything this script cannot see through (an error, no
// base, a change listed in FULL_RUN_RULES, a setup file reached, a selection over MAX_SHARE)
// selects the full suite, and says why.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── THE FALLBACK LIST. One place; each entry says why the import graph cannot see it. ──────────
export const FULL_RUN_RULES = [
  [/(^|\/)package\.json$/, 'package manifest: dependency versions, workspace links, scripts'],
  [/^pnpm-lock\.yaml$/, 'lockfile: resolved versions of every dependency'],
  [/^pnpm-workspace\.yaml$/, 'workspace layout and catalog versions'],
  [/^patches\//, 'pnpm patches rewrite files inside node_modules'],
  [/^\.npmrc$/, 'package manager settings'],
  [/\.prisma$/, 'Prisma schema: install regenerates the client every DB test loads'],
  [/(^|\/)(vitest|vite)\.config\.[cm]?[jt]s$/, 'test runner config'],
  [/(^|\/)tsconfig[^/]*\.json$/, 'path aliases decide what every import resolves to'],
  [/^test\//, 'browser-mode global setup, setup files and fixtures'],
  [/^scripts\/test-unit-run\.mjs$/, 'the unit suite runner'],
  [/^\.github\//, 'CI workflow files'],
  [/^scripts\/ci\//, 'CI pipeline scripts, this selector included'],
  [/^(\.nvmrc|\.node-version|flake\.nix|flake\.lock)$/, 'toolchain version'],
  [/^event-engine-common$/, 'submodule pointer: src imports the submodule by path'],
  // A non-module file where code that tests IMPORT reads files at runtime (public/ fonts, package
  // data, scripts' config): a test reaches that reader through an import, not through fs, so the
  // always-run set below does not cover it. src/ is decided in decide(): see SRC_UNIMPORTED.
  [
    /^(public|packages|scripts)\/.*(?<!\.[cm]?[jt]sx?)$/,
    'a non-module file imported code may read at runtime',
  ],
  [
    /^[^/]*(?<!\.[cm]?[jt]sx?)$/,
    'a non-module file at the repo root, read by tooling and some routes',
  ],
];
// Everything else that is not a module (apps/**, .claude/**, docs/**, ...) is read only by tests
// that load fs themselves, and those are in ALWAYS_RUN. docs/** and claudedocs/** are also outside
// the workflow's `paths` filter, so a change there never starts a run at all.
// The setup files and everything they import are found from the graph (setupReach), not listed.

// A project whose selection exceeds this share runs in full: past it, a scoped run saves too little
// to be worth a verdict that is not a full one.
export const MAX_SHARE = 0.5;
// Share of test files that must import at least one file, or the graph walk is presumed blind.
const MIN_LINKED = 0.5;

export const PROJECTS = { unit: ['unit', 'unit-native'], component: ['component'] };
// A browser project's instances are named `<project> (<browser>)`, e.g. `component (chromium)`.
const inProject = (members, name) => members.some((m) => name === m || name.startsWith(`${m} (`));

/** Changed paths that force a full run, each with its reason. Empty: the graph decides. */
export function fullRunTriggers(changed, deleted = []) {
  const out = [];
  for (const f of changed) {
    const rule = FULL_RUN_RULES.find(([re]) => re.test(f));
    if (rule) out.push({ file: f, reason: rule[1] });
    else if (deleted.includes(f) && isModule(f) && !isTestFile(f))
      out.push({ file: f, reason: 'a deleted module: its importers are not in the HEAD graph' });
  }
  return out;
}

// A non-module file under src/ that no test imports (a stylesheet or JSON a module imports is in the
// graph and is decided there): production code reads such files at runtime (src/static-content).
export const SRC_UNIMPORTED =
  'a non-module file under src/ that no test imports: code may read it at runtime';

export const isTestFile = (f) => /\.test\.tsx?$/.test(f);
const isModule = (f) => /\.[cm]?[jt]sx?$/.test(f);

// ── THE ALWAYS-RUN SET: tests that depend on files they never import. ─────────────────────────
// A test is in it when the test file, or a test-support or scripts/ module it imports, loads fs,
// child_process or a glob library: that is how convention guards, parity pins, doc and workflow
// tests read the tree. Found by reading each file's text for the import (FS_IMPORT), so it errs
// toward running more. Production modules under src/ that read files are NOT counted (every test
// would reach one); the non-module files they read are full-run triggers above instead.
// Plus every file in package.json `test:lint-rules`, by name.
export const FS_IMPORT =
  /(?:\bfrom|\bimport\s*\(|\brequire\s*\()\s*['"](?:node:)?(?:fs|fs\/promises|child_process|glob|fast-glob|tinyglobby|globby)['"]/;
const READER_SCOPE =
  /(^|\/)(__tests__|__mocks__|test|tests|testing)\/|\.(harness|fixture|fixtures|test-utils?)\.[cm]?[jt]sx?$|^scripts\/|\.test\.tsx?$/;
export const isReaderCandidate = (f) => READER_SCOPE.test(f);

export function lintRulesFiles(pkgJson) {
  const script = JSON.parse(pkgJson).scripts?.['test:lint-rules'] ?? '';
  return script.split(/\s+/).filter((t) => isTestFile(t));
}

// ── THE DECISION, from plain inputs, so it is testable without vitest or git. ─────────────────
/**
 * @param changed   repo-relative changed paths (base...HEAD)
 * @param deleted   the subset of `changed` deleted at HEAD
 * @param graph     { [project]: { tests, setupReach, has(path), importsOf(path), dependents(paths) } }
 * @param alwaysRun { [project]: string[] }
 */
export function decide({ changed, deleted = [], graph, alwaysRun }) {
  const triggers = fullRunTriggers(changed, deleted);
  const result = { changed, triggers, projects: {} };
  for (const [name, g] of Object.entries(graph)) {
    const total = g.tests.length;
    if (total === 0) throw new Error(`project ${name} resolved no test files`);
    const full = (reason) => (result.projects[name] = { mode: 'full', reason, total });
    if (triggers.length) {
      full(`${triggers[0].file}: ${triggers[0].reason}`);
      continue;
    }
    const unimported = changed.find(
      (f) => f.startsWith('src/') && !isModule(f) && !Object.values(graph).some((x) => x.has(f))
    );
    if (unimported) {
      full(`${unimported}: ${SRC_UNIMPORTED}`);
      continue;
    }
    const setupHit = changed.find((f) => g.setupReach.includes(f));
    if (setupHit) {
      full(`${setupHit}: reached from a ${name} setup file, which every ${name} test runs`);
      continue;
    }
    // 🔴 POSITIVE CONTROL on the graph walk. A walk that resolved no imports (a transform that
    // returned nothing, a wrong environment) would select only the changed tests and look like a
    // perfectly narrow selection. Most test files import the module they test.
    const linked = g.tests.filter((t) => g.importsOf(t) > 0).length;
    if (linked < total * MIN_LINKED)
      throw new Error(
        `${name}: only ${linked} of ${total} test files import anything; the walk is blind`
      );
    const all = new Set(g.tests);
    const selected = new Set(
      [...g.dependents(changed), ...changed, ...(alwaysRun[name] ?? [])].filter((f) => all.has(f))
    );
    if (selected.size > total * MAX_SHARE) {
      full(`selects ${selected.size} of ${total} files, over ${MAX_SHARE * 100}%`);
      continue;
    }
    result.projects[name] = { mode: 'scoped', total, selected: [...selected].sort() };
  }
  return result;
}

/** Reverse-reachability over forward edges: every node whose imports reach one of `targets`. */
export function makeDependents(edges) {
  const rev = new Map();
  for (const [from, tos] of edges)
    for (const to of tos) {
      if (!rev.has(to)) rev.set(to, new Set());
      rev.get(to).add(from);
    }
  return (targets) => {
    const seen = new Set();
    const queue = [...targets];
    while (queue.length) {
      const n = queue.pop();
      for (const p of rev.get(n) ?? []) if (!seen.has(p)) seen.add(p), queue.push(p);
    }
    return seen;
  };
}

// ── THE LEDGER: one machine-readable record per shadow run. ───────────────────────────────────
const projectOf = (f) => (/\.browser\.test\.tsx$/.test(f) ? 'component' : 'unit');

export function ledger(selection, reports, meta) {
  const failed = { unit: new Set(), component: new Set() };
  const ran = { unit: new Set(), component: new Set() };
  for (const r of reports)
    for (const t of r.testResults ?? []) {
      const f = relative(meta.root, t.name);
      ran[projectOf(f)].add(f);
      if (t.status === 'failed') failed[projectOf(f)].add(f);
    }
  const record = {
    v: 1,
    run_id: meta.runId,
    enforced: Boolean(selection.enforced),
    sha: selection.sha,
    base: selection.base,
    event: meta.event,
    fallback: selection.error ?? selection.triggers?.[0]?.reason ?? null,
    projects: {},
  };
  for (const [name, p] of Object.entries(selection.projects ?? {})) {
    const sel = new Set(p.selected ?? []);
    const f = [...failed[name]].sort();
    record.projects[name] = {
      mode: p.mode,
      reason: p.reason ?? null,
      selected: p.mode === 'full' ? p.total : sel.size,
      total: p.total,
      ran: ran[name].size > 0,
      failed: f,
      failed_outside_selection: p.mode === 'full' ? [] : f.filter((x) => !sel.has(x)),
      // Enforced and scoped: a selected file the suite never reported is a selection that did not
      // reach vitest, which no shard floor catches any more.
      not_run:
        selection.enforced && p.scopedRun && ran[name].size > 0
          ? [...sel].filter((x) => !ran[name].has(x))
          : [],
    };
  }
  return record;
}

// ── I/O: git and vitest. ──────────────────────────────────────────────────────────────────────
const git = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20 }).trim();

function diff(base, root) {
  // --no-renames: a move is a delete plus an add, so moving a trigger file away cannot hide it.
  const lines = git(['diff', '--name-status', '--no-renames', `${base}...HEAD`], root).split('\n');
  const changed = [];
  const deleted = [];
  for (const l of lines.filter(Boolean)) {
    const [status, path] = l.split('\t');
    changed.push(path);
    if (status === 'D') deleted.push(path);
  }
  return { changed, deleted };
}

export async function buildGraph(root) {
  const { createVitest } = await import('vitest/node');
  const names = Object.values(PROJECTS).flat();
  const vitest = await createVitest('test', { watch: false, project: names });
  try {
    const specs = await vitest.globTestSpecifications();
    const graph = {};
    const alwaysRun = {};
    const rel = (f) => relative(root, f);
    const lintRules = lintRulesFiles(readFileSync(join(root, 'package.json'), 'utf8'));
    for (const [name, members] of Object.entries(PROJECTS)) {
      const edges = new Map();
      const projects = vitest.projects.filter((p) => inProject(members, p.name));
      // vitest's getTestDependencies walk (cli-api), kept whole rather than per test file.
      const walk = async (project, file) => {
        if (edges.has(rel(file))) return;
        const out = new Set();
        edges.set(rel(file), out);
        const env = project.vite.environments.ssr;
        const t =
          env.moduleGraph.getModuleById(file)?.transformResult ??
          (await env.transformRequest(file));
        const deps = [...(t?.deps ?? []), ...(t?.dynamicDeps ?? [])];
        await Promise.all(
          deps.map(async (d) => {
            // `?raw` / `?url` imports name a real file; strip the query so it stays in the graph.
            const bare = d.split('?')[0];
            const p = bare.startsWith('/@fs/') ? bare.slice(4) : join(project.config.root, bare);
            if (p.includes('node_modules') || !existsSync(p) || !statSync(p).isFile()) return;
            out.add(rel(p));
            await walk(project, p);
          })
        );
      };
      const tests = [];
      for (const s of specs.filter((s) => inProject(members, s.project.name))) {
        tests.push(rel(s.moduleId));
        await walk(s.project, s.moduleId);
      }
      const setupRoots = projects.flatMap((p) => p.config.setupFiles.map((f) => resolve(f)));
      for (const p of projects) for (const s of p.config.setupFiles) await walk(p, resolve(s));
      const dependents = makeDependents(edges);
      // Everything a setup file reaches: a change there reaches every test in the project.
      const setupReach = new Set();
      const fwd = (n) => {
        if (setupReach.has(n)) return;
        setupReach.add(n);
        for (const d of edges.get(n) ?? []) fwd(d);
      };
      setupRoots.forEach((f) => fwd(rel(f)));
      // Always-run: the test, or a test-support / scripts module it reaches, loads fs.
      const readers = [...edges.keys()].filter(
        (f) => isReaderCandidate(f) && FS_IMPORT.test(readFileSync(join(root, f), 'utf8'))
      );
      const testSet = new Set(tests);
      alwaysRun[name] = [
        ...new Set(
          [...readers, ...dependents(readers), ...lintRules].filter((f) => testSet.has(f))
        ),
      ].sort();
      graph[name] = {
        tests,
        setupReach: [...setupReach],
        has: (f) => edges.has(f),
        importsOf: (f) => edges.get(f)?.size ?? 0,
        dependents,
        modules: edges.size,
      };
    }
    return { graph, alwaysRun };
  } finally {
    await vitest.close();
  }
}

function baseUsable(base, root) {
  if (!base || base === '-' || /^0+$/.test(base)) return false;
  try {
    git(['cat-file', '-e', `${base}^{commit}`], root);
    git(['merge-base', base, 'HEAD'], root);
    return true;
  } catch {
    return false;
  }
}

export async function select(base, out, root, build = buildGraph) {
  const sha = git(['rev-parse', 'HEAD'], root);
  const fullAll = (error) => ({
    sha,
    base: base ?? null,
    error,
    projects: Object.fromEntries(
      Object.keys(PROJECTS).map((n) => [n, { mode: 'full', reason: error }])
    ),
  });
  let result;
  try {
    if (!baseUsable(base, root)) {
      result = fullAll(`no usable base (${base || 'none'}): nothing to diff against`);
    } else {
      const { changed, deleted } = diff(base, root);
      const t0 = Date.now();
      const { graph, alwaysRun } = await build(root);
      result = { sha, base, ...decide({ changed, deleted, graph, alwaysRun }) };
      result.graph_seconds = Math.round((Date.now() - t0) / 1000);
      result.always_run = Object.fromEntries(
        Object.entries(alwaysRun).map(([k, v]) => [k, v.length])
      );
      result.modules = Object.fromEntries(Object.entries(graph).map(([k, g]) => [k, g.modules]));
    }
  } catch (err) {
    // 🔴 Fail open: a selector that cannot finish selects everything.
    console.error(err?.stack ?? String(err));
    result = fullAll(`selector error: ${String(err?.message ?? err).slice(0, 300)}`);
  }
  writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
  return result;
}

export function summarize(sel, record) {
  const lines = [
    sel.enforced
      ? '### Change-scoped test selection (ENFORCED on this run)'
      : '### Change-scoped test selection (SHADOW: every suite below ran in full)',
    '',
    `base \`${sel.base ?? 'none'}\` → head \`${sel.sha}\`; ${
      sel.changed?.length ?? '?'
    } changed file(s).`,
    '',
    '| project | would run | of | mode | reason | failed | failed outside selection |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const [n, p] of Object.entries(record.projects)) {
    const ran = p.ran ? '' : ' (suite not run in this run)';
    lines.push(
      `| ${n} | ${p.selected ?? '?'} | ${p.total ?? '?'} | ${p.mode} | ${p.reason ?? ''} | ${
        p.failed.length
      }${ran} | ${p.failed_outside_selection.length} |`
    );
  }
  lines.push(
    '',
    sel.enforced
      ? 'A project whose tests ran scoped has a SCOPED result, not a full verdict.'
      : 'Shadow only: "would run" is what a scoped run would have selected. A scoped run is SCOPED, not a full verdict.'
  );
  return lines.join('\n') + '\n';
}

function readReports(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  const visit = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) visit(p);
      else if (e.name.endsWith('.json')) out.push(JSON.parse(readFileSync(p, 'utf8')));
    }
  };
  visit(dir);
  return out;
}

/**
 * The `unit` job's matrix. Full (4 shards) unless enforcement is on and unit is scoped; then as few
 * shards as hold the selection at no more files per shard than a full run's shard carries.
 */
export function unitPlan(sel, enforce, fullShards = 4) {
  const u = sel.projects?.unit;
  const full = { scoped: false, shards: Array.from({ length: fullShards }, (_, i) => i + 1) };
  if (!enforce || u?.mode !== 'scoped') return full;
  const n = Math.ceil(u.selected.length / Math.ceil(u.total / fullShards));
  if (n < 1 || n >= fullShards) return full;
  return { scoped: true, shards: Array.from({ length: n }, (_, i) => i + 1) };
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const root = process.cwd();
  if (cmd === 'select') {
    const [base, out] = args;
    const r = await select(base, out, root);
    for (const [n, p] of Object.entries(r.projects))
      console.log(
        `${n}: ${p.mode}${p.mode === 'scoped' ? ` ${p.selected.length} of ${p.total} files` : ''}` +
          `${p.reason ? ` (${p.reason})` : ''}`
      );
    if (r.graph_seconds !== undefined)
      console.log(
        `graph: ${JSON.stringify(r.modules)} modules in ${r.graph_seconds}s; ` +
          `always-run ${JSON.stringify(r.always_run)}`
      );
    if (process.env.GITHUB_OUTPUT) {
      const plan = unitPlan(r, process.env.SELECTIVE_TESTS_ENFORCE === 'true');
      if (plan.scoped) {
        r.enforced = true;
        r.projects.unit.scopedRun = true;
        writeFileSync(out, JSON.stringify(r, null, 2) + '\n');
      }
      writeFileSync(
        process.env.GITHUB_OUTPUT,
        `unit_scoped=${plan.scoped}\nunit_shards=${JSON.stringify(plan.shards)}\n` +
          `unit_shard_total=${plan.shards.length}\n`,
        { flag: 'a' }
      );
      console.log(
        plan.scoped
          ? `ENFORCED: unit runs ${r.projects.unit.selected.length} of ${r.projects.unit.total} files ` +
              `on ${plan.shards.length} shard(s). SCOPED, not a full verdict.`
          : 'unit runs in full (shadow mode, or the selection fell back to the full suite).'
      );
    }
  } else if (cmd === 'ledger') {
    const [selPath, reportsDir, out] = args;
    const sel = JSON.parse(readFileSync(selPath, 'utf8'));
    const record = ledger(sel, readReports(reportsDir), {
      root,
      runId: process.env.GITHUB_RUN_ID ?? null,
      event: process.env.GITHUB_EVENT_NAME ?? null,
    });
    writeFileSync(out, JSON.stringify(record) + '\n');
    // One greppable line per run.
    console.log(`selective-tests-ledger ${JSON.stringify(record)}`);
    if (process.env.GITHUB_STEP_SUMMARY)
      writeFileSync(process.env.GITHUB_STEP_SUMMARY, summarize(sel, record), { flag: 'a' });
    const notRun = Object.values(record.projects).flatMap((p) => p.not_run);
    if (notRun.length) {
      console.error(
        `selected but never reported by vitest (${notRun.length}): ${notRun.slice(0, 20)}`
      );
      process.exit(1);
    }
  } else if (cmd === 'files') {
    const [selPath, project] = args;
    const p = JSON.parse(readFileSync(selPath, 'utf8')).projects?.[project];
    if (p?.mode === 'scoped') for (const f of p.selected) console.log(resolve(root, f));
  } else {
    console.error(
      'usage: test-selection.mjs select <base|-> <out> | ledger <sel> <dir> <out> | files <sel> <project>'
    );
    process.exit(2);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err?.stack ?? String(err));
    process.exit(1);
  });
}
