#!/usr/bin/env node
/**
 * Which suites of a full-ci Lint dispatch has the pull_request Lint run on the SAME COMMIT
 * already passed? `.github/workflows/lint.yml` (the `passed` job, `skip_passed` input) skips
 * those suites in the dispatch, so the dispatch runs only what the PR run does not: the unit
 * shards, the `Typecheck (main pushes / fork PRs / non-main base)` job and geometry as a blocking
 * verdict.
 *
 * A suite is skipped only on a SUCCESS that already exists. Per job name, across every
 * pull_request Lint run whose head SHA is the dispatch's (each run's latest attempt):
 *
 *   run    some instance failed (or timed out, or any conclusion that is not success, cancelled
 *          or skipped), or every instance was cancelled or skipped: nothing to reuse.
 *   wait   some instance has not finished, or a run that is still going does not list the job
 *          yet (the jobs API lists a matrix job's expanded names, and a `needs` job, only once
 *          they start), even if another, finished run lists it.
 *   skip   no failure, nothing pending, and at least one success.
 *
 * A suite is `run` if any of its jobs is, `wait` if any is, else `skip`. The script polls while
 * any suite is `wait`, up to a deadline; what is still `wait` then runs. Any API error, and any
 * other exception, means run everything: it writes no outputs and exits 0, so the dispatch is
 * never worse than it was before this script existed.
 *
 * Usage (in a workflow step):
 *   GH_TOKEN=... GITHUB_REPOSITORY=o/r SHA=<sha> node scripts/ci/lint-dispatch-passed.mjs
 * Writes `<suite>=true` to $GITHUB_OUTPUT for each suite to skip, and a summary.
 */
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Output name -> the PR run's job names that must all have passed. */
export const SUITES = {
  typecheck_tests: ['Typecheck test files (ratchet)'],
  packages: ['Package unit tests'],
  // The shards and their ledger. Geometry rides on shard 1 but is report-only on a PR, so a
  // green shard 1 says nothing about it: lint.yml still runs geometry when this one is skipped.
  component: [
    'Component + geometry tests (1/3)',
    'Component + geometry tests (2/3)',
    'Component + geometry tests (3/3)',
    'Component + geometry tests',
  ],
};

const NO_EVIDENCE = new Set(['cancelled', 'skipped']);

/**
 * @param {Array<{ status?: string; conclusion?: string | null }>} instances jobs with one name
 * @param {boolean} unlisted a same-commit PR run that has not finished does not list this name
 * @returns {'run' | 'wait' | 'skip'}
 */
export function decideJob(instances, unlisted) {
  const done = instances.filter((j) => j.status === 'completed');
  if (done.some((j) => j.conclusion !== 'success' && !NO_EVIDENCE.has(j.conclusion ?? '')))
    return 'run';
  if (unlisted || done.length < instances.length) return 'wait';
  if (done.some((j) => j.conclusion === 'success')) return 'skip';
  return 'run';
}

/**
 * @param {Array<{ status?: string; jobs: Array<{ name?: string; status?: string; conclusion?: string | null }> }>} runs
 *   every same-commit pull_request Lint run, with its latest attempt's jobs
 * @returns {Record<keyof typeof SUITES, 'run' | 'wait' | 'skip'>}
 */
export function decide(runs) {
  /** @type {Record<string, 'run' | 'wait' | 'skip'>} */
  const out = {};
  for (const [suite, names] of Object.entries(SUITES)) {
    const per = names.map((n) =>
      decideJob(
        runs.flatMap((r) => r.jobs.filter((j) => j.name === n)),
        runs.some((r) => r.status !== 'completed' && !r.jobs.some((j) => j.name === n))
      )
    );
    out[suite] = per.includes('run') ? 'run' : per.includes('wait') ? 'wait' : 'skip';
  }
  return /** @type {Record<keyof typeof SUITES, 'run' | 'wait' | 'skip'>} */ (out);
}

/**
 * Poll until no suite is `wait` or the deadline passes. `wait` at the deadline becomes `run`.
 * Throws on an API error; the caller turns that into "run everything".
 *
 * @param {{
 *   fetchJson: (path: string) => Promise<any>;
 *   sleep: (ms: number) => Promise<void>;
 *   now: () => number;
 *   repo: string;
 *   sha: string;
 *   maxWaitMs: number;
 *   pollMs: number;
 * }} o
 */
export async function findPassed(o) {
  const deadline = o.now() + o.maxWaitMs;
  for (;;) {
    const list = await o.fetchJson(
      `repos/${o.repo}/actions/workflows/lint.yml/runs?event=pull_request&head_sha=${o.sha}&per_page=20`
    );
    const runs = (list?.workflow_runs ?? []).filter((r) => r?.head_sha === o.sha);
    const withJobs = [];
    for (const r of runs) {
      const body = await o.fetchJson(
        `repos/${o.repo}/actions/runs/${r.id}/jobs?filter=latest&per_page=100`
      );
      if (!Array.isArray(body?.jobs)) throw new Error(`no jobs array for run ${r.id}`);
      withJobs.push({ status: r.status, jobs: body.jobs });
    }
    const decisions = decide(withJobs);
    const waiting = Object.values(decisions).includes('wait');
    if (!waiting || o.now() >= deadline) {
      for (const k of Object.keys(decisions)) if (decisions[k] === 'wait') decisions[k] = 'run';
      return { decisions, runs: runs.map((r) => r.id) };
    }
    await o.sleep(Math.min(o.pollMs, Math.max(0, deadline - o.now())));
  }
}

/**
 * The suites to skip. Fails open: a malformed repo or SHA, an API error or any other exception
 * returns no suites, so everything runs.
 *
 * @param {Parameters<typeof findPassed>[0]} o
 * @returns {Promise<{ skip: string[]; decisions?: Record<string, string>; runs?: number[]; error?: string }>}
 */
export async function suitesToSkip(o) {
  try {
    if (!/^[\w.-]+\/[\w.-]+$/.test(o.repo) || !/^[0-9a-f]{40}$/.test(o.sha))
      throw new Error(`bad repository or SHA: '${o.repo}' '${o.sha}'`);
    const { decisions, runs } = await findPassed(o);
    const skip = Object.keys(decisions).filter((k) => decisions[k] === 'skip');
    return { skip, decisions, runs };
  } catch (err) {
    return { skip: [], error: String(err) };
  }
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY ?? '';
  const sha = process.env.SHA ?? '';
  const api = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  const token = process.env.GH_TOKEN ?? '';
  const summary = (line) => {
    console.log(line);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  };
  const result = await suitesToSkip({
    repo,
    sha,
    maxWaitMs: Number(process.env.MAX_WAIT_S ?? 600) * 1000,
    pollMs: Number(process.env.POLL_S ?? 30) * 1000,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    fetchJson: async (path) => {
      const res = await fetch(`${api}/${path}`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
        },
      });
      if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
      return res.json();
    },
  });
  if (result.error) {
    console.log(`::warning title=Every suite runs::reading the PR run failed: ${result.error}`);
    summary('### Every suite runs: reading the PR run on this commit failed');
    return;
  }
  if (process.env.GITHUB_OUTPUT)
    for (const k of result.skip) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=true\n`);
  const links = (result.runs ?? [])
    .map((id) => `https://github.com/${repo}/actions/runs/${id}`)
    .join(', ');
  summary(`### Suites the pull_request Lint run on \`${sha}\` already passed`);
  summary(`PR runs read: ${links || 'none'}`);
  for (const [k, v] of Object.entries(result.decisions ?? {}))
    summary(`- ${k}: ${v === 'skip' ? 'passed there, skipped here' : 'runs here'}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
