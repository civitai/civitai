#!/usr/bin/env node
// Decides which files the `ESLint + Prettier` job in .github/workflows/lint.yml checks on a PR.
//
//   node scripts/ci/lint-targets.mjs <base-ref> [out-dir]
//
// Diffs `<base-ref>...HEAD` (the PR's changes since it left the base branch) and writes four
// newline-separated lists into out-dir (default: cwd):
//
//   added.txt         *.ts/*.tsx files the PR adds            -> Prettier, BLOCKING
//   added-lint.txt    the subset of those ESLint covers       -> ESLint,   BLOCKING
//   report.txt        files for the report-only Prettier step
//   report-lint.txt   files for the report-only ESLint step
//
// Normally the report-only lists are the files the PR MODIFIES (or renames/copies), so a PR
// only pays for linting what it touched. When the PR changes something that can move the
// result for files it did NOT touch — the ESLint or Prettier config, a custom rule, the
// installed versions (package.json, pnpm-lock.yaml) — linting only the changed files would
// miss every new finding elsewhere, so the report-only lists become EVERY tracked
// *.ts/*.tsx file instead (still excluding the added ones, which the blocking steps already
// check). The job then lints those files at the merge base too and reports only what the PR
// adds (lint-new-findings.mjs), so the repo's pre-existing errors do not bury the PR's own.
//
// Prints `full=true|false` (and appends it to $GITHUB_OUTPUT when set) and, for a full run,
// every changed path that triggered it.

import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Paths an eslint config covers. apps/event-engine has its own `root: true` config, which
// eslint resolves per file, so linting it from the repo root works; the other apps/ members
// have none and would fall through to the root Next config, whose typed rules crash outside
// src/.
const LINTABLE = /^(src|packages|apps\/event-engine)\//;

const SOURCE = /\.tsx?$/;

// A change to any of these re-lints everything. Each one can change the verdict for a file
// the PR did not touch.
const FULL_RUN_TRIGGERS = [
  /^package\.json$/, // eslint/prettier/plugin versions, pnpm overrides
  /^pnpm-lock\.yaml$/, // resolved versions of the same
  // packages/.eslintrc.cjs checks import/no-extraneous-dependencies against each package's
  // own package.json.
  /^packages\/[^/]+\/package\.json$/,
  /(^|\/)\.eslintrc(\.[cm]?js|\.json|\.ya?ml)?$/,
  /^eslint\.config\.[cm]?[jt]s$/, // flat config; ESLint 8.57 picks it up when present
  /^\.eslintignore$/,
  /^eslint-[^/]+\.c?js$/, // custom rules loaded by .eslintrc.js
  /(^|\/)\.prettierrc(\.[^/]+)?$/,
  /(^|\/)prettier\.config\.[cm]?[jt]s$/,
  /^\.prettierignore$/,
  /^tailwind\.config\.[cm]?[jt]s$/, // read by eslint-plugin-tailwindcss
  /^\.github\/workflows\/lint\.yml$/,
  /^\.github\/problem-matchers\//,
  /^scripts\/ci\/lint-(targets|new-findings)\.mjs$/,
];

const [baseRef, outDir = '.'] = process.argv.slice(2);
if (!baseRef) {
  console.error('usage: lint-targets.mjs <base-ref> [out-dir]');
  process.exit(2);
}

const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n')
    .filter(Boolean);

const range = `${baseRef}...HEAD`;
// --no-renames: with rename detection a moved file is listed under its NEW path only, so
// renaming .eslintrc.js away (say, to a flat config) would hide the trigger.
const changed = git('diff', '--name-only', '--no-renames', range);
const added = git('diff', '--name-only', '--diff-filter=A', range).filter((f) => SOURCE.test(f));
const modified = git('diff', '--name-only', '--diff-filter=CMR', range).filter((f) =>
  SOURCE.test(f)
);

const triggers = changed.filter((f) => FULL_RUN_TRIGGERS.some((re) => re.test(f)));
const full = triggers.length > 0;

const addedSet = new Set(added);
const report = full ? git('ls-files').filter((f) => SOURCE.test(f) && !addedSet.has(f)) : modified;

const write = (name, files) =>
  writeFileSync(join(outDir, name), files.length ? files.join('\n') + '\n' : '');

write('added.txt', added);
write(
  'added-lint.txt',
  added.filter((f) => LINTABLE.test(f))
);
write('report.txt', report);
write(
  'report-lint.txt',
  report.filter((f) => LINTABLE.test(f))
);

console.log(`added (${added.length}):`);
for (const f of added) console.log(`  ${f}`);
if (full) {
  console.log(`full=true: this PR changes lint config or dependencies, so the report-only`);
  console.log(`steps check every tracked file (${report.length}). Triggered by:`);
  for (const f of triggers) console.log(`  ${f}`);
} else {
  console.log(`full=false; modified (${modified.length}):`);
  for (const f of modified) console.log(`  ${f}`);
}
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `full=${full}\n`);
