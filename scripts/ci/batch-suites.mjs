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
//       A suite with an `ownContext` (apps.yml: `App tests (main batch)`) posts that status itself,
//       from its own run, and is left out of the verdict above. Once it is posted on this commit,
//       this job RE-POSTS it unchanged (state and description) with this lint run as its
//       target_url (repostStatuses), so every `(main batch)` verdict on this commit names the
//       same run: the one CI-watch lists. A suite whose paths did not change is not dispatched,
//       so nothing is posted or re-posted for it at this commit. When a dispatched own-context
//       suite does NOT post (its dispatch failed, its run was cancelled or failed at startup, or
//       it finished without posting, or it was not found by the deadline), this job posts `error`
//       in THAT context itself (ownContextErrors): a missing verdict never reads as green, and the
//       wait for it ends as soon as its run has finished.
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
// a success makes it the base, a failure means there is none. The matching is
// scripts/ci/full-ci-paths.mjs's (the label's dispatcher uses the same module). No base, a compare
// that cannot list every file, an unreadable workflow, or a workflow with no paths all mean RUN:
// the filter only ever skips a suite whose inputs provably did not change since a commit where it
// was green. feed-go's benchmarks get a different base: the newest GREEN batch commit, even after
// a red one (decideBase). An own-context suite (apps.yml) has its OWN base, decided the same way
// from that context's verdicts on the earlier batch runs (the re-posts naming those runs), so a red
// or errored app verdict re-runs the app suites on the next batch whether or not their paths
// changed again.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The one paths matcher (GitHub's filter semantics), shared with full-ci.yml.
import { decide } from './full-ci-paths.mjs';
import { BATCH_WORKFLOWS, statusLine } from './unit-batched.mjs';

export const SUITES_CONTEXT = 'Batch suites (main batch)';
const BOT = 'github-actions[bot]';
const RED = new Set(['failure', 'timed_out', 'startup_failure']);
// The compare API lists at most 300 files; at that count the list may be cut short.
const COMPARE_FILE_CAP = 300;

const short = (wf) => wf.replace(/\.ya?ml$/, '');

/**
 * The bases, from earlier batch runs newest first: [{ sha, state }] where state is that run's
 * posted `Batch suites (main batch)` verdict (or null/error when none was posted).
 *   base   the path filter's: the newest POSTED verdict decides. Green = that commit; red = none
 *          (every suite runs, so a red suite whose paths did not change still re-runs).
 *   green  the benchmarks' (feed-go `bench`): the newest GREEN batch commit WHATEVER the latest
 *          verdict, so after a red batch the allocs/op gate still covers every merge since the last
 *          green one, not only the last merge. null only when no green batch is in the list.
 */
export function decideBase(candidates) {
  const green = candidates.find((c) => c.state === 'success')?.sha ?? null;
  for (const c of candidates) {
    if (c.state === 'success')
      return { base: c.sha, green, reason: `last green batch ${c.sha.slice(0, 10)}` };
    if (c.state === 'failure')
      return {
        base: null,
        green,
        reason: `the last batch verdict (${c.sha.slice(0, 10)}) was red`,
      };
  }
  return { base: null, green, reason: 'no earlier batch verdict' };
}

/**
 * Which suites to dispatch. `entries`: [{ workflow, on, ownContext? }] where `on` is the
 * workflow's `on:` (undefined when it could not be read); `files`: the changed files since `base`,
 * or null when they could not all be listed. The paths filter is applied by
 * scripts/ci/full-ci-paths.mjs's `decide`, the same matcher full-ci.yml uses, so the batch and the
 * label never disagree on what a workflow's filter selects. It fails open.
 */
export function selectSuites({
  entries,
  base: batchBase,
  baseReason: batchReason,
  files: batchFiles,
}) {
  return entries.map((e) => {
    const out = { workflow: e.workflow, ownContext: e.ownContext ?? null };
    // An own-context entry carries its own base (see the header); every other uses the batch's.
    const own = 'base' in e;
    const base = own ? e.base : batchBase;
    const baseReason = own ? e.baseReason : batchReason;
    const files = own ? e.files : batchFiles;
    if (!base) return { ...out, run: true, reason: `no base: ${baseReason}` };
    if (!files) return { ...out, run: true, reason: 'the changed files could not all be listed' };
    const d = decide(files, e.on);
    return { ...out, run: d.run, reason: `${d.reason} (since ${base.slice(0, 10)})` };
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

/**
 * The own-context statuses to re-post with this run as target_url (see the header). `statuses`:
 * the commit's statuses, newest first. For each dispatched suite with an ownContext, the newest
 * status in that context, when it is a verdict (success / failure / error) and does not already
 * name `runUrl`. Returns [{ context, state, description }].
 */
export function repostStatuses({ suites, statuses, runUrl }) {
  const out = [];
  for (const s of suites) {
    if (!s.ownContext || !s.run || s.state === 'not-dispatched') continue;
    const newest = (statuses ?? []).find((st) => st.context === s.ownContext);
    if (!newest || !['success', 'failure', 'error'].includes(newest.state)) continue;
    if ((newest.target_url ?? '').replace(/\/$/, '') === runUrl) continue;
    out.push({ context: s.ownContext, state: newest.state, description: newest.description ?? '' });
  }
  return out;
}

/**
 * Is the wait over? Every dispatched run finished. An own context posted while its run is still
 * going does not end the wait early, and one never posted does not hold it once the run has
 * finished: ownContextErrors then posts `error` for it.
 */
export function waitDone({ suites }) {
  return suites.every((s) => {
    if (!s.run || s.state === 'not-dispatched') return true;
    return s.state !== 'missing' && s.state !== 'running';
  });
}

/**
 * The `error` statuses to post for dispatched own-context suites whose context was NOT posted on
 * this commit by this batch. Returns [{ context, state: 'error', description }].
 */
export function ownContextErrors({ suites, postedContexts }) {
  const why = {
    'not-dispatched': 'its dispatch failed',
    missing: 'its run was not found at this commit by the deadline',
    running: 'its run did not finish by the deadline',
    red: 'its run failed before posting',
    undecided: 'its run was cancelled or skipped before posting',
    green: 'its run finished without posting',
  };
  return suites
    .filter((s) => s.ownContext && s.run && !postedContexts.has(s.ownContext))
    .map((s) => ({
      context: s.ownContext,
      state: 'error',
      description: statusLine(`No verdict: ${short(s.workflow)} `, [
        why[s.state] ?? `ended ${s.state}`,
      ]),
    }));
}

/** Contexts with a verdict (success / failure / error) created at or after `since` (ms). */
export function postedSince(statuses, since) {
  const out = new Set();
  for (const st of statuses ?? [])
    if (['success', 'failure', 'error'].includes(st.state) && Date.parse(st.created_at) >= since)
      out.add(st.context);
  return out;
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
    return undefined; // unreadable: decide() runs it
  }
}

const runUrl = (repoName) =>
  `${process.env.GITHUB_SERVER_URL}/${repoName}/actions/runs/${process.env.GITHUB_RUN_ID}`;

function postStatus(repoName, sha, { state, description, context = SUITES_CONTEXT }) {
  gh(
    'api',
    '-X',
    'POST',
    `repos/${repoName}/statuses/${sha}`,
    '-f',
    `state=${state}`,
    '-f',
    `context=${context}`,
    '-f',
    `description=${description}`,
    '-f',
    `target_url=${runUrl(repoName)}`
  );
}

/**
 * Newest-first earlier batch runs, read until one carries a GREEN verdict (decideBase needs the
 * newest posted verdict for the path filter and the newest green one for the benchmarks), at most
 * the 10 newest.
 */
function baseCandidates(repoName, ownContexts = []) {
  const q = new URLSearchParams({
    branch: 'main',
    event: 'workflow_dispatch',
    actor: BOT,
    status: 'completed',
    per_page: '10',
  });
  const runs = api(`repos/${repoName}/actions/workflows/lint.yml/runs?${q}`).workflow_runs ?? [];
  // Per context: [{ sha, state }], newest first. Read until every context has met a GREEN verdict
  // (decideBase needs the newest posted one and the newest green one), at most the 10 newest.
  const contexts = [SUITES_CONTEXT, ...ownContexts];
  const out = Object.fromEntries(contexts.map((c) => [c, []]));
  const greenSeen = new Set();
  for (const r of runs) {
    if (String(r.id) === process.env.GITHUB_RUN_ID) continue;
    const statuses = api(`repos/${repoName}/commits/${r.head_sha}/statuses?per_page=100`);
    for (const c of contexts) {
      if (greenSeen.has(c)) continue;
      const s = statuses.find(
        (x) =>
          x.context === c &&
          (x.target_url ?? '').replace(/\/$/, '').endsWith(`/actions/runs/${r.id}`)
      );
      out[c].push({ sha: r.head_sha, state: s?.state ?? null });
      if (s?.state === 'success') greenSeen.add(c);
    }
    if (greenSeen.size === contexts.length) break;
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

  const ownContexts = BATCH_WORKFLOWS.filter((e) => e.ownContext).map((e) => e.ownContext);
  let decided;
  let candidates = {};
  try {
    candidates = baseCandidates(repoName, ownContexts);
    decided = decideBase(candidates[SUITES_CONTEXT]);
  } catch (err) {
    decided = {
      base: null,
      green: null,
      reason: `could not read earlier verdicts (${String(err.message).split('\n')[0]})`,
    };
  }
  const { base, green, reason: baseReason } = decided;
  const files = base ? changedFiles(repoName, base, sha) : null;
  lines.push(`Base: ${base ? base.slice(0, 10) : 'none'} (${baseReason}).`);
  lines.push(
    green
      ? `Benchmarks compare against the last green batch, ${green.slice(0, 10)}.`
      : 'No green batch in the last 10: the benchmarks fall back to HEAD^1 (the last merge only).'
  );
  if (base)
    lines.push(
      files
        ? `${files.length} changed file(s) since the base.`
        : 'The changed files could not all be listed: every suite runs.'
    );

  const entries = BATCH_WORKFLOWS.map((e) => {
    const entry = { ...e, on: readOn(e.workflow) };
    if (!e.ownContext) return entry;
    const own = candidates[e.ownContext]
      ? decideBase(candidates[e.ownContext])
      : { base: null, reason: 'its earlier verdicts could not be read' };
    lines.push(
      `${short(e.workflow)} base: ${own.base ? own.base.slice(0, 10) : 'none'} (${own.reason}).`
    );
    return {
      ...entry,
      base: own.base,
      baseReason: own.reason,
      files: own.base ? (own.base === base ? files : changedFiles(repoName, own.base, sha)) : null,
    };
  });
  const ons = Object.fromEntries(entries.map((e) => [e.workflow, e.on]));
  const since = Date.now() - 5_000;
  const suites = selectSuites({ entries, base, baseReason, files }).map((s) => {
    if (!s.run) return { ...s, state: 'skipped', url: '' };
    try {
      gh(...suiteDispatchArgs(s.workflow, ons[s.workflow], repoName, green));
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
        const st = api(`repos/${repoName}/commits/${sha}/statuses?per_page=100`);
        for (const c of postedSince(st, since)) posted.add(c);
      }
    } catch (err) {
      console.log(`poll failed, retrying: ${String(err.message).split('\n')[0]}`);
    }
    if (waitDone({ suites }) || Date.now() > deadline) break;
  }

  lines.push('', '| Suite | Dispatched | State | Run |', '| --- | --- | --- | --- |');
  for (const s of suites)
    lines.push(
      `| ${short(s.workflow)}${s.ownContext ? ` (posts \`${s.ownContext}\`)` : ''} | ${
        s.run ? 'yes' : 'no'
      }: ${s.reason} | ${s.state} | ${s.url} |`
    );
  if (suites.some((s) => s.run && s.ownContext)) {
    // One last read: a status posted between the last poll and the run's completion counts.
    try {
      const st = api(`repos/${repoName}/commits/${sha}/statuses?per_page=100`);
      for (const c of postedSince(st, since)) posted.add(c);
    } catch (err) {
      lines.push(`Could not re-read the statuses: ${String(err.message).split('\n')[0]}`);
    }
    for (const e of ownContextErrors({ suites, postedContexts: posted })) {
      lines.push(`Posting \`${e.context}\` = error: ${e.description}`);
      try {
        postStatus(repoName, sha, e);
      } catch (err) {
        lines.push(`Could not post it: ${String(err.message).split('\n')[0]}`);
      }
    }
    try {
      const statuses = api(`repos/${repoName}/commits/${sha}/statuses?per_page=100`);
      for (const r of repostStatuses({ suites, statuses, runUrl: runUrl(repoName) })) {
        lines.push(`Re-posting \`${r.context}\` = ${r.state} with this run as its target.`);
        postStatus(repoName, sha, r);
      }
    } catch (err) {
      lines.push(
        `Could not re-post the own-context statuses: ${String(err.message).split('\n')[0]}`
      );
    }
  }
  done(verdict({ suites, base }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'run') run();
  else {
    console.error('usage: batch-suites.mjs run');
    process.exit(2);
  }
}
