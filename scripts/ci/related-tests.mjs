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
//   node scripts/ci/related-tests.mjs plan <since> <out-dir>
//       In lint.yml's `related-tests` job. Lists the files changed since <since> (the PR merge
//       commit's first parent), decides related vs smoke-only (planRun below), and writes
//       <out-dir>/files.txt (one test file per line: the smoke set, plus the related selection
//       unless deferred) and <out-dir>/plan.json. Writes the decision to the step summary.
//   node scripts/ci/related-tests.mjs assert <files.txt> <report.json>
//       After the vitest run: every listed file must appear in the JSON report. vitest given a
//       filter that matches nothing still exits 0, so a green run alone proves nothing.
//
// THE RELATED SELECTION is vitest's own (`related` + getRelevantTestSpecifications, the code
// `vitest related` runs): every unit test whose static import graph reaches a changed file. Two
// things it cannot see, which is what the fallback is for:
//   - a file a test reads at RUNTIME (readFileSync, readdirSync, a glob over the tree). Hundreds of
//     unit test files do. So a changed file that is not JavaScript/TypeScript source is a forced
//     trigger (FORCED below), and the repo-scan tests that read SOURCE files as text are the smoke
//     set, which always runs. The one exception is a non-source file under `apps/<app>/` (Go,
//     JSON, markdown, an app's own package.json): the app suites are batched anyway and few unit
//     tests read an app's files, so instead of forcing the fallback such a change ADDS every unit
//     test file whose source mentions `apps/<app>` (mentionKey). Not sound against a test that
//     builds the path at runtime without naming the app; the batch covers that case, within one
//     cadence interval of the merge.
//   - a change that alters how every test runs: the vitest/vite config, test setup files,
//     fixtures, tsconfig, package manifests and the lockfile, the Prisma schema and the generated
//     db-schema package, the test-cache scripts, CI workflows. Also forced triggers.
// A deleted or renamed source file is forced too: its importers no longer resolve, so the import
// graph cannot name them.
//
// THE CAP. A change to a widely imported module reaches most of the suite (when this was rejected
// as #7199, 7 of 20 sampled PRs selected the whole suite and the median was 557 of ~3,930 files).
// Past CAP files the related run would cost about what the batch costs, on every push, so it is
// deferred instead and the smoke set runs alone. Override with RELATED_UNIT_CAP.
//
// Node built-ins only, except `plan`, which loads vitest's node API from the installed tree.

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/** [pattern, reason]. First match wins; the reason is what the step summary prints. */
export const FORCED = [
  [/(^|\/)(vitest|vite)\.(config|workspace)\.[^/]+$/, 'vitest/vite config'],
  [/^test\//, 'test setup (test/)'],
  [/^src\/__tests__\/(setup|network-guard)\.ts$/, 'unit setup file'],
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

/**
 * For a changed non-source file under `apps/<app>/`, the text a unit test that reads it would
 * contain (`apps/<app>`); null for every other file. See the header.
 */
export function mentionKey(file) {
  const m = /^(apps\/[^/]+)\//.exec(file);
  if (!m || CODE.test(file)) return null;
  return m[1];
}

/** Test files (repo-relative) whose text contains one of `keys`. `read(path)` returns the text. */
export function selectByMention(keys, testFiles, read) {
  if (!keys.length) return [];
  return testFiles.filter((f) => {
    const text = read(f);
    return keys.some((k) => text.includes(k));
  });
}

/** The smoke set: repo-scan tests, matched on the file name. See the header. */
export const SMOKE_NAMES = [
  /^no-[^/]*\.test\.ts$/,
  /\.ledger\.test\.ts$/,
  /\.seam\.test\.ts$/,
  /parity[^/]*\.test\.ts$/,
  /\.schema-drift\.test\.ts$/,
];

/** The unit project's `include` (vitest.config.mts): `src/**\/*.test.ts`, `scripts/**\/*.test.ts`. */
const UNIT_INCLUDE = /^(src|scripts)\/.+\.test\.ts$/;

/** Is this tracked file in the smoke set? */
export function isSmoke(file) {
  if (!UNIT_INCLUDE.test(file)) return false;
  const base = file.slice(file.lastIndexOf('/') + 1);
  return SMOKE_NAMES.some((re) => re.test(base));
}

/**
 * Why a change forces the fallback, or null. `status` is git's name-status letter (A, M, D, R...);
 * for a rename, `file` is the OLD path, which is the one that went away.
 */
export function forcedReason(file, status = 'M') {
  if (IGNORED.some((re) => re.test(file))) return null;
  // An app's own manifest is the app's business (see mentionKey); the root and package manifests
  // are not, and FORCED catches them.
  if (/^apps\/[^/]+\/package\.json$/.test(file)) return null;
  for (const [re, reason] of FORCED) if (re.test(file)) return `${reason}: ${file}`;
  if (mentionKey(file)) return null;
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
 * selection and `mentioned(keys)` the mention selection (both only consulted when nothing forced
 * the fallback); `smoke` the smoke set. The cap counts both selections together.
 * Returns { mode: 'related' | 'smoke', reason, related, files }: `files` is what runs, the smoke set
 * always included, sorted and deduplicated.
 */
export function planRun({
  changes,
  smoke,
  related = () => [],
  mentioned = () => [],
  cap = DEFAULT_CAP,
}) {
  const smokeSet = [...new Set(smoke)].sort();
  const forced = changes.map((c) => forcedReason(c.file, c.status)).filter(Boolean);
  if (forced.length)
    return {
      mode: 'smoke',
      reason: `forced trigger (${forced.length}): ${forced.slice(0, 5).join('; ')}${
        forced.length > 5 ? '; ...' : ''
      }`,
      related: null,
      files: smokeSet,
    };
  const live = changes.filter((c) => c.status !== 'D');
  const code = live.filter((c) => CODE.test(c.file)).map((c) => c.file);
  const keys = [...new Set(live.map((c) => mentionKey(c.file)).filter(Boolean))].sort();
  const sel = [
    ...new Set([...(code.length ? related(code) : []), ...(keys.length ? mentioned(keys) : [])]),
  ].sort();
  if (sel.length > cap)
    return {
      mode: 'smoke',
      reason: `related selection is ${sel.length} files, over the cap of ${cap}`,
      related: sel.length,
      files: smokeSet,
    };
  return {
    mode: 'related',
    reason: `${sel.length} related file(s) for ${code.length} changed source file(s)${
      keys.length ? ` and ${keys.join(', ')}` : ''
    }`,
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

/** vitest's related selection for the unit projects: repo-relative test files. */
async function relatedWithVitest(root, changed) {
  const { createVitest } = await import('vitest/node');
  const vitest = await createVitest('test', {
    watch: false,
    run: true,
    project: ['unit*'],
    related: changed.map((f) => resolve(root, f)),
    passWithNoTests: true,
  });
  try {
    const specs = await vitest.getRelevantTestSpecifications();
    return [...new Set(specs.map((s) => relative(root, s.moduleId)))];
  } finally {
    await vitest.close();
  }
}

async function plan(since, outDir) {
  const root = process.cwd();
  mkdirSync(outDir, { recursive: true });
  const changes = parseNameStatus(sh('git', ['diff', '--name-status', '-M', since, 'HEAD']));
  const unitFiles = sh('git', ['ls-files', 'src', 'scripts'])
    .split('\n')
    .filter((f) => UNIT_INCLUDE.test(f));
  const smoke = unitFiles.filter(isSmoke);
  if (!smoke.length) {
    console.error('::error::the smoke set is empty; this job would have checked nothing.');
    process.exit(1);
  }
  const cap = Number(process.env.RELATED_UNIT_CAP || DEFAULT_CAP);
  // planRun calls `related` synchronously; the vitest API is async, so resolve it first and only
  // when the plan will consult it (nothing forced).
  const forced = changes.some((c) => forcedReason(c.file, c.status));
  let sel = [];
  const code = changes.filter((c) => c.status !== 'D' && CODE.test(c.file)).map((c) => c.file);
  if (!forced && code.length) sel = await relatedWithVitest(root, code);
  const p = planRun({
    changes,
    smoke,
    related: () => sel,
    mentioned: (keys) => selectByMention(keys, unitFiles, (f) => readFileSync(f, 'utf8')),
    cap,
  });
  writeFileSync(join(outDir, 'files.txt'), `${p.files.join('\n')}\n`);
  writeFileSync(
    join(outDir, 'plan.json'),
    JSON.stringify({ ...p, smoke: smoke.length, changed: changes.length, cap }, null, 2)
  );
  const lines = summaryLines(p, smoke.length);
  console.log(lines.join('\n'));
  console.log(`changed files (${changes.length}):`);
  for (const c of changes) console.log(`  ${c.status}\t${c.file}`);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `mode=${p.mode}\ncount=${p.files.length}\nrelated=${p.related ?? ''}\n`
    );
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
  if (cmd === 'plan') await plan(a, b);
  else if (cmd === 'assert') assertRan(a, b);
  else {
    console.error(
      'usage: related-tests.mjs plan <since> <out-dir> | assert <files.txt> <report.json>'
    );
    process.exit(2);
  }
}
