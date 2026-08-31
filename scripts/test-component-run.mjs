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
 * A vitest flag's CANONICAL PATH: leading dashes off, `=value` off, every dot-segment kebab
 * camelCased. `--output-file` and `--outputFile` both give `outputFile`; `--outputFile.json=x`
 * gives `outputFile.json`; `--coverage.enabled` gives `coverage.enabled`.
 *
 * 🔴 KEBAB AND CAMEL ARE THE SAME FLAG TO VITEST, so a set that holds one spelling and not the
 * other has a hole in it. cac camelCases every parsed option key before matching
 * (`vitest/dist/chunks/cac.*.js`, `camelcaseOptionName` inside `parse`) — which is exactly why
 * `--max-workers` and `--maxWorkers` both work. Listing spellings by hand got
 * `--max-workers`/`--maxWorkers` right and `--test-timeout`/`--testTimeout` wrong, so the
 * spellings are normalised here instead of enumerated below.
 *
 * 🔴 THE `.subkey` IS KEPT, NOT STRIPPED, AND THAT DISTINCTION IS A FIX. Collapsing
 * `--coverage.enabled` onto `coverage` made every dot-subkey inherit its parent's
 * value-consuming behaviour — and `--coverage` itself is BOOLEAN (`argument: ""` in vitest's
 * `cliOptionsConfig`), so `pnpm test:component --coverage <file>` swallowed the FILE as
 * `--coverage`'s value. The run then scored as a full one, and an 18/18 green single-file run
 * failed naming ~200 files as absent, telling the reader not to narrow the walk. That is the
 * same loud-and-misdirecting shape the `--exclude`/`--dir`/`--root` fix existed to remove,
 * re-introduced by the mechanism that fixed it. Matching on the full PATH means a subkey is
 * value-taking only if it is listed as one.
 */
export function canonicalFlag(arg) {
  if (!arg.startsWith('-')) return null;
  const stripped = arg.replace(/^--?/, '').split('=')[0];
  // 🔴 FIRST SEGMENT ONLY, matching cac's own `camelcaseOptionName`, which is
  // `name.split(".").map((v, i) => (i === 0 ? camelcase(v) : v)).join(".")` — segments after
  // the first are left VERBATIM. Camel-casing all of them would make this accept a spelling
  // vitest does not (`--coverage.reports-directory`), so the wrapper and vitest would disagree
  // about what the next token is.
  const [head, ...rest] = stripped.split('.');
  return [head.replace(/-+([a-zA-Z0-9])/g, (_, c) => c.toUpperCase()), ...rest].join('.');
}

/**
 * Flags that narrow the run outright, so neither the file ledger nor the floor can mean
 * anything. Each of these fails LOUDLY if omitted, which is why they are named rather than
 * inferred:
 *  - `--shard=1/4` executes about a quarter of 2254, i.e. under the floor, so the gate would
 *    fail a healthy sharded run while telling the reader "Do NOT lower the floor to make this
 *    green". Sharding is the obvious next lever for a 201-file browser suite.
 *  - `--exclude`, `--dir` and `--root` genuinely SHRINK the collected file set, which the
 *    on-disk ledger reports as up to 200 files "absent", asserting the include broke or the
 *    run died. `pnpm test:component --exclude 'src/tests/**'` is a legitimate invocation.
 *  - `--config` can replace the `component` project's `include` outright, which is the
 *    assumption the walk is built on.
 */
const NARROWING_FLAGS = new Set([
  'shard',
  'changed',
  'exclude',
  'dir',
  'root',
  'r',
  'config',
  'c',
  't',
  'testNamePattern',
]);

/**
 * The few flags whose VALUE is itself a path, so path-shape cannot tell it from a filter.
 * Everything else is handled by shape alone — see `narrowingReason`. Kept deliberately tiny:
 * most path-valued vitest flags (`--config`, `--root`, `--dir`, `--exclude`) are narrowing
 * anyway and return before this is consulted.
 */
const PATH_VALUE_FLAGS = new Set([
  'outputFile',
  'coverage.reportsDirectory',
  'coverage.customProviderModule',
  'coverage.include',
  'coverage.exclude',
]);

/** A positional that looks like a path INTO the repo, i.e. a vitest file filter. */
function looksLikePath(a) {
  return a.includes('/') || /\.[cm]?[jt]sx?$/.test(a);
}

/**
 * WHY this run counts as narrowed, or `null` for a full run.
 *
 * 🔴 SHAPE, NOT A FLAG LIST — because the list cannot be kept right. Two rounds of audit were
 * spent on it: enumerating flag NAMES missed `--test-timeout` next to `--testTimeout`;
 * canonicalising spellings then made `--coverage <file>` swallow the file; and splitting
 * `coverage` into subkeys left 25 value-taking paths (`--retry.count 2`,
 * `--browser.name chromium`, sixteen more `coverage.*`) reading their VALUE as a filename and
 * silently switching both checks off. vitest 4.1.11 has a 164-path option tree; a
 * hand-maintained copy of it is wrong the day it is written.
 *
 * So the rule is about the ARGUMENT rather than the flag: a positional is a file filter if it
 * looks like a path, or if nothing before it could have been expecting a value. A non-path
 * token straight after a flag is that flag's value, whatever the flag is — which is right for
 * every one of the 73 value-taking options without naming any of them.
 *
 * 🔴 AND THE DECISION IS RETURNED AS A SENTENCE, not a boolean, so that turning the checks off
 * can never be the QUIET outcome. Whichever way this rule is wrong, the reader is told which
 * token caused it.
 */
export function narrowingReason(argv) {
  let pendingFlag = null; // the canonical name of the immediately preceding flag, if any
  for (const a of argv) {
    if (a === '--') {
      pendingFlag = null;
      continue;
    }
    const name = canonicalFlag(a);
    if (name !== null) {
      if (NARROWING_FLAGS.has(name)) return `\`${a}\` narrows which tests run`;
      pendingFlag = a.includes('=') ? null : name;
      continue;
    }
    // A positional. Three ways it is NOT a filter, all of them "it is a flag's value":
    if (pendingFlag !== null && PATH_VALUE_FLAGS.has(pendingFlag)) {
      pendingFlag = null;
      continue;
    }
    if (pendingFlag !== null && !looksLikePath(a)) {
      pendingFlag = null;
      continue;
    }
    return `\`${a}\` was read as a file filter`;
  }
  return null;
}

/**
 * Whether the caller narrowed the run — the boolean the gate needs. `narrowingReason` owns the
 * rule and the explanation.
 */
export function isNarrowed(argv) {
  return narrowingReason(argv) !== null;
}

/**
 * A caller-supplied `--outputFile` silently redirects the JSON report the gate reads.
 *
 * 🔴 MEASURED, AND IT IS THE WORST FAILURE THIS SCRIPT CAN PRODUCE: an 18/18 green single-file
 * run reported "THE COMPONENT SUITE COLLECTED NOTHING … this tier verified NOTHING on this
 * commit" and exited 1, because `--outputFile=<path>` clobbers the `--outputFile.json=` form
 * appended below and the wrapper's report was never written. The diagnosis then names three
 * causes, none of which is the real one. `.github/workflows/lint.yml` runs the SIBLING unit
 * tier with exactly that flag, so anyone extending this tier by copying that line hits it.
 *
 * Refused rather than honoured: the bare `--outputFile=` form sets the path for EVERY reporter,
 * so honouring it would point the default reporter at the same file. A loud config error with
 * the fix in it beats either silent wrong answer.
 *
 * 🔴 SCOPED TO THE FORMS THAT ACTUALLY COLLIDE — the bare one and `.json`. An earlier revision
 * refused `--outputFile.junit=` and `--outputFile.html=` too, neither of which touches the
 * `.json` key: object-form output paths merge per reporter, so those are legitimate and
 * refusing them was over-strict. It also missed `--output-file` entirely, which vitest accepts
 * (cac camelCases option keys), leaving the exact defect this exists for reachable through the
 * kebab spelling.
 */
export function conflictingOutputFile(argv) {
  return argv.find((a) => ['outputFile', 'outputFile.json'].includes(canonicalFlag(a))) ?? null;
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

/**
 * 🔴 `shell` IS PER-CALL, NOT SHARED, AND THAT DISTINCTION IS THE WHOLE POINT.
 *
 * The vitest spawn needs it on Windows: since the node 18.20.2/20.12.2 CVE fix, `spawn()` of a
 * `.cmd`/`.bat` without a shell fails outright. `scripts/test-unit-run.mjs` does exactly this —
 * and, deliberately, only for its vitest spawn.
 *
 * The GATE spawn must NOT have it. `shell: true` makes node concatenate argv UNESCAPED (it
 * emits DEP0190 saying so), and the gate is spawned as `process.execPath`, which on Windows
 * defaults to `C:\\Program Files\\nodejs\\node.exe`. Measured on this box with a spaced path:
 * `{shell:false}` → status 0, `{shell:true}` → status 1, "Cannot find module". Putting `shell`
 * on the shared helper therefore broke every `pnpm test:component` on Windows at the gate step,
 * with a cmd.exe parse error instead of any of this wrapper's messages — on the exact platform
 * the option was added to support.
 */
function run(bin, argv, { shell = false } = {}) {
  return new Promise((done) => {
    const child = spawn(bin, argv, { cwd: repoRoot, stdio: 'inherit', shell });
    // The CI task wraps this in `timeout(1)`, which signals only its direct child. Forward
    // so a budget overrun stops the runner instead of orphaning it.
    const forward = (sig) => () => {
      if (!child.killed) child.kill(sig);
    };
    process.on('SIGINT', forward('SIGINT'));
    process.on('SIGTERM', forward('SIGTERM'));
    child.on('error', (err) => {
      console.error(`test:component: failed to spawn ${bin}: ${err.message}`);
      done({ rc: 127, signal: null, spawnFailed: true });
    });
    child.on('exit', (code, signal) =>
      done({ rc: signal ? exitCodeForSignal(signal) : code ?? 1, signal, spawnFailed: false })
    );
  });
}

function vitestBinPath() {
  return resolve(
    repoRoot,
    'node_modules/.bin',
    process.platform === 'win32' ? 'vitest.cmd' : 'vitest'
  );
}

function clearReport() {
  try {
    rmSync(REPORT, { force: true });
  } catch {
    /* not worth failing a run over */
  }
}

/**
 * 🔴 THE COLLABORATORS ARE INJECTED SO THE ORDER OF EFFECTS CAN BE ASSERTED, NOT INSPECTED.
 *
 * Two things here are pure sequencing and cannot be seen from any output: the report is cleared
 * BEFORE the runner starts, and a signal death or a failed spawn returns without consulting the
 * gate. Both were shipped with no coverage; the two `clearReport()` calls are now identical
 * statements, so nothing but their position carries the meaning, and a refactor that moves the
 * first one below the run reopens "a stale report satisfies the next run's ledger" — the gate
 * silently inert in exactly its own use case — with every test still green.
 *
 * Defaults are the real implementations, so the shipped path is the tested path minus the fakes.
 */
export async function main({
  argv = args,
  runVitest = (a) => run(vitestBinPath(), a, { shell: process.platform === 'win32' }),
  runGate = (a) => run(process.execPath, a),
  clear = clearReport,
  log = console.error,
} = {}) {
  const conflict = conflictingOutputFile(argv);
  if (conflict) {
    log(
      `\ntest:component: refusing to run — \`${conflict}\` would redirect the JSON report this\n` +
        `command reads to decide whether the suite collected anything (it writes\n` +
        `--outputFile.json=${REPORT}).\n` +
        'Left alone, that produces the worst output this script has: a fully GREEN run reported\n' +
        'as an abort that verified nothing, naming causes none of which is real.\n' +
        'Run vitest directly if you need your own report:\n' +
        '    pnpm exec vitest run --project component --reporter=json --outputFile=<path>'
    );
    return 2;
  }

  // 🔴 Cleared BEFORE the run, not only after. A previous run's report is a fully-formed
  // healthy ledger; if this run then aborts before writing one, the gate reads the STALE file,
  // prints a green ledger and passes. Cleanup after the run cannot close that, because the
  // paths that skip it (a signal death, a throw) are the same ones that leave a stale report.
  clear();

  // `--reporter=default` is restated because naming a second reporter REPLACES the default
  // set rather than adding to it — without it the human-readable output disappears and all
  // that is left is a JSON file nobody reads.
  const { rc, signal, spawnFailed } = await runVitest([
    'run',
    '--project',
    'component',
    '--reporter=default',
    '--reporter=json',
    `--outputFile.json=${REPORT}`,
    ...argv,
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
    log(
      `\ntest:component: the runner was killed by ${signal} — passing that through as ${rc}. ` +
        'No claim is made about what it collected: a killed run writes no report, and that is ' +
        'not the same as a run that collected nothing.'
    );
    return rc;
  }

  // 🔴 Same reasoning as the signal branch, for the case that produces no report for a reason
  // the gate cannot describe: the runner never STARTED. `spawnFailed` is what `run()` reports
  // when `spawn` itself errors. Handing that to the gate makes it print forty lines about mock
  // factories, dead browsers and empty selections — none of which happened.
  //
  // Keyed on the FLAG, not on `rc === 127`: 127 is a real exit code a runner can produce on its
  // own, and relabelling that as "the binary could not be started" is a second wrong answer.
  if (spawnFailed) {
    log(
      '\ntest:component: the vitest binary could not be started, so nothing ran and there is ' +
        'nothing to account for. Check that `pnpm install` has completed in this checkout.'
    );
    return rc;
  }

  // 🔴 SAY WHY, whenever the checks are being turned off. `--narrowed` disables the file
  // ledger and the floor — the two checks this whole change exists to add — so a wrong
  // narrowing decision is the QUIET failure, the one direction the comments here repeatedly
  // name as worse than a loud one. Printing the token that caused it is what stops it being
  // quiet: `--retry.count 2` reading `2` as a file filter is obviously wrong on sight, and
  // invisible otherwise.
  const reason = narrowingReason(argv);
  if (reason) {
    log(
      `\ntest:component: NARROWED — ${reason}, so the file ledger and the floor are skipped ` +
        '(the zero-collected check still applies). If that reading is wrong, the checks you ' +
        'wanted are not running.'
    );
  }

  const gate = await runGate([GATE, REPORT, ...(reason ? ['--narrowed'] : [])]);

  // Best-effort, and AFTER the gate has read it. The load-bearing clear is the one BEFORE the
  // run; this one only keeps the tree tidy.
  clear();

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
