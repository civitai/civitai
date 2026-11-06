#!/usr/bin/env node
/**
 * Checks that the `pull_request` `paths:` filter of `.github/workflows/apps.yml` still covers
 * every file outside `apps/` and `packages/` that the app suites read.
 *
 * The filter is what lets a PR that cannot affect the apps start no app job at all. Its failure
 * mode is silent: a missing entry produces no error, only a skipped run on the one PR that
 * needed it (the unfiltered push run on `main` is the backstop, after the merge). So the list
 * is re-derived here from the code on every run, and the job fails when the two disagree.
 *
 * What it derives, each the way the app suites actually reach it:
 *   1. the root `vitest.config.mts` and every relative module it imports, transitively —
 *      `vitest --project 'app:*'` loads the root config before any app config;
 *   2. every repo script the workflow's `run:` lines name, following `pnpm run <script>` through
 *      the root package.json (and `pnpm install` through its install hooks), plus each script's
 *      relative imports;
 *   3. every `../../`-style path in a file under `apps/` that resolves outside `apps/` and
 *      `packages/` (an import, a `new URL(.., import.meta.url)`, a path handed to `fs`).
 *
 * Item 3 is a text scan, not a resolver: it resolves each literal against the file's own
 * directory, so a path built from some other base (`path.resolve(SRC, '../..')`) can be missed.
 * It also checks the other direction: a filter entry that matches nothing on disk is stale.
 *
 * Usage:  node scripts/ci/assert-apps-paths-filter.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

export const WORKFLOW = '.github/workflows/apps.yml';

/**
 * Out-of-tree references the scan finds that are not inputs a PR can change, each with why.
 * An entry no longer found by the scan is an error, so this cannot quietly outlive its reason.
 */
export const NOT_INPUTS = {
  '.env': 'gitignored and absent on a runner; apps/moderator/vitest.config.ts reads it if present',
};

// ESLint configs reach root ESLint rules; this workflow runs no ESLint (lint.yml does).
const SKIP_FILE = /^\.eslintrc|^eslint\.config\./;
const SKIP_DIR = new Set(['node_modules', '.svelte-kit', 'dist', 'build', '.turbo']);
const SOURCE_FILE = /\.(c|m)?(t|j)sx?$|\.svelte$/;

/** GitHub `paths` glob -> RegExp. Only `*` and `**` are supported; anything else throws. */
export function globToRegExp(pattern) {
  if (/[?[\]{}!+]/.test(pattern)) {
    throw new Error(`unsupported glob syntax in "${pattern}" (only * and ** are handled here)`);
  }
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      re += '.*';
      i++;
    } else if (c === '*') {
      re += '[^/]*';
    } else {
      re += c.replace(/[.^$|()\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

export const isCovered = (file, patterns) => patterns.some((p) => globToRegExp(p).test(file));

/** Relative module specifiers a JS/TS file imports statically or with a literal `import()`. */
function relativeImports(text) {
  const out = [];
  for (const m of text.matchAll(
    /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g
  )) {
    out.push(m[1]);
  }
  return out;
}

/** `file` plus every relative module it reaches, as repo-relative posix paths. */
function importClosure(root, file, seen = new Set()) {
  if (seen.has(file) || !existsSync(join(root, file))) return seen;
  seen.add(file);
  for (const spec of relativeImports(readFileSync(join(root, file), 'utf8'))) {
    importClosure(root, posix.normalize(posix.join(posix.dirname(file), spec)), seen);
  }
  return seen;
}

/** Repo scripts a shell line runs, following `pnpm run <name>` and `pnpm install` hooks. */
function scriptsRunBy(line, pkgScripts, seenNames = new Set()) {
  const files = [...line.matchAll(/\bscripts\/[\w./-]+\.(?:c|m)?[jt]s\b/g)].map((m) => m[0]);
  const names = [...line.matchAll(/\bpnpm\s+(?:run\s+)?([\w:-]+)/g)].map((m) => m[1]);
  if (/\bpnpm\s+install\b/.test(line)) names.push('preinstall', 'postinstall', 'prepare');
  for (const name of names) {
    if (seenNames.has(name) || typeof pkgScripts[name] !== 'string') continue;
    seenNames.add(name);
    files.push(...scriptsRunBy(pkgScripts[name], pkgScripts, seenNames));
  }
  return files;
}

function* walk(root, dir) {
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = posix.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIR.has(e.name)) yield* walk(root, rel);
    } else if (SOURCE_FILE.test(e.name) && !SKIP_FILE.test(e.name)) {
      yield rel;
    }
  }
}

/** Paths outside apps/ and packages/ that a file under apps/ names with a `../../` literal. */
function appOutOfTreeRefs(root) {
  const refs = new Map();
  if (!existsSync(join(root, 'apps'))) return refs;
  for (const file of walk(root, 'apps')) {
    const text = readFileSync(join(root, file), 'utf8');
    for (const m of text.matchAll(/['"`]((?:\.\.\/){2,}[^'"`$\s]*)/g)) {
      let target = posix.normalize(posix.join(posix.dirname(file), m[1]));
      if (target.startsWith('../') || target === '..') continue;
      if (/^(apps|packages)(\/|$)/.test(target)) continue;
      target = target.replace(/\/$/, '');
      if (!refs.has(target)) refs.set(target, file);
    }
  }
  return refs;
}

/** Every input the filter must cover, mapped to the reason it is one. */
export function requiredInputs(root) {
  const need = new Map();
  const add = (path, why) => need.has(path) || need.set(path, why);

  add(WORKFLOW, 'the workflow itself');
  for (const f of importClosure(root, 'vitest.config.mts')) {
    add(f, 'loaded with the root vitest config');
  }

  const workflow = parse(readFileSync(join(root, WORKFLOW), 'utf8'));
  const pkgScripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts ?? {};
  for (const job of Object.values(workflow.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (typeof step.run !== 'string') continue;
      for (const script of scriptsRunBy(step.run, pkgScripts)) {
        for (const f of importClosure(root, script))
          add(f, `run by step "${step.name ?? step.run}"`);
      }
    }
  }

  for (const [target, from] of appOutOfTreeRefs(root)) {
    if (target in NOT_INPUTS) continue;
    const isDir = existsSync(join(root, target)) && statSync(join(root, target)).isDirectory();
    add(isDir ? `${target}/**` : target, `read by ${from}`);
  }
  return need;
}

/** The `pull_request` `paths:` list of the workflow. */
export function filterPaths(root) {
  const doc = parse(readFileSync(join(root, WORKFLOW), 'utf8'));
  const paths = doc?.on?.pull_request?.paths;
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error(`${WORKFLOW} has no on.pull_request.paths list`);
  }
  return paths.map(String);
}

export function checkAppsPathsFilter(root) {
  const patterns = filterPaths(root);
  const negated = patterns.filter((p) => p.startsWith('!'));
  const need = requiredInputs(root);
  const uncovered = [...need]
    // A directory input is covered when a file inside it would be.
    .filter(
      ([path]) => !isCovered(path.endsWith('/**') ? `${path.slice(0, -3)}/x` : path, patterns)
    )
    .map(([path, why]) => `${path} (${why})`);
  const stale = patterns
    .filter((p) => !p.startsWith('!'))
    .filter((p) => {
      const prefix = p.split('*')[0].replace(/\/$/, '');
      return prefix !== '' && !existsSync(join(root, prefix));
    });
  const refs = appOutOfTreeRefs(root);
  const staleExemptions = Object.keys(NOT_INPUTS).filter((k) => !refs.has(k));
  return { negated, uncovered, stale, staleExemptions };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const { negated, uncovered, stale, staleExemptions } = checkAppsPathsFilter(root);
  const problems = [
    ...negated.map((p) => `negated pattern "${p}" is not supported by this check`),
    ...uncovered.map((u) => `not in the paths filter: ${u}`),
    ...stale.map((p) => `paths entry matches nothing on disk: ${p}`),
    ...staleExemptions.map((k) => `NOT_INPUTS entry "${k}" is no longer referenced from apps/`),
  ];
  if (problems.length > 0) {
    for (const p of problems) console.error(`::error file=${WORKFLOW}::${p}`);
    console.error(`${problems.length} problem(s). Edit on.pull_request.paths in ${WORKFLOW}.`);
    process.exit(1);
  }
  console.log(`${WORKFLOW}: paths filter covers all ${requiredInputs(root).size} derived inputs`);
}
