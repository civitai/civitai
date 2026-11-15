#!/usr/bin/env node
// First-bad-commit bisect for the scheduled full Lint run on `main` (the `nightly-bisect` job).
//
//   node scripts/ci/nightly-bisect.mjs <reports-dir>     at HEAD, after a red scheduled run
//   node <copy>/nightly-bisect.mjs step <failed.json>    git bisect run's per-commit test
//
// Re-runs ONLY the test files that failed, across the merge commits (first parent) between the
// last green scheduled run and HEAD, with `git bisect run`. It re-runs them at HEAD first: a file
// that passes there was flaky, and a flake is not bisected. It names the first commit on which the
// files fail, in the step summary and as an annotation. It never fails the job: the red suite job
// is the verdict, this only points at a commit.
//
// The step mode is self-contained (node built-ins only) because bisect checks out older commits,
// where this file may not exist; the caller runs a copy from outside the tree.

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ARG = { unit: 'unit*', component: 'component' };

/** Failed test files per project, repo-relative, from vitest JSON reports. */
export function failedByProject(reports, root) {
  const out = { unit: new Set(), component: new Set() };
  for (const r of reports)
    for (const t of r.testResults ?? [])
      if (t.status === 'failed') {
        const f = relative(root, t.name);
        out[/\.browser\.test\.tsx$/.test(f) ? 'component' : 'unit'].add(f);
      }
  return { unit: [...out.unit].sort(), component: [...out.component].sort() };
}

/** The sha `git bisect run` printed as the first bad commit, or null. */
export function parseFirstBad(output) {
  return /^([0-9a-f]{40}) is the first bad commit/m.exec(output)?.[1] ?? null;
}

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20, ...opts }).trim();

/** Runs the failed files at the current checkout. 0 = all pass. */
function runFiles(failed) {
  for (const [project, files] of Object.entries(failed)) {
    const present = files.filter((f) => existsSync(f));
    if (!present.length) continue;
    const r = spawnSync(
      'pnpm',
      ['exec', 'vitest', 'run', '--project', PROJECT_ARG[project], '--passWithNoTests', ...present],
      { stdio: 'inherit' }
    );
    if (r.status !== 0) return 1;
  }
  return 0;
}

function step(failedJson) {
  const failed = JSON.parse(readFileSync(failedJson, 'utf8'));
  try {
    sh('git', ['submodule', 'update', '--init', '--quiet']);
    const lock = createHash('sha256').update(readFileSync('pnpm-lock.yaml')).digest('hex');
    const mark = 'node_modules/.bisect-lockfile-sha';
    if (!existsSync(mark) || readFileSync(mark, 'utf8') !== lock) {
      sh('pnpm', ['install', '--frozen-lockfile'], { stdio: 'inherit' });
      writeFileSync(mark, lock);
    }
  } catch {
    process.exit(125); // cannot build this commit: let bisect skip it
  }
  process.exit(runFiles(failed));
}

function readReports(dir) {
  const out = [];
  const visit = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) visit(p);
      else if (e.name.endsWith('.json')) out.push(JSON.parse(readFileSync(p, 'utf8')));
    }
  };
  if (existsSync(dir)) visit(dir);
  return out;
}

function report(lines, error) {
  const text = lines.join('\n');
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY)
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, `### Nightly bisect\n\n${text}\n`, {
      flag: 'a',
    });
  if (error) console.log(`::error title=Nightly first bad commit::${error}`);
}

async function main(reportsDir) {
  const root = process.cwd();
  const head = sh('git', ['rev-parse', 'HEAD']);
  const failed = failedByProject(readReports(reportsDir), root);
  const all = [...failed.unit, ...failed.component];
  if (!all.length)
    return report([
      'No failing test file in the reports (a setup step failed?): nothing to bisect.',
    ]);

  const repo = process.env.GITHUB_REPOSITORY;
  let green = '';
  try {
    green = sh('gh', [
      'api',
      `repos/${repo}/actions/workflows/lint.yml/runs?event=schedule&branch=main&status=success&per_page=1`,
      '-q',
      '.workflow_runs[0].head_sha // ""',
    ]);
  } catch (err) {
    return report([`Could not read the last green scheduled run: ${err.message}`]);
  }
  if (!green) return report(['No green scheduled run yet: nothing to bisect against.']);
  try {
    sh('git', ['merge-base', '--is-ancestor', green, head]);
  } catch {
    return report([`The last green scheduled run (${green}) is not an ancestor of ${head}.`]);
  }

  console.log(`Re-running ${all.length} failed file(s) at HEAD first.`);
  if (runFiles(failed) === 0)
    return report([
      `The ${all.length} failed file(s) pass on a re-run at HEAD: flaky, not bisected.`,
      ...all.map((f) => `- \`${f}\``),
    ]);

  const tmp = process.env.RUNNER_TEMP ?? '/tmp';
  const self = join(tmp, 'nightly-bisect.mjs');
  copyFileSync(fileURLToPath(import.meta.url), self);
  writeFileSync(join(tmp, 'failed.json'), JSON.stringify(failed));
  writeFileSync(
    join(root, 'node_modules/.bisect-lockfile-sha'),
    createHash('sha256').update(readFileSync('pnpm-lock.yaml')).digest('hex')
  );

  sh('git', ['bisect', 'start', '--first-parent', head, green]);
  let out = '';
  try {
    const r = spawnSync('git', ['bisect', 'run', 'node', self, 'step', join(tmp, 'failed.json')], {
      encoding: 'utf8',
      maxBuffer: 256 << 20,
    });
    out = `${r.stdout}\n${r.stderr}`;
    process.stdout.write(out);
  } finally {
    sh('git', ['bisect', 'reset']);
  }
  const bad = parseFirstBad(out);
  if (!bad)
    return report([
      `git bisect did not name a first bad commit between ${green} and ${head}.`,
      'Read the step log above.',
    ]);
  const subject = sh('git', ['log', '-1', '--format=%s', bad]);
  report(
    [
      `First bad commit since the last green scheduled run (${green.slice(0, 10)}): **${bad.slice(
        0,
        10
      )}** ${subject}`,
      '',
      'Failing file(s) re-run per merge commit:',
      ...all.map((f) => `- \`${f}\``),
    ],
    `${bad.slice(0, 10)} ${subject}: the first merge commit on which ${
      all.length
    } failed file(s) fail`
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [a, b] = process.argv.slice(2);
  if (a === 'step') step(b);
  else if (a) main(a).catch((err) => report([`bisect error: ${err?.stack ?? err}`]));
  else {
    console.error('usage: nightly-bisect.mjs <reports-dir> | step <failed.json>');
    process.exit(2);
  }
}
