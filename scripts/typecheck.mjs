#!/usr/bin/env node
/**
 * Runs the full-repo `tsc --noEmit` and classifies the OUTCOME, rather than
 * leaving that to whoever reads the log.
 *
 * Why this exists
 * ---------------
 * `tsc` on this repo needs a raised V8 old-space (the default cap is far below
 * what the program graph costs). When the cap is too low, V8 aborts:
 *
 *     FATAL ERROR: Ineffective mark-compacts near heap limit
 *     Allocation failed - JavaScript heap out of memory
 *
 * The abort happens PART WAY THROUGH checking, so the process emits **zero**
 * `error TS` lines and dies. Through `pnpm run`, that surfaces as
 * `ELIFECYCLE  Command failed with exit code 1` — a non-zero exit with a log
 * that contains no type errors at all.
 *
 * That is byte-for-byte indistinguishable from a clean run to anything that
 * judges the typecheck by its OUTPUT ("no `error TS` lines => clean"), which is
 * what humans and scripted checks usually do. Measured on this repo: with a
 * deliberate `const x: number = 'nope'` in `src/`, a run capped at 4096 MB
 * reported 0 errors and hid it completely, while the same tree at 8192 MB
 * reported it. Raising the cap only moves that cliff — the codebase grows into
 * it again — so the number alone is not the fix. This wrapper makes the crash
 * LOUD and unmistakably distinct from both "clean" and "you have type errors".
 *
 * Classification
 * --------------
 *   exit 0, no `error TS`      -> clean.
 *   exit != 0, has `error TS`  -> ordinary type errors; exit code passed through.
 *   exit != 0, no `error TS`   -> CRASH. Never report this as a typecheck result.
 *                                Names heap exhaustion / kernel OOM-kill /
 *                                unknown-crash separately, since the fixes differ.
 *   exit 0, has `error TS`     -> defensive: tsc contradicting itself, treated as
 *                                a crash rather than trusted.
 *
 * Heap size
 * ---------
 * Measured cold (no .tsbuildinfo) on a clean checkout, with a deliberate type
 * error in `src/` as a visibility control:
 *
 *   node 24.18.1   4096 MB -> OOM, 0 diagnostics   4608 MB -> OOM, 0 diagnostics
 *                  5120 MB -> pass, error found    8192 MB -> pass, error found
 *   node 22.22.2   6144 MB -> pass, error found    8192 MB -> pass, error found
 *
 * So the cliff sits between 4608 and 5120 MB, and the 8192 default carries ~1.6x
 * headroom over it. It is deliberately NOT raised further: the CI runner has
 * 16 GB, and a cap approaching that trades a self-describing V8 abort for a
 * kernel OOM-kill, which says less. Override per-run with TYPECHECK_HEAP_MB.
 * When the codebase does grow into 8192, the crash report below is what says so
 * — out loud — instead of a silently empty log.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const DEFAULT_HEAP_MB = 8192;
const heapMb = Number(process.env.TYPECHECK_HEAP_MB || DEFAULT_HEAP_MB);
if (!Number.isFinite(heapMb) || heapMb <= 0) {
  console.error(
    `typecheck: TYPECHECK_HEAP_MB must be a positive number, got "${process.env.TYPECHECK_HEAP_MB}"`
  );
  process.exit(2);
}

// TYPECHECK_TSC_PATH is a test seam: it lets the suite drive this classifier
// with a stub that exits the way a crashed / clean / erroring tsc does, without
// paying a multi-minute real typecheck per case. Not meant for normal use.
let tscPath = process.env.TYPECHECK_TSC_PATH;
if (!tscPath) {
  try {
    tscPath = require.resolve('typescript/lib/tsc.js');
  } catch {
    console.error('typecheck: cannot resolve typescript/lib/tsc.js — run `pnpm install` first.');
    process.exit(2);
  }
}

const tscArgs = process.argv.slice(2);
const startedAt = Date.now();
const child = spawn(
  process.execPath,
  [`--max-old-space-size=${heapMb}`, tscPath, '--noEmit', ...tscArgs],
  {
    // NODE_OPTIONS is dropped on purpose: the heap cap is passed as an argv flag
    // so an inherited NODE_OPTIONS cannot silently override it, and so the value
    // reported below is the value actually in force.
    env: { ...process.env, NODE_OPTIONS: '' },
    stdio: ['inherit', 'pipe', 'pipe'],
  }
);

// Counted while streaming rather than buffered: a badly broken tree can emit
// tens of thousands of diagnostics, and this wrapper must not become the thing
// that runs out of memory.
let errorTsLines = 0;
let sawHeapOom = false;
const tail = [];
const TAIL_LINES = 40;

const OOM_SIGNATURES = [
  'JavaScript heap out of memory',
  'Ineffective mark-compacts near heap limit',
  'FATAL ERROR',
];

function onLine(line) {
  // `tsc` diagnostics are `path(line,col): error TS####: message`. `--pretty`
  // is not used by this script, so the plain form is what arrives.
  if (line.includes('error TS')) errorTsLines++;
  if (OOM_SIGNATURES.some((sig) => line.includes(sig))) sawHeapOom = true;
  tail.push(line);
  if (tail.length > TAIL_LINES) tail.shift();
}

function wire(stream, sink) {
  let residual = '';
  stream.on('data', (chunk) => {
    sink.write(chunk);
    // Split on the residual + chunk so a signature straddling a chunk boundary
    // is still seen whole.
    const text = residual + chunk.toString('utf8');
    const lines = text.split('\n');
    residual = lines.pop() ?? '';
    for (const line of lines) onLine(line);
  });
  stream.on('end', () => {
    if (residual) onLine(residual);
  });
}

wire(child.stdout, process.stdout);
wire(child.stderr, process.stderr);

function annotate(message) {
  // Surfaces in the checks UI when running under Actions; harmless elsewhere.
  if (process.env.GITHUB_ACTIONS === 'true') console.log(`::error::${message}`);
}

function reportCrash({ code, signal, reason, remedy }) {
  const how = signal ? `killed by signal ${signal}` : `exit code ${code}`;
  // The detail goes to stderr, but a one-line verdict also goes to STDOUT.
  // The failure this whole wrapper exists to catch was found by a caller that
  // redirected stdout and dropped stderr: V8's abort is written to stderr, so
  // that caller saw an empty log and a bare non-zero exit. A crash has to be
  // visible in whichever stream the reader happens to be capturing.
  console.log(`TYPECHECK CRASHED (${how}): ${reason}. NOT a clean typecheck — see stderr.`);
  console.error('');
  console.error('================================================================');
  console.error('  TYPECHECK CRASHED — THIS IS NOT A TYPECHECK RESULT');
  console.error('================================================================');
  // Nothing this wrapper prints may contain the literal diagnostic marker that
  // callers grep for — otherwise a crash report reads as a type error to them.
  console.error(`  tsc ${how} after emitting 0 diagnostics.`);
  console.error(`  Cause: ${reason}`);
  console.error('');
  console.error('  The check did not finish, so it says NOTHING about whether the');
  console.error('  code typechecks. Do not read the absence of errors as a pass.');
  console.error('');
  console.error(`  Fix: ${remedy}`);
  console.error(`  Heap cap in force: --max-old-space-size=${heapMb} (MB).`);
  console.error('  Override with TYPECHECK_HEAP_MB=<mb> pnpm run typecheck');
  if (tail.length) {
    console.error('');
    console.error(`  Last ${tail.length} line(s) of tsc output:`);
    for (const line of tail) console.error(`    ${line}`);
  }
  console.error('================================================================');
  annotate(`Typecheck crashed (${how}, 0 diagnostics emitted): ${reason}`);
}

child.on('error', (err) => {
  console.error(`typecheck: failed to start tsc: ${err.message}`);
  process.exit(2);
});

child.on('close', (code, signal) => {
  const crashed = signal !== null || code !== 0;

  if (!crashed) {
    if (errorTsLines > 0) {
      // tsc printed diagnostics and still claimed success. Whatever that is, it
      // is not a verdict worth trusting.
      reportCrash({
        code,
        signal,
        reason: `tsc exited 0 but printed ${errorTsLines} diagnostic line(s) — contradictory result`,
        remedy: 'investigate the tsc invocation; do not treat this run as a pass.',
      });
      process.exit(1);
    }
    // A clean `tsc --noEmit` prints NOTHING, so an empty log is exactly what a
    // crash-with-stderr-dropped looks like too. Stating success explicitly means
    // "the log has no errors in it" is no longer a thing anyone has to infer.
    console.log(
      `typecheck: OK — 0 type errors in ${((Date.now() - startedAt) / 1000).toFixed(0)}s ` +
        `(heap cap ${heapMb} MB).`
    );
    process.exit(0);
  }

  if (errorTsLines > 0) {
    // The ordinary, useful failure: real type errors. Pass the verdict through
    // untouched so the existing developer experience is unchanged.
    console.error(`\ntypecheck: ${errorTsLines} type error(s).`);
    process.exit(code === 0 || code === null ? 1 : code);
  }

  if (sawHeapOom) {
    reportCrash({
      code,
      signal,
      reason: `V8 ran out of old-space heap at ${heapMb} MB`,
      remedy:
        'raise the cap — TYPECHECK_HEAP_MB=<larger> to confirm, then raise ' +
        'DEFAULT_HEAP_MB in this script (and check the CI runner has the RAM for it).',
    });
  } else if (signal === 'SIGKILL' || code === 137) {
    reportCrash({
      code,
      signal,
      reason:
        'the process was killed from outside (out of system memory, or a job/container limit)',
      remedy:
        'give the machine or runner more RAM, or LOWER the heap cap so V8 stays ' +
        'inside it — a cap above available RAM turns into an unhelpful kill.',
    });
  } else {
    reportCrash({
      code,
      signal,
      reason: 'tsc terminated abnormally without producing any diagnostics',
      remedy: 'read the tsc output above; this is a tsc/tooling failure, not a code failure.',
    });
  }
  process.exit(code === 0 || code === null ? 1 : code);
});
