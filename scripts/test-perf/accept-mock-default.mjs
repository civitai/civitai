#!/usr/bin/env node
/**
 * Acceptance harness for adding `default` to the six mock factories that keep `redis`,
 * `@aws-sdk/client-s3` and `@aws-sdk/lib-storage` out of the pre-bundling safelist.
 *
 * 🔴 The change CANNOT be verified on a branch that does not enable the optimizer. Without
 * pre-bundling the package is not wrapped as a CJS-interop chunk, so the missing `default` never
 * bites and a green run proves only that the old config still works. This runs the six files under
 * a config with all three candidates pre-bundled, which is the configuration the change is for.
 *
 * It compares PER-FILE collected counts, not the total: `s3-utils` is 66 of the 106, so a sum of 40
 * could be one file collecting zero and still read as a partial pass.
 *
 *   node scripts/test-perf/accept-mock-default.mjs
 */
import { spawnSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Measured on a tree with no external-mock changes. Per-file, because the total hides a zero.
const EXPECTED = {
  'src/utils/__tests__/s3-utils.test.ts': 66,
  'src/server/redis/__tests__/client.test.ts': 13,
  'src/server/redis/__tests__/periodic-refresh.test.ts': 6,
  'src/server/services/__tests__/training.orchestrator-error-mapping.test.ts': 11,
  'src/server/services/__tests__/training-status.sysredis-soft.test.ts': 3,
  'src/tests/api/blocks/screenshot.test.ts': 7,
};

const files = Object.keys(EXPECTED);
const label = 'accept-mock-default';
const res = spawnSync(
  process.execPath,
  [
    path.join(repoRoot, 'node_modules/vitest/vitest.mjs'),
    'run',
    '--config',
    'scripts/test-perf/prebundle-probe-config.mts',
    '--project',
    'unit*',
    '--max-workers=4',
    '--reporter=default',
    `--reporter=${path.join(repoRoot, 'scripts/test-perf/reporter.mjs').replace(/\\/g, '/')}`,
    ...files,
  ],
  {
    cwd: repoRoot,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      ...process.env,
      TESTPERF_LABEL: label,
      // The three the safelist excludes, alongside the five it ships, because the point is to
      // prove they can join it.
      PREBUNDLE_INCLUDE:
        'lodash-es,googleapis,@tiptap/html,@axiomhq/axiom-node,@aws-sdk/s3-request-presigner,' +
        'redis,@aws-sdk/client-s3,@aws-sdk/lib-storage',
    },
  }
);

const reportPath = path.join(repoRoot, `.test-perf/runs/${label}.perf.json`);
if (!existsSync(reportPath)) {
  console.error(
    `\nFAIL: no report at ${reportPath}. The run did not reach the reporter — that is a crash or a ` +
      'collection failure, not a test result, and the exit code alone does not distinguish them.'
  );
  process.exit(1);
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const got = new Map(
  report.files.map((f) => [
    f.file.split('\\').join('/'),
    (f.passed ?? 0) + (f.failed ?? 0) + (f.skipped ?? 0),
  ])
);

let bad = 0;
console.log('\nper-file collected counts under pre-bundling:');
for (const [file, expected] of Object.entries(EXPECTED)) {
  const actual = got.get(file) ?? 0;
  const ok = actual === expected;
  if (!ok) bad++;
  console.log(`  ${ok ? '  ok' : 'FAIL'}  ${String(actual).padStart(3)} / ${String(expected).padEnd(3)}  ${file}`);
}
const failed = report.files.reduce((s, f) => s + (f.failed ?? 0), 0);
console.log(`\nfailed assertions: ${failed}   exit: ${res.status}`);

if (bad || failed || res.status !== 0) {
  console.error('\nFAIL: the mock factories do not yet satisfy pre-bundled consumers.');
  process.exit(1);
}
console.log('\nOK: all six files collect their full count under pre-bundling.');
