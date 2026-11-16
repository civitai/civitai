#!/usr/bin/env node
// Batched verification of the unit suite on `main`: the scheduled run, and what it does on red.
//
// A push to `main` does not run the `Unit tests` job (see lint.yml). Instead:
//
//   node scripts/ci/unit-batched.mjs gate <ref>
//       In unit-batched.yml, on its schedule. Dispatches lint.yml `only: unit` on <ref> unless <ref>'s
//       head is the commit the last batch run already verified (green or red).
//   node scripts/ci/unit-batched.mjs verify <unit-result> <reports-dir> <shards>
//       (<shards> is the number of shard reports a complete batch must have.)
//       In lint.yml's `unit-verify` job, after the shards of that dispatched run. Green: a success
//       status on HEAD. Red: re-runs the failed files at HEAD (a pass = flaky: a success on HEAD
//       whose description names the flaky files, plus a warning annotation), then
//       `git bisect run --first-parent` back to the last green verified commit, and posts a
//       failure status on the first bad commit, or on HEAD when the bisect cannot isolate one.
//   node <copy>/unit-batched.mjs step <failed.json>
//       git bisect run's per-commit test. Node built-ins only: bisect checks out older commits,
//       where this file may not exist, so the caller runs a copy from outside the tree.
//
// THE RECORD of what was verified is the `Unit tests (main batch)` commit status on HEAD: the
// gate skips only when a success or failure was actually POSTED there (headVerdict). A crashed
// verify job leaves `error` (its last step) or nothing, so HEAD is re-verified next time.
// The bisect's green base comes from the run list: of the 20 newest lint.yml runs on <ref> with
// event workflow_dispatch and actor github-actions[bot] that concluded success (this run
// excluded), the newest whose `Unit verified (main batch)` job concluded success or failure.
// Its head_sha is the base. The `only` input is not filtered on; the run list does not carry it.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONTEXT = 'Unit tests (main batch)';
const VERIFY_JOB = 'Unit verified (main batch)';
const BOT = 'github-actions[bot]';

/**
 * The verdict a batch run POSTED on a commit: the state of the newest `Unit tests (main batch)`
 * status in `statuses` (the API lists newest first), or null when there is none.
 */
export function headVerdict(statuses) {
  return statuses.find((s) => s.context === CONTEXT)?.state ?? null;
}

/**
 * Should the batch gate dispatch a run? HEAD counts as verified only when a verdict (success or
 * failure) was actually posted on it; `error` is what a crashed verification leaves. Fails OPEN:
 * an unreadable record means run.
 */
export function decideRun({ head, headState, inProgress = false, error }) {
  if (error) return { run: true, reason: `could not read the verdict on HEAD (${error})` };
  if (inProgress)
    return { run: false, reason: 'a batch verification run is still queued or running' };
  if (headState === 'success' || headState === 'failure')
    return {
      run: false,
      reason: `HEAD ${head.slice(0, 10)} already has a posted verdict (${headState})`,
    };
  return {
    run: true,
    reason: `HEAD ${head.slice(0, 10)} has no posted verdict (${headState ?? 'none'})`,
  };
}

/** One commit status line, at most GitHub's 140 characters. */
export function statusLine(prefix, files) {
  let d = `${prefix}${files.join(', ')}`;
  if (d.length > 140) d = `${d.slice(0, 137)}...`;
  return d;
}

/**
 * Where the verdict goes. Returns { sha, state, description } or null (nothing to post).
 * @param unitResult  the `unit` job's result: success | failure | cancelled | skipped
 * @param failed      failed test files from the reports
 * @param flaky       the failed files passed on a re-run at HEAD
 * @param firstBad    the commit git bisect named, or null
 */
export function statusTarget({
  unitResult,
  head,
  failed = [],
  flaky = false,
  firstBad = null,
  incomplete = false,
}) {
  if (unitResult === 'success')
    return { sha: head, state: 'success', description: 'Unit suite passed at this commit.' };
  // The suite did not finish (cancelled or skipped): no verdict, so `error` and a re-verify.
  if (unitResult !== 'failure')
    return {
      sha: head,
      state: 'error',
      description: `Unit suite did not finish (${unitResult}); the next batch run re-verifies.`,
    };
  // A shard with no report (timeout, setup) or a red the failed files do not explain: the listed
  // files are not the whole story, so neither a flake nor a bisect of them is a verdict. It is
  // infrastructure, not the suite failing, so `error`: the gate re-verifies HEAD next time.
  if (incomplete)
    return {
      sha: head,
      state: 'error',
      description:
        'Not every unit shard reported, or a shard failed outside its test files. Re-verified next batch.',
    };
  if (!failed.length)
    return {
      sha: head,
      state: 'failure',
      description: 'A unit shard failed with no failing test file (setup or timeout). See the run.',
    };
  // A flake is not the commit's fault, so HEAD gets a success, but never a bare one: the
  // description always leads with the note and names the flaky files.
  if (flaky)
    return {
      sha: head,
      state: 'success',
      description: statusLine('Passed on re-run; flaky: ', failed),
    };
  if (firstBad)
    return {
      sha: firstBad,
      state: 'failure',
      description: statusLine(`First bad commit. ${failed.length} failing file(s): `, failed),
    };
  return {
    sha: head,
    state: 'failure',
    description: statusLine(`Bisect could not isolate the commit; failing here: `, failed),
  };
}

/**
 * Every status a verdict posts. A bisected red also goes on HEAD, pointing at the first bad
 * commit: HEAD is still failing, and the HEAD status is the gate's record that HEAD was verified.
 */
export function statusTargets(args) {
  const t = statusTarget(args);
  if (!t) return [];
  if (t.sha === args.head) return [t];
  return [
    t,
    {
      sha: args.head,
      state: 'failure',
      description: statusLine(
        `Failing since first bad commit ${t.sha.slice(0, 10)}: `,
        args.failed
      ),
    },
  ];
}

/** Failed unit test files, repo-relative, from vitest JSON reports. */
export function failedFiles(reports, root) {
  const out = new Set();
  for (const r of reports)
    for (const t of r.testResults ?? []) if (t.status === 'failed') out.add(relative(root, t.name));
  return [...out].sort();
}

/**
 * Did the reports account for the whole red? False when fewer reports arrived than shards ran,
 * or a report is red (`success: false`) without a single failed test file in it.
 */
export function reportsComplete(reports, shards) {
  if (reports.length < shards) return false;
  return reports.every(
    (r) => r.success !== false || (r.testResults ?? []).some((t) => t.status === 'failed')
  );
}

/** The sha `git bisect run` printed as the first bad commit, or null. */
export function parseFirstBad(output) {
  // Newer git quotes the term (`is the first 'bad' commit`); older git does not. Accept both.
  return /^([0-9a-f]{40}) is the first '?bad'? commit/m.exec(output)?.[1] ?? null;
}

const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20, ...opts }).trim();
const gh = (...args) => sh('gh', args);
const repo = () => process.env.GITHUB_REPOSITORY;

/** What the gate dispatches: this workflow, with this value for its `only` input. */
export const DISPATCH = { workflow: 'lint.yml', only: 'unit' };

/** The exact `gh` argv the gate runs to dispatch the batch on <ref>. */
export function dispatchArgs(ref, repoName) {
  return [
    'workflow',
    'run',
    DISPATCH.workflow,
    '--repo',
    repoName,
    '--ref',
    ref,
    '-f',
    `only=${DISPATCH.only}`,
  ];
}

/** Recent bot-dispatched lint.yml runs on <ref>, newest first (the gate's only dispatches). */
function botRuns(ref, status) {
  const q = new URLSearchParams({
    branch: ref,
    event: 'workflow_dispatch',
    actor: BOT,
    per_page: '20',
  });
  if (status) q.set('status', status);
  const runs = JSON.parse(
    gh('api', `repos/${repo()}/actions/workflows/lint.yml/runs?${q}`, '-q', '.workflow_runs')
  );
  return runs.filter((r) => String(r.id) !== process.env.GITHUB_RUN_ID);
}

/**
 * The newest finished run whose verify job actually RAN (success or failure). A skipped verify
 * job is listed too, so its presence alone proves nothing.
 */
function lastVerifiedRun(ref, { green = false } = {}) {
  for (const run of botRuns(ref, green ? 'success' : undefined)) {
    if (run.status !== 'completed') continue;
    if (!['success', 'failure'].includes(run.conclusion)) continue;
    const jobs = JSON.parse(
      gh('api', `repos/${repo()}/actions/runs/${run.id}/jobs?per_page=50`, '-q', '.jobs')
    );
    const v = jobs.find((j) => j.name === VERIFY_JOB);
    if (v && ['success', 'failure'].includes(v.conclusion)) return run;
  }
  return null;
}

function summary(lines) {
  const text = lines.join('\n');
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY)
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, `### Unit suite, main batch\n\n${text}\n`, {
      flag: 'a',
    });
}

function gate(ref) {
  const head = gh('api', `repos/${repo()}/commits/${ref}`, '-q', '.sha');
  let headState = null;
  let inProgress = false;
  let error = null;
  try {
    // A run still going is not re-dispatched: in its concurrency group a new dispatch would
    // cancel it, and a red one is the long one (unit, then the bisect).
    inProgress = botRuns(ref).some((r) => r.status !== 'completed');
    headState = headVerdict(
      JSON.parse(gh('api', `repos/${repo()}/commits/${head}/statuses?per_page=100`))
    );
  } catch (err) {
    error = String(err.message).split('\n')[0];
  }
  const d = decideRun({ head, headState, inProgress, error });
  summary([`${d.run ? 'Dispatching' : 'Skipped'}: ${d.reason}.`]);
  if (d.run) gh(...dispatchArgs(ref, repo()));
}

/**
 * Is a red a flake? Only when there were failed files, every one still exists, and the re-run of
 * them all passes (runner returns 0). The one place a red becomes a success, so it is strict.
 */
export function isFlaky(failed, { exists = existsSync, runner = runFiles } = {}) {
  if (!failed.length) return false;
  if (!failed.every((f) => exists(f))) return false;
  return runner(failed) === 0;
}

/**
 * What verify does with a batch red: 'incomplete' (error on HEAD, no re-run), 'flaky' (success on
 * HEAD with the note), or 'bisect'. A green or unfinished unit result is 'none'. verify() acts on
 * exactly this value, so the decision it makes is the one tested here.
 */
export function classifyRed({ unitResult, failed, incomplete, flaky = isFlaky }) {
  if (unitResult !== 'failure') return 'none';
  if (incomplete) return 'incomplete';
  if (!failed.length) return 'none';
  return flaky(failed) ? 'flaky' : 'bisect';
}

/** Runs the failed files at the current checkout. 0 = all pass. */
function runFiles(files) {
  const present = files.filter((f) => existsSync(f));
  if (!present.length) return 0;
  return spawnSync(
    'pnpm',
    ['exec', 'vitest', 'run', '--project', 'unit*', '--passWithNoTests', ...present],
    { stdio: 'inherit' }
  ).status === 0
    ? 0
    : 1;
}

// What an install depends on: the lockfile, and the Prisma schema the postinstall generates from.
const SCHEMA = 'packages/civitai-db-schema/prisma/schema.full.prisma';
const lockHash = () => {
  const h = createHash('sha256').update(readFileSync('pnpm-lock.yaml'));
  if (existsSync(SCHEMA)) h.update(readFileSync(SCHEMA));
  return h.digest('hex');
};
const LOCK_MARK = 'node_modules/.bisect-install-sha';

function step(failedJson) {
  try {
    sh('git', ['submodule', 'update', '--init', '--quiet']);
    if (!existsSync(LOCK_MARK) || readFileSync(LOCK_MARK, 'utf8') !== lockHash()) {
      // Marker first removed, then written only after a SUCCESSFUL install: a failed one must
      // not leave a marker claiming node_modules matches this commit.
      rmSync(LOCK_MARK, { force: true });
      const r = spawnSync('pnpm', ['install', '--frozen-lockfile'], { stdio: 'inherit' });
      if (r.status !== 0) throw new Error('pnpm install failed');
      writeFileSync(LOCK_MARK, lockHash());
    }
  } catch {
    process.exit(125); // cannot build this commit: let bisect skip it
  }
  process.exit(runFiles(JSON.parse(readFileSync(failedJson, 'utf8'))));
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

function bisect(green, head, failed) {
  const tmp = process.env.RUNNER_TEMP ?? '/tmp';
  const self = join(tmp, 'unit-batched.mjs');
  copyFileSync(fileURLToPath(import.meta.url), self);
  writeFileSync(join(tmp, 'failed.json'), JSON.stringify(failed));
  writeFileSync(LOCK_MARK, lockHash());
  sh('git', ['bisect', 'start', '--first-parent', head, green]);
  try {
    const r = spawnSync('git', ['bisect', 'run', 'node', self, 'step', join(tmp, 'failed.json')], {
      encoding: 'utf8',
      maxBuffer: 256 << 20,
    });
    const out = `${r.stdout}\n${r.stderr}`;
    process.stdout.write(out);
    return parseFirstBad(out);
  } finally {
    sh('git', ['bisect', 'reset']);
  }
}

function post(target) {
  const url = `${process.env.GITHUB_SERVER_URL}/${repo()}/actions/runs/${
    process.env.GITHUB_RUN_ID
  }`;
  gh(
    'api',
    '-X',
    'POST',
    `repos/${repo()}/statuses/${target.sha}`,
    '-f',
    `state=${target.state}`,
    '-f',
    `context=${CONTEXT}`,
    '-f',
    `description=${target.description}`,
    '-f',
    `target_url=${url}`
  );
}

function verify(unitResult, reportsDir, shards) {
  const root = process.cwd();
  const head = sh('git', ['rev-parse', 'HEAD']);
  const ref = process.env.GITHUB_REF_NAME;
  const reports = unitResult === 'failure' ? readReports(reportsDir) : [];
  const failed = failedFiles(reports, root);
  const incomplete = unitResult === 'failure' && !reportsComplete(reports, Number(shards));
  const lines = [];
  let firstBad = null;
  if (incomplete)
    lines.push(
      `Only ${reports.length} of ${shards} unit report(s), or a red no test file explains: not bisected.`
    );
  if (failed.length && !incomplete) {
    lines.push(`${failed.length} failed file(s):`, ...failed.map((f) => `- \`${f}\``), '');
    console.log('Re-running the failed files at HEAD first.');
  }
  const kind = classifyRed({ unitResult, failed, incomplete });
  const flaky = kind === 'flaky';
  if (kind === 'flaky' || kind === 'bisect') {
    if (flaky) {
      lines.push(
        `**Flaky:** they pass on a re-run at HEAD, so this is not bisected: ${failed.join(', ')}`
      );
      console.log(
        `::warning title=Flaky unit tests (main batch)::Failed in the batch run, passed on a re-run at HEAD: ${failed.join(
          ', '
        )}`
      );
    } else {
      let green = null;
      try {
        green = lastVerifiedRun(ref, { green: true })?.head_sha ?? null;
      } catch (err) {
        lines.push(`Could not read the last green verified commit: ${err.message.split('\n')[0]}`);
      }
      if (!green) lines.push('No green verified commit to bisect from.');
      else {
        try {
          sh('git', ['merge-base', '--is-ancestor', green, head]);
          firstBad = bisect(green, head, failed);
          lines.push(
            firstBad
              ? `First bad commit since ${green.slice(0, 10)}: **${firstBad.slice(0, 10)}** ${sh(
                  'git',
                  ['log', '-1', '--format=%s', firstBad]
                )}`
              : `git bisect named no first bad commit between ${green.slice(0, 10)} and HEAD.`
          );
        } catch (err) {
          lines.push(
            `Bisect from ${green.slice(0, 10)} did not run: ${String(err.message).split('\n')[0]}`
          );
        }
      }
    }
  }
  const targets = statusTargets({ unitResult, head, failed, flaky, firstBad, incomplete });
  // Summary first: a POST that fails below crashes the job, and the crash step then posts
  // `error` on HEAD, which the gate reads as "not verified".
  for (const t of targets)
    lines.push(`Posting \`${CONTEXT}\` = ${t.state} on ${t.sha.slice(0, 10)}: ${t.description}`);
  summary(lines.length ? lines : [`unit result: ${unitResult}; nothing posted.`]);
  for (const t of targets) {
    post(t);
    if (t.state === 'failure')
      console.log(
        `::error title=Unit suite red (main batch)::${t.sha.slice(0, 10)}: ${t.description}`
      );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, a, b, c] = process.argv.slice(2);
  if (cmd === 'gate') gate(a);
  else if (cmd === 'verify') verify(a, b, c);
  else if (cmd === 'step') step(a);
  else {
    console.error(
      'usage: unit-batched.mjs gate <ref> | verify <unit-result> <reports-dir> <shards> | step <failed.json>'
    );
    process.exit(2);
  }
}
