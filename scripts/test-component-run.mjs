#!/usr/bin/env node
/**
 * `pnpm run test:component` — runs the browser-mode `component` project AND asserts that it
 * collected something.
 *
 * The assertion itself lives in `scripts/ci/assert-component-suite-ran.mjs`, which owns the
 * reason it exists and is unit-tested against fixtures. This file is only the plumbing: run
 * vitest with a JSON report beside the normal output, then hand that report to the gate.
 *
 * 🔴 IT NEVER TURNS RED INTO GREEN. Vitest's own exit code is passed through whenever the
 * ledger is satisfied; the gate can only ever ADD a failure. Two paths deliberately bypass
 * it — a signal-killed runner (see below) and a narrowed run (the gate's `--narrowed`).
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Under `node_modules/` so it is gitignored with the rest of it, and so it sits beside the
// install the run used rather than in a shared tmpdir two agents can collide in.
const REPORT = resolve(repoRoot, 'node_modules/.civitai-component-report.json');
const GATE = resolve(repoRoot, 'scripts/ci/assert-component-suite-ran.mjs');

const args = process.argv.slice(2);

/**
 * Whether the caller narrowed the run. A positional argument is a filename filter and
 * `-t` / `--testNamePattern` narrows by test name; either makes the collected count a
 * property of the filter rather than of the suite, so the floor cannot mean anything.
 * Flags are not filters.
 *
 * Exported for the unit test: this is the one branch here that can be wrong in a way no
 * amount of running the real suite would reveal.
 */
export function isNarrowed(argv) {
  for (const a of argv) {
    if (a === '-t' || a === '--testNamePattern') return true;
    if (a.startsWith('-t=') || a.startsWith('--testNamePattern=')) return true;
    if (!a.startsWith('-')) return true;
  }
  return false;
}

function run(bin, argv) {
  return new Promise((done) => {
    const child = spawn(bin, argv, { cwd: repoRoot, stdio: 'inherit' });
    // The CI task wraps this in `timeout(1)`, which signals only its direct child. Forward
    // so a budget overrun stops the runner instead of orphaning it.
    const forward = (sig) => () => {
      if (!child.killed) child.kill(sig);
    };
    process.on('SIGINT', forward('SIGINT'));
    process.on('SIGTERM', forward('SIGTERM'));
    child.on('error', (err) => {
      console.error(`test:component: failed to spawn ${bin}: ${err.message}`);
      done({ rc: 127, signal: null });
    });
    child.on('exit', (code, signal) => done({ rc: signal ? 143 : code ?? 1, signal }));
  });
}

async function main() {
  const vitestBin = resolve(
    repoRoot,
    'node_modules/.bin',
    process.platform === 'win32' ? 'vitest.cmd' : 'vitest'
  );

  // `--reporter=default` is restated because naming a second reporter REPLACES the default
  // set rather than adding to it — without it the human-readable output disappears and all
  // that is left is a JSON file nobody reads.
  const { rc, signal } = await run(vitestBin, [
    'run',
    '--project',
    'component',
    '--reporter=default',
    '--reporter=json',
    `--outputFile.json=${REPORT}`,
    ...args,
  ]);

  /**
   * 🔴 A TRUNCATED RUN IS NOT AN ABORTED ONE, AND MUST NOT BE RELABELLED AS ONE.
   *
   * The CI task wraps this in `timeout(1)` and reads the exit code to tell "timeout" from
   * "fail" — it reports a budget overrun as an UNKNOWN verdict, deliberately, because no
   * suite went red. A killed run also writes no JSON report, which looks exactly like the
   * abort the gate exists to catch if you only look at the report. So a signal death
   * short-circuits: pass the runner's own status through and make no claim about what was
   * collected.
   *
   * (`timeout` signals only its direct child, which is the shell, so in the current CI
   * wiring this fires only if something signals this process directly. It is here because
   * the alternative — silently converting a kill into a confident "the suite collected
   * nothing" — is a wrong answer, not a missing one.)
   */
  if (signal) {
    console.error(
      `\ntest:component: the runner was killed by ${signal} — passing that through. No claim ` +
        'is made about what it collected: a killed run writes no report, and that is not the ' +
        'same as a run that collected nothing.'
    );
    return rc;
  }

  const gate = await run(process.execPath, [
    GATE,
    REPORT,
    ...(isNarrowed(args) ? ['--narrowed'] : []),
  ]);

  // Best-effort, and AFTER the gate has read it: a stale report from a previous run must
  // never satisfy the next one's ledger.
  try {
    rmSync(REPORT, { force: true });
  } catch {
    /* not worth failing a run over */
  }

  // The gate can only ADD a failure — a green gate hands the runner's own verdict back.
  return gate.rc !== 0 ? gate.rc : rc;
}

// Main-guard, so importing this from a test does not launch a browser suite.
if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1] === fileURLToPath(import.meta.url)
) {
  process.exit(await main());
}
