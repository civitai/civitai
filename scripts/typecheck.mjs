#!/usr/bin/env node
/**
 * Runs the full-repo typecheck (`tsc --noEmit`) and classifies the OUTCOME, rather than
 * leaving that to whoever reads the log.
 *
 * Compiler
 * --------
 * TypeScript 7 (the native compiler in `tools/ts7`, installed on first use by
 * `scripts/lib/ts7.mjs`). The root `typescript` dependency stays 5.9 because ESLint,
 * `next build`, `svelte-check` and the codegen import its compiler API, which TS 7.0 no
 * longer ships. Threading:
 *
 *   local / agent machines  --singleThreaded   several agents typechecking at once must not
 *                                              exhaust a dev machine's memory
 *   CI (`CI` set)           --checkers 2       faster; CI runners have the memory
 *
 * `TYPECHECK_COMPILER=5` runs TypeScript 5.9 instead, as before. It never resolves or installs
 * TypeScript 7, so it still works when TS7 or the package registry is what is broken. Without
 * it, a TS7 that cannot be installed is exit 2, never a quiet fall back to 5.9.
 *
 * Why this exists
 * ---------------
 * A typecheck that crashes part way through emits **zero** `error TS` lines and dies with a
 * non-zero exit. That is byte-for-byte indistinguishable from a clean run to anything that
 * judges the typecheck by its OUTPUT ("no `error TS` lines => clean"), which is what humans and
 * scripted checks usually do. On 5.9 the crash is V8 running out of heap:
 *
 *     FATAL ERROR: Ineffective mark-compacts near heap limit
 *     Allocation failed - JavaScript heap out of memory
 *
 * Measured: a 5.9 run capped at 4096 MB hid a deliberate `const x: number = 'nope'` in `src/`
 * completely. TS7 has no V8 heap, but the Go runtime aborts the same way when the machine runs
 * out (`fatal error: runtime: out of memory`). This wrapper makes a crash LOUD and distinct
 * from both "clean" and "you have type errors".
 *
 * Classification
 * --------------
 *   exit 0, no `error TS`      -> clean.
 *   exit != 0, has `error TS`  -> ordinary type errors; exit code passed through.
 *   exit != 0, no `error TS`   -> CRASH. Never report this as a typecheck result.
 *                                Names out-of-memory / outside kill / unknown crash
 *                                separately, since the fixes differ.
 *   exit 0, has `error TS`     -> defensive: the compiler contradicting itself, treated as
 *                                a crash rather than trusted.
 *
 * Scope
 * -----
 * The root tsconfig `include` covers `src`, `scripts`, each `packages` source dir — not the
 * test files (`pnpm run typecheck:tests`) and not `apps/*`, whose SvelteKit code is checked by
 * `svelte-check`. So a clean root run says nothing about the apps, and this command printed OK
 * over a planted type error in one of them (#4832). After a clean root run it therefore also
 * runs the per-app gate that CI uses (`scripts/ci/typecheck-apps.mjs`), unless
 * `scripts/typecheck-apps-gate.mjs` says not to (in CI, which gates them in its own step, or
 * under the tsc seam).
 *
 * 5.9 heap size (TYPECHECK_COMPILER=5 only)
 * -----------------------------------------
 * Measured cold on a clean checkout, with a deliberate type error in `src/` as a control:
 *
 *   node 24.18.1   4096 MB -> OOM, 0 diagnostics   4608 MB -> OOM, 0 diagnostics
 *                  5120 MB -> pass, error found    8192 MB -> pass, error found
 *   node 22.22.2   6144 MB -> pass, error found    8192 MB -> pass, error found
 *
 * Incremental runs need more heap than cold ones; the 8192 MB default can abort on one.
 * Override per run with TYPECHECK_HEAP_MB.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveTs7, TS7_INSTALL_COMMAND } from './lib/ts7.mjs';
import { typecheckAppsGateDecision } from './typecheck-apps-gate.mjs';
import { typecheckQueueDecision } from './typecheck-queue.mjs';

const require = createRequire(import.meta.url);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// A full typecheck costs up to ~8 GB, and several agents starting one at once is what pegs the
// box. With CIVITAI_TEST_QUEUE set this hands the run to the dev-server queue's typecheck lane,
// which spawns `pnpm run typecheck` back in this worktree with the flag off — so the child comes
// through here again and falls to the direct path below.
//
// Top-level await on purpose: a queued run never returns (the client exits the process with the
// run's verdict), so everything below is reached only when the queue could not take the run.
if (typecheckQueueDecision(process.argv.slice(2), process.env).queue) {
  const client = resolve(dirname(fileURLToPath(import.meta.url)), 'test-unit-run.mjs');
  if (existsSync(client)) {
    const { runQueued, queueAccepted } = await import(pathToFileURL(client).href);
    try {
      await runQueued([], { kind: 'typecheck', fallback: () => undefined });
    } catch (err) {
      if (queueAccepted()) {
        console.error(
          `Lost contact with the test queue (${err?.message ?? err}). The run may still be queued.`
        );
        process.exit(2);
      }
      console.error(`Typecheck queue failed (${err?.message ?? err}); running directly.`);
    }
  }
}

const compilerSetting = process.env.TYPECHECK_COMPILER ?? '';
if (!['', '5', '7'].includes(compilerSetting)) {
  console.error(
    `typecheck: TYPECHECK_COMPILER must be unset, 7 or 5 (TypeScript 5.9), got "${compilerSetting}"`
  );
  process.exit(2);
}
const useTs5 = compilerSetting === '5';

const DEFAULT_HEAP_MB = 8192;
const heapMb = Number(process.env.TYPECHECK_HEAP_MB || DEFAULT_HEAP_MB);
if (!Number.isFinite(heapMb) || heapMb <= 0) {
  console.error(
    `typecheck: TYPECHECK_HEAP_MB must be a positive number, got "${process.env.TYPECHECK_HEAP_MB}"`
  );
  process.exit(2);
}

// `pnpm run typecheck -- -p x` passes the `--` through; both compilers reject it (TS5023).
const userArgs = process.argv.slice(2).filter((a) => a !== '--');

// Single-threaded by default on dev machines (see header); an argument that already chooses a
// thread mode wins.
function ts7Args(args) {
  const out = ['--noEmit'];
  const choosesThreads = args.some((a) => a === '--singleThreaded' || a === '--checkers');
  if (!choosesThreads) out.push(...(process.env.CI ? ['--checkers', '2'] : ['--singleThreaded']));
  // TS7's .tsbuildinfo format differs from 5.9's; a separate file per project stops the two
  // compilers overwriting each other's cache. Named after the project's repo-relative path, so
  // two configs that share a file name do not share a cache.
  const managesIncremental = args.some(
    (a) => a === '--incremental' || a === '--tsBuildInfoFile' || a === '--build' || a === '-b'
  );
  const namesFiles = args.some((a) => /\.(c|m)?tsx?$/.test(a) && !a.endsWith('.json'));
  if (!managesIncremental && !namesFiles) {
    const pIndex = args.findIndex((a) => a === '-p' || a === '--project');
    const project = pIndex >= 0 ? args[pIndex + 1] ?? 'tsconfig.json' : 'tsconfig.json';
    const cacheDir = resolve(repoRoot, 'node_modules', '.cache', 'typecheck');
    mkdirSync(cacheDir, { recursive: true });
    const name = relative(repoRoot, resolve(project))
      .replace(/\.json$/, '')
      .replace(/[\\/]+/g, '-');
    out.push('--tsBuildInfoFile', resolve(cacheDir, `ts7-${name || 'tsconfig'}.tsbuildinfo`));
  }
  return [...out, ...args];
}

// TYPECHECK_TSC_PATH is a test seam: it lets the suite drive this classifier with a stub that
// exits the way a crashed / clean / erroring compiler does, without paying a real typecheck per
// case. The stub is a node script and replaces the compiler binary in either mode, receiving the
// arguments the real compiler would get (plus the 5.9 heap flag under TYPECHECK_COMPILER=5).
const seam = process.env.TYPECHECK_TSC_PATH;
let compilerLabel;
let command;
let commandArgs;

if (useTs5) {
  let tscPath = seam;
  if (!tscPath) {
    try {
      tscPath = require.resolve('typescript/lib/tsc.js');
    } catch {
      console.error('typecheck: cannot resolve typescript/lib/tsc.js — run `pnpm install` first.');
      process.exit(2);
    }
  }
  compilerLabel = `TypeScript 5.9 (TYPECHECK_COMPILER=5, heap cap ${heapMb} MB)`;
  command = process.execPath;
  commandArgs = [`--max-old-space-size=${heapMb}`, tscPath, '--noEmit', ...userArgs];
} else {
  const args = ts7Args(userArgs);
  const threads = args.includes('--singleThreaded') ? 'single-threaded' : 'multi-threaded';
  if (seam) {
    compilerLabel = `TypeScript 7 (test seam, ${threads})`;
    command = process.execPath;
    commandArgs = [seam, ...args];
  } else {
    let ts7;
    try {
      ts7 = await resolveTs7({ log: (line) => console.log(`typecheck: ${line}`) });
    } catch (err) {
      console.error(`typecheck: ${err?.message ?? err}`);
      console.error(`  Install it with: ${TS7_INSTALL_COMMAND}`);
      console.error(
        '  Or run TypeScript 5.9 for this run: TYPECHECK_COMPILER=5 pnpm run typecheck'
      );
      console.log(
        'typecheck: FAILED — TypeScript 7 is not available (see stderr). Nothing was checked.'
      );
      annotate('Typecheck did not run: TypeScript 7 could not be installed or resolved');
      process.exit(2);
    }
    compilerLabel = `TypeScript ${ts7.version} (${threads})`;
    command = ts7.exe;
    commandArgs = args;
  }
}

/**
 * Route types, generated BEFORE the compiler so it checks Next's route validator.
 *
 * `next build` writes `.next/types/validator.ts`, which asserts that every module under `src/pages`
 * has the default export a route needs. `tsconfig.json` already includes `.next/types/**\/*.ts`, but
 * on a fresh checkout that file does not exist yet, so a plain `tsc` never saw it, and a non-route
 * module under `src/pages` (a helper, a test file) passed typecheck and failed only `next build`.
 * `next typegen` writes the same files without building (measured ~2-3 s).
 *
 * Deterministic: `.next/types` is deleted first, so a file left by an earlier build or typegen
 * (a validator entry for a page since deleted, a types file an older Next wrote) can never be read.
 * `NEXT_DIST_DIR` is dropped for the child because `next.config.mjs` derives `distDir` from it,
 * and `tsconfig.json` names the literal `.next/types`. A dist dir elsewhere would put the validator
 * where `tsc` does not look, which is a silent pass.
 *
 * A typegen failure fails the typecheck (exit 2). A skipped validator is an absent check, not a
 * clean one. Skipped only under the TYPECHECK_TSC_PATH stub seam, whose cases never run real tsc.
 */
function generateRouteTypes() {
  rmSync(resolve(repoRoot, '.next', 'types'), { recursive: true, force: true });
  let nextBin;
  try {
    nextBin = require.resolve('next/dist/bin/next');
  } catch {
    console.error('typecheck: cannot resolve next/dist/bin/next — run `pnpm install` first.');
    process.exit(2);
  }
  const { NEXT_DIST_DIR: _ignored, ...env } = process.env;
  const t0 = Date.now();
  const res = spawnSync(process.execPath, [nextBin, 'typegen'], {
    cwd: repoRoot,
    env: { ...env, NODE_OPTIONS: '' },
    encoding: 'utf8',
  });
  const validator = resolve(repoRoot, '.next', 'types', 'validator.ts');
  if (res.status !== 0 || !existsSync(validator)) {
    console.error('typecheck: `next typegen` failed, so the route validator cannot be checked.');
    console.error(`  exit ${res.status}${res.signal ? `, signal ${res.signal}` : ''}`);
    if (res.stdout) console.error(res.stdout.trimEnd());
    if (res.stderr) console.error(res.stderr.trimEnd());
    annotate('Typecheck did not run: `next typegen` failed (route validator unavailable)');
    process.exit(2);
  }
  console.log(`typecheck: route types generated in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
}

if (!seam) generateRouteTypes();

// Naming the compiler on every run is what lets a reader of a pasted log tell which one produced it.
console.log(`typecheck: ${compilerLabel}.`);
const startedAt = Date.now();
const child = spawn(command, commandArgs, {
  // NODE_OPTIONS is dropped on purpose: the 5.9 heap cap is passed as an argv flag so an
  // inherited NODE_OPTIONS cannot silently override it, and so the value reported is the one
  // actually in force.
  env: { ...process.env, NODE_OPTIONS: '' },
  stdio: ['inherit', 'pipe', 'pipe'],
});

// Counted while streaming rather than buffered: a badly broken tree can emit
// tens of thousands of diagnostics, and this wrapper must not become the thing
// that runs out of memory.
let errorTsLines = 0;
let sawOom = false;
const tail = [];
const TAIL_LINES = 40;

const OOM_SIGNATURES = [
  // V8 (TypeScript 5.9)
  'JavaScript heap out of memory',
  'Ineffective mark-compacts near heap limit',
  'FATAL ERROR',
  // Go runtime (TypeScript 7)
  'runtime: out of memory',
];

function onLine(line) {
  // Diagnostics are `path(line,col): error TS####: message`. `--pretty` is not used by this
  // script, so the plain form is what arrives.
  if (line.includes('error TS')) errorTsLines++;
  if (OOM_SIGNATURES.some((sig) => line.includes(sig))) sawOom = true;
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
  console.error(`  The compiler (${compilerLabel}) ${how} after emitting 0 diagnostics.`);
  console.error(`  Cause: ${reason}`);
  console.error('');
  console.error('  The check did not finish, so it says NOTHING about whether the');
  console.error('  code typechecks. Do not read the absence of errors as a pass.');
  console.error('');
  console.error(`  Fix: ${remedy}`);
  if (useTs5) {
    console.error(`  Heap cap in force: --max-old-space-size=${heapMb} (MB).`);
    console.error('  Override with TYPECHECK_HEAP_MB=<mb> TYPECHECK_COMPILER=5 pnpm run typecheck');
  }
  if (tail.length) {
    console.error('');
    console.error(`  Last ${tail.length} line(s) of compiler output:`);
    for (const line of tail) console.error(`    ${line}`);
  }
  console.error('================================================================');
  annotate(`Typecheck crashed (${how}, 0 diagnostics emitted): ${reason}`);
}

child.on('error', (err) => {
  console.error(`typecheck: failed to start the compiler: ${err.message}`);
  process.exit(2);
});

child.on('close', async (code, signal) => {
  const crashed = signal !== null || code !== 0;

  if (!crashed) {
    if (errorTsLines > 0) {
      // The compiler printed diagnostics and still claimed success. Whatever that is, it
      // is not a verdict worth trusting.
      reportCrash({
        code,
        signal,
        reason: `the compiler exited 0 but printed ${errorTsLines} diagnostic line(s) — contradictory result`,
        remedy: 'investigate the compiler invocation; do not treat this run as a pass.',
      });
      process.exit(1);
    }
    // A clean `tsc --noEmit` prints NOTHING, so an empty log is exactly what a
    // crash-with-stderr-dropped looks like too. Stating success explicitly means
    // "the log has no errors in it" is no longer a thing anyone has to infer.
    console.log(
      `typecheck: OK — 0 type errors in ${((Date.now() - startedAt) / 1000).toFixed(0)}s, ` +
        `${compilerLabel}.`
    );

    // The run above is bounded by the root tsconfig `include`, which has no `apps/*` entry, so
    // on its own this command reports OK over a type error in any app (#4832). The apps are
    // checked by their own `typecheck` scripts, through the script CI uses.
    const appsGate = typecheckAppsGateDecision(process.env, userArgs);
    if (!appsGate.run) {
      console.log(`typecheck: apps/* not checked here — ${appsGate.why}.`);
      process.exit(0);
    }

    let runTypecheckApps;
    try {
      // In-process, the same function `pnpm run typecheck:apps` and CI call, so all three run the
      // same app set and report the same way.
      ({ runTypecheckApps } = await import('./ci/typecheck-apps.mjs'));
    } catch (err) {
      console.error(`typecheck: cannot load the apps/* gate (${err?.message ?? err}).`);
      process.exit(2);
    }

    let appsCode;
    try {
      appsCode = runTypecheckApps({
        // Resolve from this file, not cwd, so a copy of these scripts in a throwaway repo
        // discovers that repo's apps/ rather than this one.
        repoRoot,
      });
    } catch (err) {
      console.error(`typecheck: the apps/* gate could not run (${err?.message ?? err}).`);
      console.log('typecheck: FAILED — the apps/* gate could not run (see stderr).');
      process.exit(2);
    }
    if (appsCode !== 0) {
      console.error(
        '\ntypecheck: the root tsc run was clean, but an apps/* typecheck failed (above).'
      );
      // The OK line above went to stdout; a reader of stdout alone must see the verdict too.
      console.log('typecheck: FAILED — root clean, but an apps/* typecheck failed (see stderr).');
    }
    process.exit(appsCode);
  }

  if (errorTsLines > 0) {
    // The ordinary, useful failure: real type errors. Pass the verdict through
    // untouched so the existing developer experience is unchanged.
    console.error(`\ntypecheck: ${errorTsLines} type error(s).`);
    process.exit(code === 0 || code === null ? 1 : code);
  }

  if (sawOom && useTs5) {
    reportCrash({
      code,
      signal,
      reason: `V8 ran out of old-space heap at ${heapMb} MB`,
      remedy:
        'raise the cap — TYPECHECK_HEAP_MB=<larger> to confirm, then raise ' +
        'DEFAULT_HEAP_MB in this script (and check the CI runner has the RAM for it).',
    });
  } else if (sawOom) {
    reportCrash({
      code,
      signal,
      reason: 'the machine ran out of memory for the compiler',
      remedy:
        'free memory or run fewer typechecks at once (CIVITAI_TEST_QUEUE=1 serialises them); ' +
        'in CI, give the job more memory.',
    });
  } else if (signal === 'SIGKILL' || code === 137) {
    reportCrash({
      code,
      signal,
      reason:
        'the process was killed from outside (out of system memory, or a job/container limit)',
      remedy: useTs5
        ? 'give the machine or runner more RAM, or LOWER the heap cap so V8 stays ' +
          'inside it — a cap above available RAM turns into an unhelpful kill.'
        : 'give the machine or runner more RAM, or run fewer typechecks at once.',
    });
  } else {
    reportCrash({
      code,
      signal,
      reason: 'the compiler terminated abnormally without producing any diagnostics',
      remedy: 'read the compiler output above; this is a tooling failure, not a code failure.',
    });
  }
  process.exit(code === 0 || code === null ? 1 : code);
});
