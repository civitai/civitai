#!/usr/bin/env node
// Full-run half of the `ESLint + Prettier` job in .github/workflows/lint.yml: reports only the
// lint findings a PR ADDS, by linting the same files at the PR head and at its merge base.
//
// A full run (lint config or dependencies changed, see lint-targets.mjs) checks every tracked
// file. Listing everything it finds buries the PR's own effect under the repo's pre-existing
// errors and unformatted files, so the job compares the two trees instead:
//
//   node lint-new-findings.mjs collect <head|base> <eslint-list> <prettier-list> <dir> [--existing-only]
//       Runs ESLint (JSON) and `prettier --list-different` over the listed files in the
//       current checkout, concurrently, and writes <side>-eslint.json, <side>-unformatted.txt
//       and <side>-prettier-errors.txt into <dir>. --existing-only drops listed files that do
//       not exist in this checkout (used at the base, where the PR's renamed files are absent).
//
//   node lint-new-findings.mjs compare <dir>
//       Prints, annotates and writes to $GITHUB_STEP_SUMMARY what head has that base does not.
//       Exits 1 when there is anything new, 2 when an input is missing or incomplete.
//
// An ESLint finding is keyed on (file, rule, severity, message) and counted, so moved lines are
// not new but a second copy of an existing finding in the same file is. Prettier is compared
// as a set of unformatted files, and of files Prettier failed to parse.

import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SEVERITY = { 1: 'warning', 2: 'error' };

/**
 * @typedef {{ ruleId: string | null, severity: number, message: string, line?: number, column?: number }} EslintMessage
 * @typedef {{ filePath: string, messages: EslintMessage[] }} EslintResult
 * @typedef {{ file: string, rule: string, severity: string, message: string, line: number, column: number }} Finding
 * @typedef {Finding & { added: number, items: Finding[] }} NewFindingGroup
 */

// Keeps the argv of each ESLint/Prettier invocation well below the kernel limit.
const CHUNK = 1500;

/**
 * @param {EslintResult[]} results
 * @returns {Map<string, { count: number, items: Finding[] }>}
 */
function tally(results) {
  const byKey = new Map();
  for (const r of results) {
    for (const m of r.messages) {
      const finding = {
        file: r.filePath,
        rule: m.ruleId ?? '(fatal)',
        severity: SEVERITY[/** @type {1 | 2} */ (m.severity)] ?? 'error',
        message: m.message,
        line: m.line ?? 1,
        column: m.column ?? 1,
      };
      const key = JSON.stringify([finding.file, finding.rule, finding.severity, finding.message]);
      const entry = byKey.get(key) ?? { count: 0, items: [] };
      entry.count += 1;
      entry.items.push(finding);
      byKey.set(key, entry);
    }
  }
  return byKey;
}

/**
 * ESLint findings at head beyond those at base. Each returned group is one key whose head
 * count exceeds its base count; `added` is by how much, `items` every head occurrence (a
 * moved line cannot tell us which occurrence is the new one).
 *
 * @param {EslintResult[]} base relative-path ESLint results
 * @param {EslintResult[]} head
 * @returns {NewFindingGroup[]}
 */
export function newEslintFindings(base, head) {
  const before = tally(base);
  const groups = [];
  for (const [key, { count, items }] of tally(head)) {
    const added = count - (before.get(key)?.count ?? 0);
    if (added > 0) groups.push({ ...items[0], added, items });
  }
  return groups.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/**
 * Entries of `head` that are not in `base`, sorted.
 * @param {string[]} base
 * @param {string[]} head
 */
export function newEntries(base, head) {
  const before = new Set(base);
  return [...new Set(head)].filter((f) => !before.has(f)).sort();
}

/**
 * Files named on Prettier's `[error] <file>: ...` stderr lines.
 * @param {string} stderr
 */
export function prettierErrorFiles(stderr) {
  const files = new Set();
  for (const line of stderr.split('\n')) {
    const m = /^\[error\] ([^:\s][^:]*): /.exec(line);
    if (m) files.add(m[1]);
  }
  return [...files].sort();
}

const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escProp = (s) => esc(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

/**
 * Everything `compare` prints for one comparison: workflow annotation commands, the step
 * summary markdown and the number that decides the exit code.
 *
 * @param {{ eslint: NewFindingGroup[], unformatted: string[], prettierErrors: string[],
 *           baseErrorCount: number, baseUnformattedCount: number }} input
 */
export function report({
  eslint,
  unformatted,
  prettierErrors,
  baseErrorCount,
  baseUnformattedCount,
}) {
  const errors = eslint.filter((g) => g.severity === 'error');
  const warnings = eslint.filter((g) => g.severity === 'warning');
  const newErrors = errors.reduce((n, g) => n + g.added, 0);
  const newWarnings = warnings.reduce((n, g) => n + g.added, 0);
  const total = newErrors + unformatted.length + prettierErrors.length;

  const annotations = [];
  for (const g of errors) {
    const extra =
      g.items.length > g.added
        ? ` (${g.added} more than at base, ${g.items.length} in this file)`
        : '';
    for (const i of g.items) {
      annotations.push(
        `::error file=${escProp(i.file)},line=${i.line},col=${i.column},title=${escProp(
          `New ESLint error: ${g.rule}`
        )}::${esc(g.message + extra)}`
      );
    }
  }
  for (const f of prettierErrors)
    annotations.push(
      `::error file=${escProp(f)},title=New Prettier error::${esc(
        'Prettier failed on this file at the PR head but not at the merge base.'
      )}`
    );
  for (const f of unformatted)
    annotations.push(
      `::error file=${escProp(f)},title=Newly unformatted::${esc(
        `Formatted at the merge base, not at the PR head. Run: pnpm exec prettier --write ${f}`
      )}`
    );

  const LIMIT = 300;
  const md = [];
  md.push(
    total === 0
      ? '### Lint (full run): no new findings vs the merge base'
      : `### Lint (full run): ${total} new finding(s) vs the merge base`
  );
  md.push('');
  md.push('| | new in this PR | at the merge base (not counted) |');
  md.push('|---|---:|---:|');
  md.push(`| ESLint errors | **${newErrors}** | ${baseErrorCount} |`);
  md.push(`| Unformatted files | **${unformatted.length}** | ${baseUnformattedCount} |`);
  md.push(`| Prettier parse errors | **${prettierErrors.length}** | |`);
  md.push(`| ESLint warnings (not counted) | ${newWarnings} | |`);
  if (errors.length) {
    md.push(
      '',
      '#### New ESLint errors',
      '',
      '| file | rule | message | new |',
      '|---|---|---|---:|'
    );
    for (const g of errors.slice(0, LIMIT))
      md.push(
        `| \`${cell(g.file)}:${g.line}\` | ${cell(g.rule)} | ${cell(g.message)} | ${g.added} |`
      );
    if (errors.length > LIMIT) md.push('', `…and ${errors.length - LIMIT} more; see the step log.`);
  }
  for (const [title, files] of [
    ['Newly unformatted files', unformatted],
    ['New Prettier parse errors', prettierErrors],
  ]) {
    if (!files.length) continue;
    md.push('', `#### ${title}`, '');
    for (const f of files.slice(0, LIMIT)) md.push(`- \`${f}\``);
    if (files.length > LIMIT) md.push('', `…and ${files.length - LIMIT} more; see the step log.`);
  }
  if (warnings.length) {
    md.push('', '<details><summary>New ESLint warnings</summary>', '');
    for (const g of warnings.slice(0, LIMIT))
      md.push(`- \`${cell(g.file)}:${g.line}\` ${cell(g.rule)}: ${cell(g.message)}`);
    md.push('', '</details>');
  }

  return { total, newErrors, annotations, summary: md.join('\n') + '\n' };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const readList = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean);

const chunks = (list) => {
  const out = [];
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK));
  return out;
};

function run(bin, args) {
  return new Promise((done, fail) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => err.push(d));
    p.on('error', fail);
    p.on('close', (code) =>
      done({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      })
    );
  });
}

async function collectEslint(files) {
  const results = [];
  for (const batch of chunks(files)) {
    const r = await run(resolve('node_modules/.bin/eslint'), ['--format', 'json', ...batch]);
    // 0 = clean, 1 = findings. Anything else (2 = config or internal error) means no verdict.
    if (r.code !== 0 && r.code !== 1) throw new Error(`eslint exited ${r.code}:\n${r.stderr}`);
    for (const res of JSON.parse(r.stdout))
      results.push({
        filePath: relative(process.cwd(), res.filePath),
        messages: res.messages.map(({ ruleId, severity, message, line, column }) => ({
          ruleId,
          severity,
          message,
          line,
          column,
        })),
      });
  }
  return results;
}

async function collectPrettier(files) {
  const unformatted = [];
  let stderr = '';
  for (const batch of chunks(files)) {
    // 0 = all formatted, 1 = some not, 2 = a file failed to parse (named on stderr).
    const r = await run(resolve('node_modules/.bin/prettier'), ['--list-different', ...batch]);
    if (r.code !== 0 && r.code !== 1 && r.code !== 2)
      throw new Error(`prettier exited ${r.code}:\n${r.stderr}`);
    unformatted.push(...r.stdout.split('\n').filter(Boolean));
    stderr += r.stderr;
  }
  return { unformatted, errors: prettierErrorFiles(stderr), stderr };
}

async function collect(side, eslintList, prettierList, dir, existingOnly) {
  if (side !== 'head' && side !== 'base') throw new Error(`side must be head or base, got ${side}`);
  const pick = (list) => {
    const all = readList(list);
    if (!existingOnly) return all;
    const kept = all.filter((f) => existsSync(f));
    if (kept.length < all.length)
      console.log(`${list}: ${all.length - kept.length} file(s) absent here, skipped`);
    return kept;
  };
  const lintFiles = pick(eslintList);
  const fmtFiles = pick(prettierList);
  const t0 = Date.now();
  const [eslint, prettier] = await Promise.all([
    collectEslint(lintFiles),
    collectPrettier(fmtFiles),
  ]);
  writeFileSync(join(dir, `${side}-eslint.json`), JSON.stringify(eslint));
  writeFileSync(
    join(dir, `${side}-unformatted.txt`),
    prettier.unformatted.map((f) => f + '\n').join('')
  );
  writeFileSync(
    join(dir, `${side}-prettier-errors.txt`),
    prettier.errors.map((f) => f + '\n').join('')
  );
  const errs = eslint.reduce((n, r) => n + r.messages.filter((m) => m.severity === 2).length, 0);
  console.log(
    `${side}: ESLint ${lintFiles.length} files, ${errs} errors; Prettier ${fmtFiles.length} files, ` +
      `${prettier.unformatted.length} unformatted, ${prettier.errors.length} parse errors ` +
      `(${Math.round((Date.now() - t0) / 1000)}s)`
  );
  if (prettier.errors.length) process.stdout.write(prettier.stderr);
}

function compare(dir) {
  const need = (name) => {
    const p = join(dir, name);
    if (!existsSync(p)) {
      console.log(
        `::error title=Lint comparison incomplete::${name} is missing, so new findings cannot be computed. See the earlier lint steps.`
      );
      process.exit(2);
    }
    return p;
  };
  const json = (name) => JSON.parse(readFileSync(need(name), 'utf8'));
  const base = json('base-eslint.json');
  const r = report({
    eslint: newEslintFindings(base, json('head-eslint.json')),
    unformatted: newEntries(
      readList(need('base-unformatted.txt')),
      readList(need('head-unformatted.txt'))
    ),
    prettierErrors: newEntries(
      readList(need('base-prettier-errors.txt')),
      readList(need('head-prettier-errors.txt'))
    ),
    baseErrorCount: base.reduce((n, f) => n + f.messages.filter((m) => m.severity === 2).length, 0),
    baseUnformattedCount: readList(need('base-unformatted.txt')).length,
  });
  for (const a of r.annotations) console.log(a);
  console.log(r.summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, r.summary);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `new=${r.total}\n`);
  return r.total > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    if (cmd === 'collect' && args.length >= 4) {
      await collect(args[0], args[1], args[2], args[3], args.includes('--existing-only'));
    } else if (cmd === 'compare' && args.length === 1) {
      process.exitCode = compare(args[0]);
    } else {
      console.error(
        'usage: lint-new-findings.mjs collect <head|base> <eslint-list> <prettier-list> <dir> [--existing-only]\n' +
          '       lint-new-findings.mjs compare <dir>'
      );
      process.exitCode = 2;
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 2;
  }
}
