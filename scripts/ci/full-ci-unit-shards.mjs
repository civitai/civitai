#!/usr/bin/env node
/**
 * Reads one pull_request Lint run's job list for `.github/workflows/full-ci.yml` and answers two
 * questions about its `unit` job:
 *
 *   expanded  how many `Unit tests (<n>)` shard jobs it has that were not cancelled. GitHub adds
 *             the `(<n>)` suffix only when it expands the matrix, which it does only for a job
 *             whose `if` passed, so a non-zero count means this run is running (or ran) the
 *             unit shards on that commit, and dispatching another full run would duplicate it.
 *   skipped   how many plain `Unit tests` jobs it has with conclusion `skipped`: the run already
 *             decided its `unit` job and did not run it (no `full-ci` label at that event), so
 *             the dispatch is needed and there is nothing to wait for.
 *
 * A plain `Unit tests` that is not yet `skipped`, and a cancelled shard, count as neither.
 *
 * Usage:  gh api repos/<o>/<r>/actions/runs/<id>/jobs | node scripts/ci/full-ci-unit-shards.mjs
 *         prints "<expanded> <skipped>"; exits non-zero (printing nothing) on unreadable input.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHARD = /^Unit tests \(\d+\)$/;

/** @param {Array<{ name?: string; conclusion?: string | null }>} jobs */
export function classifyUnitJobs(jobs) {
  let expanded = 0;
  let skipped = 0;
  for (const job of jobs ?? []) {
    const name = job?.name ?? '';
    if (SHARD.test(name) && job.conclusion !== 'cancelled') expanded++;
    else if (name === 'Unit tests' && job.conclusion === 'skipped') skipped++;
  }
  return { expanded, skipped };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const body = JSON.parse(readFileSync(0, 'utf8'));
  if (!Array.isArray(body?.jobs))
    throw new Error('expected a jobs API response with a `jobs` array');
  const { expanded, skipped } = classifyUnitJobs(body.jobs);
  process.stdout.write(`${expanded} ${skipped}\n`);
}
