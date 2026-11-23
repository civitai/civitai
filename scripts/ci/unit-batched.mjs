#!/usr/bin/env node
// Batched verification of the unit, component and app suites on `main`: the scheduled run, and what
// it does on red.
//
// A push to `main` runs none of the three (see lint.yml and apps.yml). Instead:
//
//   node scripts/ci/unit-batched.mjs gate <ref>
//       In unit-batched.yml, on its schedule. Dispatches lint.yml `only: unit` on <ref> unless <ref>'s
//       head is the commit the last batch run already verified (green or red). That one run is the
//       whole batch: the unit shards, the component + geometry shards, and the `batch-suites` job,
//       which dispatches every BATCH_WORKFLOWS entry (apps.yml among them) and waits for them.
//   node scripts/ci/unit-batched.mjs workflows
//       Prints the BATCH_WORKFLOWS file names, one per line, for full-ci.yml.
//   node scripts/ci/unit-batched.mjs verify <unit-result> <reports-dir> <shards> [suite]
//       (<shards> is the number of reports a complete batch must have; <suite> is a SUITES key,
//       `unit` when omitted. Every rule below is the same for each suite; only the commit status
//       context, the verify job, the workflow and the re-run's vitest projects differ.)
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
// gate skips only when a success or failure was actually POSTED there (headVerdict). The component
// and app verdicts come from the same batch and post their own contexts, but the gate reads the
// unit one only. A crashed verify job leaves `error` (its last step) or nothing, so HEAD is
// re-verified next time.
// THE BISECT'S GREEN BASE is per suite (pickBase): of the 20 newest completed runs of the suite's
// workflow on <ref> with event workflow_dispatch and actor github-actions[bot] (this run excluded),
// the newest whose verify job concluded success or failure AND whose posted verdict in the suite's
// own context, on that run's head_sha with a target_url naming that run, is `success`. The run's
// conclusion is not read: the unit and component suites share one lint.yml run, so a red component
// makes that run `failure` while its unit verdict is green, and the reverse.

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
const BOT = 'github-actions[bot]';

/**
 * The batched suites. `context`: the commit status each posts. `verifyJob`: the job name in
 * `workflow` that runs `verify` for it (the bisect base must have run it). `projects`: the vitest
 * projects the flake re-run and the bisect step run the failed files under. `browser`: the bisect
 * step installs Chromium on every commit it builds. `label`/`noun`/`article` word the statuses; the unit
 * suite's strings are the ones it has always posted.
 */
export const SUITES = {
  unit: {
    context: CONTEXT,
    verifyJob: 'Unit verified (main batch)',
    workflow: 'lint.yml',
    projects: ['unit*'],
    browser: false,
    label: 'Unit',
    noun: 'unit',
    article: 'A',
  },
  component: {
    context: 'Component tests (main batch)',
    verifyJob: 'Component verified (main batch)',
    workflow: 'lint.yml',
    projects: ['component', 'geometry'],
    browser: true,
    label: 'Component',
    noun: 'component',
    article: 'A',
  },
  apps: {
    context: 'App tests (main batch)',
    verifyJob: 'App tests verified (main batch)',
    workflow: 'apps.yml',
    projects: ['app:*'],
    browser: false,
    label: 'App',
    noun: 'app',
    article: 'An',
  },
};

/** The suite descriptor for a SUITES key; throws on an unknown one rather than verify the unit. */
export function suiteOf(key = 'unit') {
  const s = SUITES[key];
  if (!s) throw new Error(`unknown suite: ${key} (one of ${Object.keys(SUITES).join(', ')})`);
  return s;
}

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
  suite = SUITES.unit,
}) {
  const { label, noun, article } = suite;
  if (unitResult === 'success')
    return { sha: head, state: 'success', description: `${label} suite passed at this commit.` };
  // The suite did not finish (cancelled or skipped): no verdict, so `error` and a re-verify.
  if (unitResult !== 'failure')
    return {
      sha: head,
      state: 'error',
      description: `${label} suite did not finish (${unitResult}); the next batch run re-verifies.`,
    };
  // A shard with no report (timeout, setup) or a red the failed files do not explain: the listed
  // files are not the whole story, so neither a flake nor a bisect of them is a verdict. It is
  // infrastructure, not the suite failing, so `error`: the gate re-verifies HEAD next time.
  if (incomplete)
    return {
      sha: head,
      state: 'error',
      description: `Not every ${noun} shard reported, or a shard failed outside its test files. Re-verified next batch.`,
    };
  if (!failed.length)
    return {
      sha: head,
      state: 'failure',
      description: `${article} ${noun} shard failed with no failing test file (setup or timeout). See the run.`,
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

/**
 * The other suites of the main batch. lint.yml's `batch-suites` job (on the batch dispatch above)
 * dispatches each on `main` with `batch: true` when a path in its workflow's `on.pull_request.paths`
 * (else `on.push.paths`) changed since the last green batch, waits for them, and posts their
 * verdict as the `Batch suites (main batch)` commit status (scripts/ci/batch-suites.mjs). One
 * entry per line. `ownContext`: the workflow posts its own `(main batch)` status instead; the batch
 * job still dispatches it and waits for that status, leaves it out of its own verdict, and re-posts
 * it on this commit with the lint batch run as its target_url (batch-suites.mjs repostStatuses).
 *
 * THE ONE LIST of the batch's other suites: lint.yml's `batch-suites` job dispatches from it, and
 * full-ci.yml reads it (`node scripts/ci/unit-batched.mjs workflows`) to dispatch the same suites
 * on a labelled PR, ready or draft, since no PR run of theirs covers them. Change it here only.
 */
export const BATCH_WORKFLOWS = [
  { workflow: 'moderator-boot.yml' },
  { workflow: 'ports.yml' },
  { workflow: 'registry-adapter-image.yml' },
  { workflow: 'storage-hook-runner-image.yml' },
  { workflow: 'windows-dev-env.yml' },
  { workflow: 'feed-go.yml' },
  { workflow: 'beacon-go.yml' },
  { workflow: 'app-index-go.yml' },
  { workflow: 'app-data-go.yml' },
  { workflow: 'content-policy-go.yml' },
  { workflow: 'apps.yml', ownContext: 'App tests (main batch)' },
];

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

/** Recent bot-dispatched runs of <workflow> on <ref>, newest first (the gate's dispatches). */
function botRuns(ref, status, workflow = 'lint.yml') {
  const q = new URLSearchParams({
    branch: ref,
    event: 'workflow_dispatch',
    actor: BOT,
    per_page: '20',
  });
  if (status) q.set('status', status);
  const runs = JSON.parse(
    gh('api', `repos/${repo()}/actions/workflows/${workflow}/runs?${q}`, '-q', '.workflow_runs')
  );
  return runs.filter((r) => String(r.id) !== process.env.GITHUB_RUN_ID);
}

/**
 * The verdict a batch run posted for <suite>: the newest status in the suite's context among
 * `statuses` (newest first, the commit's list) whose target_url names this run; null when none.
 */
export function postedVerdict(run, statuses, suite = SUITES.unit) {
  const suffix = `/actions/runs/${run.id}`;
  return (
    (statuses ?? []).find(
      (s) => s.context === suite.context && (s.target_url ?? '').replace(/\/$/, '').endsWith(suffix)
    )?.state ?? null
  );
}

/**
 * The bisect base for <suite>, pure: `candidates` are newest-first [{ run, jobs, statuses }]
 * (`jobs`/`statuses` may be functions, read lazily). The newest completed run whose verify job
 * concluded success or failure and whose posted verdict for THIS suite is `success`. The run's
 * own conclusion is never read (see the header): another suite in the same run being red does not
 * move this suite's base. Returns the run or null.
 */
export function pickBase(candidates, suite = SUITES.unit) {
  const val = (v) => (typeof v === 'function' ? v() : v);
  for (const c of candidates) {
    if (c.run.status !== 'completed') continue;
    const v = (val(c.jobs) ?? []).find((j) => j.name === suite.verifyJob);
    if (!v || !['success', 'failure'].includes(v.conclusion)) continue;
    if (postedVerdict(c.run, val(c.statuses), suite) === 'success') return c.run;
  }
  return null;
}

/** The last green verified run of <suite> on <ref> (pickBase over the API). */
function lastGreenRun(ref, suite = SUITES.unit) {
  const candidates = botRuns(ref, 'completed', suite.workflow).map((run) => ({
    run,
    jobs: () =>
      JSON.parse(
        gh('api', `repos/${repo()}/actions/runs/${run.id}/jobs?per_page=100`, '-q', '.jobs')
      ),
    statuses: () =>
      JSON.parse(gh('api', `repos/${repo()}/commits/${run.head_sha}/statuses?per_page=100`)),
  }));
  return pickBase(candidates, suite);
}

function summary(lines, suite = SUITES.unit) {
  const text = lines.join('\n');
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY)
    writeFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### ${suite.label} suite, main batch\n\n${text}\n`,
      { flag: 'a' }
    );
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

/** The vitest argv that re-runs <files> under <suite>'s projects. */
export function rerunArgs(files, suite = SUITES.unit) {
  return [
    'exec',
    'vitest',
    'run',
    ...suite.projects.flatMap((p) => ['--project', p]),
    '--passWithNoTests',
    ...files,
  ];
}

/** Runs the failed files at the current checkout. 0 = all pass. */
function runFiles(files, suite = SUITES.unit) {
  const present = files.filter((f) => existsSync(f));
  if (!present.length) return 0;
  return spawnSync('pnpm', rerunArgs(present, suite), { stdio: 'inherit' }).status === 0 ? 0 : 1;
}

// What an install depends on: the lockfile, and the Prisma schema the postinstall generates from.
const SCHEMA = 'packages/civitai-db-schema/prisma/schema.full.prisma';
const lockHash = () => {
  const h = createHash('sha256').update(readFileSync('pnpm-lock.yaml'));
  if (existsSync(SCHEMA)) h.update(readFileSync(SCHEMA));
  return h.digest('hex');
};
const LOCK_MARK = 'node_modules/.bisect-install-sha';

/**
 * What `step` reads from failed.json: a bare array is the unit suite (the form bisect always wrote
 * for it), `{ suite, files }` any other.
 */
export function stepInput(payload) {
  if (Array.isArray(payload)) return { suite: SUITES.unit, files: payload };
  return { suite: suiteOf(payload.suite), files: payload.files ?? [] };
}

function step(failedJson) {
  const { suite, files } = stepInput(JSON.parse(readFileSync(failedJson, 'utf8')));
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
    // The Chromium revision this commit's playwright wants (a no-op when it is already there).
    // The system libraries were installed once, by the verify job.
    if (suite.browser) {
      const r = spawnSync('pnpm', ['exec', 'playwright', 'install', 'chromium'], {
        stdio: 'inherit',
      });
      if (r.status !== 0) throw new Error('playwright install failed');
    }
  } catch {
    process.exit(125); // cannot build this commit: let bisect skip it
  }
  process.exit(runFiles(files, suite));
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

function bisect(green, head, failed, suite = SUITES.unit) {
  const tmp = process.env.RUNNER_TEMP ?? '/tmp';
  const self = join(tmp, 'unit-batched.mjs');
  copyFileSync(fileURLToPath(import.meta.url), self);
  const key = Object.keys(SUITES).find((k) => SUITES[k] === suite);
  writeFileSync(
    join(tmp, 'failed.json'),
    JSON.stringify(suite === SUITES.unit ? failed : { suite: key, files: failed })
  );
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

function post(target, suite = SUITES.unit) {
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
    `context=${suite.context}`,
    '-f',
    `description=${target.description}`,
    '-f',
    `target_url=${url}`
  );
}

function verify(unitResult, reportsDir, shards, suiteKey = 'unit') {
  const suite = suiteOf(suiteKey);
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
      `Only ${reports.length} of ${shards} ${suite.noun} report(s), or a red no test file explains: not bisected.`
    );
  if (failed.length && !incomplete) {
    lines.push(`${failed.length} failed file(s):`, ...failed.map((f) => `- \`${f}\``), '');
    console.log('Re-running the failed files at HEAD first.');
  }
  const kind = classifyRed({
    unitResult,
    failed,
    incomplete,
    flaky: (f) => isFlaky(f, { runner: (files) => runFiles(files, suite) }),
  });
  const flaky = kind === 'flaky';
  if (kind === 'flaky' || kind === 'bisect') {
    if (flaky) {
      lines.push(
        `**Flaky:** they pass on a re-run at HEAD, so this is not bisected: ${failed.join(', ')}`
      );
      console.log(
        `::warning title=Flaky ${
          suite.noun
        } tests (main batch)::Failed in the batch run, passed on a re-run at HEAD: ${failed.join(
          ', '
        )}`
      );
    } else {
      let green = null;
      try {
        green = lastGreenRun(ref, suite)?.head_sha ?? null;
      } catch (err) {
        lines.push(`Could not read the last green verified commit: ${err.message.split('\n')[0]}`);
      }
      if (!green) lines.push('No green verified commit to bisect from.');
      else {
        try {
          sh('git', ['merge-base', '--is-ancestor', green, head]);
          firstBad = bisect(green, head, failed, suite);
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
  const targets = statusTargets({ unitResult, head, failed, flaky, firstBad, incomplete, suite });
  // Summary first: a POST that fails below crashes the job, and the crash step then posts
  // `error` on HEAD, which the gate reads as "not verified".
  for (const t of targets)
    lines.push(
      `Posting \`${suite.context}\` = ${t.state} on ${t.sha.slice(0, 10)}: ${t.description}`
    );
  summary(lines.length ? lines : [`${suite.noun} result: ${unitResult}; nothing posted.`], suite);
  for (const t of targets) {
    post(t, suite);
    if (t.state === 'failure')
      console.log(
        `::error title=${suite.label} suite red (main batch)::${t.sha.slice(0, 10)}: ${
          t.description
        }`
      );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, a, b, c, d] = process.argv.slice(2);
  if (cmd === 'gate') gate(a);
  // One BATCH_WORKFLOWS file name per line, for full-ci.yml.
  else if (cmd === 'workflows') console.log(BATCH_WORKFLOWS.map((e) => e.workflow).join('\n'));
  else if (cmd === 'verify') verify(a, b, c, d);
  else if (cmd === 'step') step(a);
  else {
    console.error(
      'usage: unit-batched.mjs gate <ref> | workflows | verify <result> <reports-dir> <shards> [suite] | step <failed.json>'
    );
    process.exit(2);
  }
}
