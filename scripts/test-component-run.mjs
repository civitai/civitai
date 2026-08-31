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
import { constants as osConstants } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Under `node_modules/` so it is gitignored with the rest of it, and so it sits beside the
// install the run used rather than in a shared tmpdir two agents can collide in.
const REPORT = resolve(repoRoot, 'node_modules/.civitai-component-report.json');
const GATE = resolve(repoRoot, 'scripts/ci/assert-component-suite-ran.mjs');

const args = process.argv.slice(2);

/**
 * Vitest flags that take their value as the NEXT argv entry.
 *
 * 🔴 THIS LIST IS WHAT KEEPS `isNarrowed` FROM READING A FLAG'S VALUE AS A FILENAME. Without
 * it, `--max-workers 1` — the space form, which is the one CONTRIBUTING and `vitest.config.mts`
 * steer people towards when sizing a run on a shared box — makes `1` look like a positional
 * filter, so the run is scored "narrowed" and THE FLOOR IS SILENTLY TURNED OFF. Every entry
 * below was measured against the real function; `--reporter`, `--retry`, `--bail`, `--project`
 * and `--pool` all did it too.
 *
 * A flag that takes a value and is NOT listed here degrades to "narrowed", i.e. it disables the
 * floor rather than producing a false failure. That is the quiet direction, so add to this list
 * rather than relying on it.
 */
const VALUE_FLAGS = new Set([
  '-t',
  '--testNamePattern',
  '-c',
  '--config',
  '-r',
  '--root',
  '--dir',
  '--reporter',
  '--outputFile',
  '--project',
  '--pool',
  '--retry',
  '--bail',
  '--shard',
  '--max-workers',
  '--maxWorkers',
  '--min-workers',
  '--minWorkers',
  '--maxConcurrency',
  '--testTimeout',
  '--hookTimeout',
  '--teardownTimeout',
  '--environment',
  '--exclude',
  '--mode',
  '--browser',
  '--coverage.reporter',
  '--coverage.provider',
]);

/**
 * Flags that narrow the run WITHOUT a positional argument, so the collected count stops being
 * a property of the suite.
 *
 * 🔴 `--shard` is the load-bearing one and it fails in the LOUD direction, which is why it is
 * worth a name here rather than being left to the value-flag list: `--shard=1/4` executes about
 * a quarter of 2254, i.e. well under the floor, so without this the gate FAILS a perfectly
 * healthy sharded run and tells the reader "Do NOT lower the floor to make this green" — a
 * message that is actively misleading. Sharding is the obvious next lever for a 201-file
 * browser suite, so this is a live shape, not a hypothetical.
 */
const NARROWING_FLAGS = new Set(['--shard', '--changed', '--related']);

/**
 * Whether the caller narrowed the run. A positional argument is a filename filter, `-t` /
 * `--testNamePattern` narrows by test name, and `--shard`/`--changed`/`--related` narrow with
 * no positional at all; each makes the collected count a property of the filter rather than of
 * the suite, so the floor cannot mean anything.
 *
 * Exported for the unit test: this is the one branch here that can be wrong in a way no amount
 * of running the real suite would reveal — it is silent in one direction and misdirecting in
 * the other.
 */
export function isNarrowed(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') continue;
    const name = a.startsWith('-') ? a.split('=', 1)[0] : null;
    if (name && NARROWING_FLAGS.has(name)) return true;
    if (name === '-t' || name === '--testNamePattern') return true;
    if (name && VALUE_FLAGS.has(name) && !a.includes('=')) {
      i += 1; // the next entry is this flag's VALUE, not a filename
      continue;
    }
    if (!a.startsWith('-')) return true;
  }
  return false;
}

/**
 * A caller-supplied `--outputFile` silently redirects the JSON report the gate reads.
 *
 * 🔴 MEASURED, AND IT IS THE WORST FAILURE THIS SCRIPT CAN PRODUCE: an 18/18 green single-file
 * run reported "🔴 THE COMPONENT SUITE COLLECTED NOTHING … this tier verified NOTHING on this
 * commit" and exited 1, because `--outputFile=<path>` clobbers the `--outputFile.json=` form
 * appended below and the wrapper's report was never written. The diagnosis then names three
 * causes, none of which is the real one. `.github/workflows/lint.yml` runs the SIBLING unit
 * tier with exactly that flag, so anyone extending this tier by copying that line hits it.
 *
 * Refused rather than honoured: the bare `--outputFile=` form sets the path for EVERY reporter,
 * so honouring it would point the default reporter at the same file. A loud config error with
 * the fix in it beats either silent wrong answer.
 */
export function conflictingOutputFile(argv) {
  return argv.find((a) => /^--outputFile(\.|=|$)/.test(a)) ?? null;
}

/**
 * The shell's own convention: a process killed by signal N exits 128+N.
 *
 * 🔴 THIS USED TO BE A HARDCODED 143 FOR EVERY SIGNAL, AND THAT RE-CREATED THE EXACT
 * MISLABELLING THIS WHOLE CHANGE EXISTS TO REMOVE. `report-only-suite-task.yaml` branches on
 * 137 to report `oom-killed` — "this is an OUT-OF-MEMORY kill, not a timeout; raise the task's
 * memory limit" — and on 124 for a timeout. Before this wrapper existed, an OOM-killer SIGKILL
 * on vitest reached that task as 137 (pnpm re-raises). With a constant 143 the wrapper would
 * hand it 143 instead, which matches no branch and falls through to `RC=1` — verdict `fail`,
 * rendered as "Component suite failed". A memory problem would have been reported as a test
 * failure, on the same tier, in the same words.
 *
 * `os.constants.signals` is the mapping node itself uses, so this cannot drift from the names
 * node hands back.
 */
export function exitCodeForSignal(signal) {
  const n = osConstants.signals[signal];
  return typeof n === 'number' ? 128 + n : 143;
}

function run(bin, argv) {
  return new Promise((done) => {
    const child = spawn(bin, argv, {
      cwd: repoRoot,
      stdio: 'inherit',
      // 🔴 Required on Windows since the node 18.20.2/20.12.2 CVE fix: `spawn()` of a
      // `.cmd`/`.bat` without a shell fails outright. `scripts/test-unit-run.mjs` already does
      // this for the same reason; omitting it here would break `pnpm test:component` on a
      // supported dev platform, and — because a spawn failure produces no report — the gate
      // would print the whole abort diagnosis about mock factories and dead browsers.
      shell: process.platform === 'win32',
    });
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
    child.on('exit', (code, signal) =>
      done({ rc: signal ? exitCodeForSignal(signal) : code ?? 1, signal })
    );
  });
}

async function main() {
  const conflict = conflictingOutputFile(args);
  if (conflict) {
    console.error(
      `\ntest:component: refusing to run — \`${conflict}\` would redirect the JSON report this\n` +
        `command reads to decide whether the suite collected anything (it writes\n` +
        `--outputFile.json=${REPORT}).\n` +
        'Left alone, that produces the worst output this script has: a fully GREEN run reported\n' +
        'as "THE COMPONENT SUITE COLLECTED NOTHING", naming three causes and none of them real.\n' +
        'Run vitest directly if you need your own report:\n' +
        '    pnpm exec vitest run --project component --reporter=json --outputFile=<path>'
    );
    return 2;
  }

  const vitestBin = resolve(
    repoRoot,
    'node_modules/.bin',
    process.platform === 'win32' ? 'vitest.cmd' : 'vitest'
  );

  // 🔴 Removed BEFORE the run, not only after. A previous run's report is a fully-formed
  // healthy ledger; if this run then aborts before writing one, the gate reads the STALE file,
  // prints a green ledger and passes — silently inert in exactly its own use case. Cleanup
  // after the run cannot close that, because the paths that skip it (a signal death, a throw)
  // are the same ones that leave a stale report behind.
  try {
    rmSync(REPORT, { force: true });
  } catch {
    /* not worth failing a run over */
  }

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
      `\ntest:component: the runner was killed by ${signal} — passing that through as ${rc}. ` +
        'No claim is made about what it collected: a killed run writes no report, and that is ' +
        'not the same as a run that collected nothing.'
    );
    return rc;
  }

  // 🔴 Same reasoning as the signal branch, for the case that produces no report for a reason
  // the gate cannot describe: the runner never STARTED. 127 is what `run()` returns when
  // `spawn` itself fails. Handing that to the gate makes it print forty lines about mock
  // factories, dead browsers and empty selections — none of which happened.
  if (rc === 127) {
    console.error(
      '\ntest:component: the vitest binary could not be started, so nothing ran and there is ' +
        'nothing to account for. Check that `pnpm install` has completed in this checkout.'
    );
    return rc;
  }

  const gate = await run(process.execPath, [
    GATE,
    REPORT,
    ...(isNarrowed(args) ? ['--narrowed'] : []),
  ]);

  // Best-effort, and AFTER the gate has read it. The load-bearing removal is the one BEFORE
  // the run; this one only keeps the tree tidy.
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
