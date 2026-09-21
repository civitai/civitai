#!/usr/bin/env node
/**
 * A fast, NON-AUTHORITATIVE typecheck, for the edit loop only.
 *
 * Runs TypeScript 7 (native) instead of the 5.9 the repo is pinned to. Measured 2026-09-21 on
 * this repo, `pnpm run typecheck:fast`: 29s cold, 6s warm. `pnpm run typecheck` on the same
 * tree the same evening: 192s, 340s, 385s, 539s across four runs — it varies that much because
 * the box is shared, which is the honest comparison rather than a single ratio. TS7's program
 * is 12,698 files against 5.9's 12,761, so it is not reaching its answer by checking less.
 *
 * It is a DIFFERENT compiler, it disagrees with 5.9 in both directions, and
 * `pnpm run typecheck` remains the only verdict that counts.
 *
 * Known disagreement in this direction: TS 7.0.2 reports `(a ?? null) ?? b` as TS2871
 * "This expression is always nullish", while typing that same operand `string | null` in
 * assignment position. So a diagnostic from here is a lead, not a fact.
 *
 * The compiler lives in `tools/ts7/`, which is deliberately NOT a workspace package: merely
 * being in the workspace re-resolved msw's optional `typescript` peer from 5.9.3 to 7.0.2
 * across twelve unrelated importers, silently and with `pnpm install` exiting 0.
 *
 * Crash classification is taken from `scripts/typecheck.mjs`, for the same reason it exists
 * there: a clean `tsc --noEmit` prints nothing, so an empty log plus a non-zero exit is
 * indistinguishable from a pass to anything reading the output. A native binary will not
 * exhaust a V8 heap the way 5.9 did, but that changes WHICH failure prints nothing, not
 * whether printing nothing can lie.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const NOT_AUTHORITATIVE =
  'typecheck:fast is NOT authoritative — `pnpm run typecheck` (TypeScript 5.9) is the verdict.';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// This lane takes NO arguments, and forwarding them is not a harmless convenience: tsc's
// parser is last-wins, so a caller-supplied `-p` silently replaced the project and
// `--version` made it print nothing and exit 0 — which this wrapper then reported as
// "0 diagnostics". A clean verdict for a check that never ran is the exact failure the
// whole script exists to prevent.
const passthrough = process.argv.slice(2);
if (passthrough.length) {
  console.error(`typecheck:fast: takes no arguments (got: ${passthrough.join(' ')}).`);
  console.error('  It always checks the whole project, so that "0 diagnostics" cannot mean');
  console.error('  "the compiler was asked to check nothing".');
  console.error('');
  console.error('  To narrow a check, use the authoritative lane: pnpm run typecheck <args>');
  process.exit(2);
}
const ts7Dir = resolve(repoRoot, 'tools/ts7/node_modules/typescript');

// TYPECHECK_FAST_TSC_PATH is a test seam, matching TYPECHECK_TSC_PATH in typecheck.mjs: it
// lets the suite drive this classifier with a stub that exits clean / erroring / crashed.
// The stub is a node script, so it runs under process.execPath; the real compiler is a
// native binary and is spawned directly.
const seam = process.env.TYPECHECK_FAST_TSC_PATH;
let exe = seam;
let resolvedVersion = 'unknown (test seam)';

if (!exe) {
  const resolver = resolve(ts7Dir, 'lib/getExePath.js');
  if (!existsSync(resolver)) {
    console.error('typecheck:fast: TypeScript 7 is not installed.');
    console.error('');
    console.error('  run: pnpm -C tools/ts7 install');
    console.error('');
    console.error('  It is intentionally outside the pnpm workspace, so a root `pnpm install`');
    console.error('  does not fetch it. That one command is the whole setup.');
    process.exit(2);
  }
  try {
    const { default: getExePath } = await import(pathToFileURL(resolver).href);
    exe = getExePath();
    const pkg = await import(pathToFileURL(resolve(ts7Dir, 'package.json')).href, {
      with: { type: 'json' },
    });
    resolvedVersion = pkg.default.version;
  } catch (err) {
    console.error(`typecheck:fast: could not resolve the TypeScript 7 binary: ${err?.message ?? err}`);
    console.error('  run: pnpm -C tools/ts7 install');
    process.exit(2);
  }
}

// Naming the version every run is what lets a reader of a pasted log tell which compiler
// produced it, and is the cheapest guard against a stale tools/ts7.
console.log(`typecheck:fast — TypeScript ${resolvedVersion}. ${NOT_AUTHORITATIVE}`);

const buildInfo = resolve(repoRoot, 'node_modules/.cache/typecheck-fast/tsconfig.tsbuildinfo');
const startedAt = Date.now();
const args = ['--noEmit', '-p', 'tsconfig.json', '--tsBuildInfoFile', buildInfo];
const child = seam
  ? spawn(process.execPath, [exe, ...args], { cwd: repoRoot, stdio: ['inherit', 'pipe', 'pipe'] })
  : spawn(exe, args, { cwd: repoRoot, stdio: ['inherit', 'pipe', 'pipe'] });

let errorTsLines = 0;
const tail = [];
const TAIL_LINES = 40;

function onLine(line) {
  if (line.includes('error TS')) errorTsLines++;
  tail.push(line);
  if (tail.length > TAIL_LINES) tail.shift();
}

function wire(stream, sink) {
  let residual = '';
  stream.on('data', (chunk) => {
    sink.write(chunk);
    const text = residual + chunk.toString();
    const lines = text.split(/\r?\n/);
    residual = lines.pop() ?? '';
    for (const line of lines) onLine(line);
  });
  stream.on('end', () => {
    if (residual) onLine(residual);
  });
}

wire(child.stdout, process.stdout);
wire(child.stderr, process.stderr);

function reportCrash(reason) {
  // Nothing printed here may contain the literal `error TS`, or a crash report reads as a
  // diagnostic to anything grepping for one.
  console.log(`TYPECHECK:FAST CRASHED: ${reason}. NOT a typecheck result — see stderr.`);
  console.error('');
  console.error('================================================================');
  console.error('  typecheck:fast CRASHED — THIS IS NOT A TYPECHECK RESULT');
  console.error('================================================================');
  console.error(`  Cause: ${reason}`);
  console.error('');
  console.error('  The check did not finish, so it says NOTHING about whether the');
  console.error('  code typechecks. Do not read the absence of diagnostics as a pass.');
  console.error('');
  console.error('  Fall back to `pnpm run typecheck`, which is authoritative anyway.');
  if (tail.length) {
    console.error('');
    console.error(`  Last ${tail.length} line(s) of output:`);
    for (const line of tail) console.error(`    ${line}`);
  }
  console.error('================================================================');
}

child.on('error', (err) => {
  console.error(`typecheck:fast: failed to start the compiler: ${err.message}`);
  process.exit(2);
});

child.on('close', (code, signal) => {
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(0);
  const crashed = signal !== null || code !== 0;

  if (!crashed && errorTsLines === 0) {
    console.log(`typecheck:fast: 0 diagnostics in ${seconds}s (TypeScript ${resolvedVersion}).`);
    console.log(NOT_AUTHORITATIVE);
    process.exit(0);
  }

  if (crashed && errorTsLines > 0) {
    console.error(`\ntypecheck:fast: ${errorTsLines} diagnostic line(s) in ${seconds}s.`);
    console.error(NOT_AUTHORITATIVE);
    process.exit(code === 0 || code === null ? 1 : code);
  }

  reportCrash(
    crashed
      ? `the compiler terminated abnormally (code ${code}, signal ${signal}) after emitting 0 diagnostics`
      : `the compiler exited 0 but printed ${errorTsLines} diagnostic line(s) — contradictory result`
  );
  console.error(NOT_AUTHORITATIVE);
  process.exit(code === 0 || code === null ? 1 : code);
});
