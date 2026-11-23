#!/usr/bin/env node
// The main batch's OTHER suites: dispatch them on `main`, wait, post one verdict.
//
//   node scripts/ci/batch-suites.mjs run
//       In lint.yml's `batch-suites` job, on the batch dispatch on `main` (unit-batched.yml's gate
//       dispatches lint.yml `only: unit` as github-actions[bot]). For each workflow in
//       BATCH_WORKFLOWS (scripts/ci/unit-batched.mjs) whose paths changed since the last green
//       batch, dispatches it on `main` with `batch: true`, waits for its run at this commit, and
//       posts the `Batch suites (main batch)` commit status on this commit, its target_url this
//       lint run:
//         success  every dispatched suite's run concluded success (or nothing needed to run:
//                  no suite's paths changed since a commit where every suite was green);
//         failure  some run concluded failure / timed_out / startup_failure; the description
//                  names them and the commit range starts at the last green batch;
//         error    a suite was not dispatched, its run was never found at this commit, or it
//                  did not finish (cancelled, still running at the deadline): no verdict, so it
//                  reads as undecided, never as green.
//
// NOTHING IS BISECTED HERE. A red names the suites and the range (last green batch .. this
// commit); the CI-watch item it opens carries that range, and whoever holds the item bisects.
//
// WHY THIS JOB DISPATCHES, AND NOT THE GATE: it must know exactly what it dispatched to wait for
// it, and it runs in the lint.yml batch run, whose head commit is the one CI-watch reads the
// statuses of. That run completes only after this job posted, so the status is there when the
// run is read.
//
// PATH FILTER. A suite runs when a file changed between the BASE and this commit matches its
// workflow's `on.pull_request.paths`, else `on.push.paths` (GitHub's filter semantics: in order,
// the last matching pattern decides, `!` negates). The BASE is the head commit of the newest
// earlier batch run whose `Batch suites (main batch)` verdict was posted (success or failure):
// a success makes it the base, a failure means there is none. No base, a compare that cannot
// list every file, a pattern this matcher does not understand, or a workflow with no paths all
// mean RUN: the filter only ever skips a suite whose inputs provably did not change since a
// commit where it was green.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BATCH_WORKFLOWS, statusLine } from './unit-batched.mjs';

export const SUITES_CONTEXT = 'Batch suites (main batch)';
const BOT = 'github-actions[bot]';
const RED = new Set(['failure', 'timed_out', 'startup_failure']);
// The compare API lists at most 300 files; at that count the list may be cut short.
const COMPARE_FILE_CAP = 300;

const short = (wf) => wf.replace(/\.ya?ml$/, '');

/**
 * One GitHub filter pattern as a RegExp over a repo-relative path, or null when it uses syntax
 * this matcher does not implement (`?`, `+`, `[]`, `{}`): the caller treats null as a match.
 * `**` matches any characters, `*` any characters but `/`.
 */
export function globToRegExp(pattern) {
  if (/[?+[\]{}]/.test(pattern)) return null;
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      re += '.*';
      i++;
    } else if (c === '*') re += '[^/]*';
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Does any of `files` pass the `paths` filter? Fails OPEN on a pattern it cannot read. */
export function pathsMatch(patterns, files) {
  const compiled = patterns.map((p) => {
    const neg = p.startsWith('!');
    return { neg, re: globToRegExp(neg ? p.slice(1) : p) };
  });
  if (compiled.some((c) => c.re === null)) return true;
  return files.some((f) => {
    let included = false;
    for (const c of compiled) if (c.re.test(f)) included = !c.neg;
    return included;
  });
}

/** The paths a workflow filters on: `on.pull_request.paths`, else `on.push.paths`, else null. */
export function workflowPaths(on) {
  for (const trigger of ['pull_request', 'push']) {
    const paths = on?.[trigger]?.paths;
    if (Array.isArray(paths) && paths.length) return paths;
  }
  return null;
}

/**
 * The base of the path filter, from earlier batch runs newest first: [{ sha, state }] where state
 * is that run's posted `Batch suites (main batch)` verdict (or null/error when none was posted).
 * The newest POSTED verdict decides: success = that commit, failure = no base (run every suite).
 */
export function decideBase(candidates) {
  for (const c of candidates) {
    if (c.state === 'success')
      return { base: c.sha, reason: `last green batch ${c.sha.slice(0, 10)}` };
    if (c.state === 'failure')
      return { base: null, reason: `the last batch verdict (${c.sha.slice(0, 10)}) was red` };
  }
  return { base: null, reason: 'no earlier batch verdict' };
}

/**
 * Which suites to dispatch. `entries`: [{ workflow, on, ownContext? }]; `files`: the changed
 * files since `base`, or null when they could not all be listed.
 */
export function selectSuites({ entries, base, baseReason, files }) {
  return entries.map((e) => {
    const out = { workflow: e.workflow, ownContext: e.ownContext ?? null };
    if (!base) return { ...out, run: true, reason: `no base: ${baseReason}` };
    if (!files) return { ...out, run: true, reason: 'the changed files could not all be listed' };
    const paths = workflowPaths(e.on);
    if (!paths) return { ...out, run: true, reason: 'its workflow has no paths filter' };
    return pathsMatch(paths, files)
      ? { ...out, run: true, reason: `a path it filters on changed since ${base.slice(0, 10)}` }
      : { ...out, run: false, reason: `nothing it filters on changed since ${base.slice(0, 10)}` };
  });
}

/** `gh workflow run` argv for one suite; only the inputs its workflow declares are passed. */
export function suiteDispatchArgs(workflow, on, repoName, base) {
  const inputs = on?.workflow_dispatch?.inputs ?? {};
  const args = ['workflow', 'run', workflow, '--repo', repoName, '--ref', 'main'];
  if ('batch' in inputs) args.push('-f', 'batch=true');
  if ('base' in inputs && base) args.push('-f', `base=${base}`);
  return args;
}

/**
 * The batch run of `workflow` at `sha`: the newest workflow_dispatch run by the bot on that
 * commit created at or after `since` (ms). Older dispatches at the same commit do not count.
 */
export function findRun(runs, workflow, sha, since) {
  return (
    runs
      .filter(
        (r) =>
          (r.path ?? '').replace(/@.*$/, '') === `.github/workflows/${workflow}` &&
          r.head_sha === sha &&
          r.event === 'workflow_dispatch' &&
          (r.actor?.login ?? r.triggering_actor?.login) === BOT &&
          Date.parse(r.created_at) >= since
      )
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] ?? null
  );
}

/** red | green | running | missing | undecided, for one suite's run (null = not found). */
export function runState(run) {
  if (!run) return 'missing';
  if (run.status !== 'completed') return 'running';
  if (run.conclusion === 'success') return 'green';
  if (RED.has(run.conclusion)) return 'red';
  return 'undecided';
}

/**
 * The status to post. `suites`: [{ workflow, run, state, ownContext }] where `run` says whether it
 * was dispatched and `state` is runState() or 'not-dispatched'. Suites with an ownContext post
 * their own verdict and are left out here. A red decides over a missing verdict.
 */
export function verdict({ suites, base }) {
  const mine = suites.filter((s) => !s.ownContext);
  const ran = mine.filter((s) => s.run);
  const red = ran.filter((s) => s.state === 'red').map((s) => short(s.workflow));
  const since = base ? ` since ${base.slice(0, 10)}` : '';
  if (red.length)
    return {
      state: 'failure',
      description: statusLine(base ? `Red, range ${base.slice(0, 10)}..here: ` : 'Red: ', red),
    };
  const open = ran.filter((s) => s.state !== 'green').map((s) => `${short(s.workflow)} ${s.state}`);
  if (open.length) return { state: 'error', description: statusLine('No verdict: ', open) };
  const skipped = mine.length - ran.length;
  return {
    state: 'success',
    description: ran.length
      ? `${ran.length} suite(s) passed at this commit${
          skipped ? `; ${skipped} unchanged${since}` : ''
        }.`
      : `No batch suite's paths changed${since}; all were green there.`,
  };
}

/** Is the wait over? Every dispatched run finished, and every awaited own context is posted. */
export function waitDone({ suites, postedContexts }) {
  return suites.every((s) => {
    if (!s.run || s.state === 'not-dispatched') return true;
    if (s.state === 'missing' || s.state === 'running') return false;
    return !s.ownContext || postedContexts.has(s.ownContext);
  });
}

// ── I/O ─────────────────────────────────────────────────────────────────────────────────────────

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20 }).trim();
const gh = (...args) => sh('gh', args);
const api = (path) => JSON.parse(gh('api', path));
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function readOn(workflow) {
  try {
    return JSON.parse(sh('yq', ['-o=json', '.on', `.github/workflows/${workflow}`]));
  } catch {
    return null; // no paths => run
  }
}

function postStatus(repoName, sha, { state, description }) {
  gh(
    'api',
    '-X',
    'POST',
    `repos/${repoName}/statuses/${sha}`,
    '-f',
    `state=${state}`,
    '-f',
    `context=${SUITES_CONTEXT}`,
    '-f',
    `description=${description}`,
    '-f',
    `target_url=${process.env.GITHUB_SERVER_URL}/${repoName}/actions/runs/${process.env.GITHUB_RUN_ID}`
  );
}

/** Newest-first earlier batch runs, read until one carries a posted verdict. */
function baseCandidates(repoName) {
  const q = new URLSearchParams({
    branch: 'main',
    event: 'workflow_dispatch',
    actor: BOT,
    status: 'completed',
    per_page: '10',
  });
  const runs = api(`repos/${repoName}/actions/workflows/lint.yml/runs?${q}`).workflow_runs ?? [];
  const out = [];
  for (const r of runs) {
    if (String(r.id) === process.env.GITHUB_RUN_ID) continue;
    const statuses = api(`repos/${repoName}/commits/${r.head_sha}/statuses?per_page=100`);
    const s = statuses.find(
      (x) =>
        x.context === SUITES_CONTEXT &&
        (x.target_url ?? '').replace(/\/$/, '').endsWith(`/actions/runs/${r.id}`)
    );
    out.push({ sha: r.head_sha, state: s?.state ?? null });
    if (s && ['success', 'failure'].includes(s.state)) break;
  }
  return out;
}

function changedFiles(repoName, base, sha) {
  try {
    const cmp = api(`repos/${repoName}/compare/${base}...${sha}`);
    if (cmp.status !== 'ahead') return null;
    const files = (cmp.files ?? []).map((f) => f.filename);
    // A rename moves a path out as well as in: both sides count as changed.
    for (const f of cmp.files ?? []) if (f.previous_filename) files.push(f.previous_filename);
    return (cmp.files ?? []).length >= COMPARE_FILE_CAP ? null : files;
  } catch {
    return null;
  }
}

function run() {
  const repoName = process.env.GITHUB_REPOSITORY;
  const sha = process.env.GITHUB_SHA;
  const waitMs = Number(process.env.BATCH_WAIT_MINUTES ?? 75) * 60_000;
  // Never faster than once a minute: every poll is an API request on the repository's token.
  const pollMs = Math.max(60, Number(process.env.BATCH_POLL_SECONDS ?? 60)) * 1000;
  const lines = [];
  const done = (v) => {
    lines.push(
      '',
      `Posting \`${SUITES_CONTEXT}\` = ${v.state} on ${sha.slice(0, 10)}: ${v.description}`
    );
    const text = lines.join('\n');
    console.log(text);
    if (process.env.GITHUB_STEP_SUMMARY)
      writeFileSync(process.env.GITHUB_STEP_SUMMARY, `### Batch suites, main batch\n\n${text}\n`, {
        flag: 'a',
      });
    postStatus(repoName, sha, v);
    if (v.state === 'failure')
      console.log(`::error title=Batch suites red (main batch)::${v.description}`);
  };

  // A dispatch runs on main's head, not on a commit. If main already moved, the suites would run
  // on another commit than this one: no verdict here, and the next batch covers the new head.
  const head = gh('api', `repos/${repoName}/commits/main`, '-q', '.sha');
  if (head !== sha) {
    done({
      state: 'error',
      description: statusLine('main moved before the suites were dispatched, now at ', [
        head.slice(0, 10),
      ]),
    });
    return;
  }

  let decided;
  try {
    decided = decideBase(baseCandidates(repoName));
  } catch (err) {
    decided = {
      base: null,
      reason: `could not read earlier verdicts (${String(err.message).split('\n')[0]})`,
    };
  }
  const { base, reason: baseReason } = decided;
  const files = base ? changedFiles(repoName, base, sha) : null;
  lines.push(`Base: ${base ? base.slice(0, 10) : 'none'} (${baseReason}).`);
  if (base)
    lines.push(
      files
        ? `${files.length} changed file(s) since the base.`
        : 'The changed files could not all be listed: every suite runs.'
    );

  const entries = BATCH_WORKFLOWS.map((e) => ({ ...e, on: readOn(e.workflow) }));
  const ons = Object.fromEntries(entries.map((e) => [e.workflow, e.on]));
  const since = Date.now() - 5_000;
  const suites = selectSuites({ entries, base, baseReason, files }).map((s) => {
    if (!s.run) return { ...s, state: 'skipped', url: '' };
    try {
      gh(...suiteDispatchArgs(s.workflow, ons[s.workflow], repoName, base));
      return { ...s, state: 'missing', url: '' };
    } catch (err) {
      return {
        ...s,
        state: 'not-dispatched',
        url: '',
        reason: `${s.reason}; dispatch failed: ${String(err.message).split('\n')[0]}`,
      };
    }
  });

  const deadline = Date.now() + waitMs;
  const posted = new Set();
  for (;;) {
    sleep(pollMs);
    try {
      const runs =
        api(
          `repos/${repoName}/actions/runs?event=workflow_dispatch&branch=main&head_sha=${sha}&per_page=100`
        ).workflow_runs ?? [];
      for (const s of suites) {
        if (!s.run || s.state === 'not-dispatched') continue;
        const r = findRun(runs, s.workflow, sha, since);
        s.state = runState(r);
        s.url = r?.html_url ?? '';
      }
      if (suites.some((s) => s.run && s.ownContext)) {
        for (const st of api(`repos/${repoName}/commits/${sha}/statuses?per_page=100`))
          if (['success', 'failure', 'error'].includes(st.state)) posted.add(st.context);
      }
    } catch (err) {
      console.log(`poll failed, retrying: ${String(err.message).split('\n')[0]}`);
    }
    if (waitDone({ suites, postedContexts: posted }) || Date.now() > deadline) break;
  }

  lines.push('', '| Suite | Dispatched | State | Run |', '| --- | --- | --- | --- |');
  for (const s of suites)
    lines.push(
      `| ${short(s.workflow)}${s.ownContext ? ` (posts \`${s.ownContext}\`)` : ''} | ${
        s.run ? 'yes' : 'no'
      }: ${s.reason} | ${s.state} | ${s.url} |`
    );
  for (const s of suites)
    if (s.ownContext && s.run && !posted.has(s.ownContext))
      lines.push(`\`${s.ownContext}\` was not posted on this commit before the deadline.`);
  done(verdict({ suites, base }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'run') run();
  else {
    console.error('usage: batch-suites.mjs run');
    process.exit(2);
  }
}
