#!/usr/bin/env node
/**
 * Measure a list of candidates sequentially and append results to a TSV.
 *
 * Strictly one at a time. Two concurrent measure runs against this endpoint produced a run
 * where every single call failed while still printing a confident verdict — the reason
 * measure.mjs now exits non-zero on zero successful calls.
 *
 *   node run-queue.mjs --modality image --keys sdxl,anima,flux1 --out results.tsv
 *   node run-queue.mjs --modality video --keys-file wan.txt --runs 2
 *
 * Resumable: keys already present in --out are skipped, so a killed run picks up where it
 * stopped rather than re-spending on work already done.
 */
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? undefined : args[i + 1];
};

const modality = flag('modality');
const runs = flag('runs') ?? '2';
const outPath = resolve(flag('out') ?? 'measure-results.tsv');
const keys = (
  flag('keys')?.split(',') ?? readFileSync(resolve(flag('keys-file')), 'utf8').split('\n')
)
  .map((k) => k.trim())
  .filter(Boolean);

const CAND = 'docs/prompt-analysis-samples/candidates';
const SAMPLES = 'docs/prompt-analysis-samples/samples';

// Only completed measurements count as done. A FAILED row means the endpoint died, not that
// the key was measured — treating it as done let a resume skip every failure and report a
// finished queue having measured nothing.
const done = new Set(
  existsSync(outPath)
    ? readFileSync(outPath, 'utf8')
        .split('\n')
        .slice(1)
        .filter((l) => l.trim() && !l.includes('\tFAILED'))
        .map((l) => l.split('\t')[0])
        .filter(Boolean)
    : []
);
if (!existsSync(outPath)) {
  appendFileSync(outPath, 'key\tsat_live\tsat_cand\tmoved\tsamples\tverdict\n');
}

/** Pull the two "saturated topics: N" lines and the topic deltas out of measure.mjs output. */
function parse(stdout) {
  const sats = [...stdout.matchAll(/saturated topics:\s*(\d+)/g)].map((m) => Number(m[1]));
  const moved = [...stdout.matchAll(/^\s{2}(\w[\w-]*)\s+([+-]\d+)%$/gm)]
    .map((m) => `${m[1]}${m[2]}`)
    .join(' ');
  return { live: sats[0], cand: sats[1], moved };
}

console.log(`queue: ${keys.length} key(s), ${done.size} already done, --runs ${runs}\n`);

for (const key of keys) {
  if (done.has(key)) {
    console.log(`${key.padEnd(24)} skipped (already in ${outPath})`);
    continue;
  }
  const candidate = `${CAND}/${key}.txt`;
  if (!existsSync(resolve(candidate))) {
    console.log(`${key.padEnd(24)} NO CANDIDATE — skipped`);
    continue;
  }
  const samplePath = `${SAMPLES}/${key}.json`;
  const hasSamples = existsSync(resolve(samplePath));

  const argv = [
    '.claude/skills/add-prompt-enhancement-guide/measure.mjs',
    '--ecosystem',
    key,
    '--candidate',
    candidate,
    '--runs',
    runs,
  ];
  if (modality) argv.push('--modality', modality);
  if (hasSamples) argv.push('--samples', samplePath);

  const started = Date.now();
  const r = spawnSync('node', argv, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const secs = Math.round((Date.now() - started) / 1000);

  if (r.status !== 0) {
    // Most often "every request failed" — a real signal about the endpoint, not the guide.
    const why = (r.stderr || r.stdout || '').trim().split('\n').pop() ?? 'unknown';
    console.log(`${key.padEnd(24)} FAILED (${secs}s) ${why.slice(0, 90)}`);
    appendFileSync(outPath, `${key}\t\t\t\t${hasSamples}\tFAILED: ${why.slice(0, 80)}\n`);
    continue;
  }

  const { live, cand, moved } = parse(r.stdout);
  const verdict =
    live === undefined || cand === undefined
      ? 'unparsed'
      : cand < live
      ? 'UNSATURATED'
      : cand > live
      ? 'REGRESSED'
      : 'no change';
  console.log(
    `${key.padEnd(24)} ${String(live)} -> ${String(cand)}  ${verdict.padEnd(
      12
    )} ${moved}  (${secs}s)`
  );
  appendFileSync(outPath, `${key}\t${live}\t${cand}\t${moved}\t${hasSamples}\t${verdict}\n`);
}

console.log(`\nresults appended to ${outPath}`);
