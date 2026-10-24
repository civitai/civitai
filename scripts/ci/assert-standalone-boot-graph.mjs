#!/usr/bin/env node
/**
 * Blocking guard: every module the standalone entrypoint statically requires can actually be
 * LOADED from the shipped filesystem.
 *
 * WHY THIS EXISTS. `output: 'standalone'` does not ship `node_modules`; it ships the subset
 * @vercel/nft traced. nft resolves a bare specifier with its own condition set, and Node
 * resolves the same specifier at runtime with ITS condition set. When the two disagree, the
 * build traces one file and the process asks for a different one — the build is green, every
 * source-level gate is green, and the container cannot boot.
 *
 * That is not hypothetical. Next's `dist/shared/lib/constants.js` does
 * `require('@swc/helpers/_/_interop_require_default')`. On `@swc/helpers` 0.5.15 that subpath
 * exported `{ import, default }`, so a CJS require and nft both landed on
 * `cjs/_interop_require_default.cjs`. 0.5.17+ added a `module-sync` condition pointing at
 * `esm/_interop_require_default.js`; Node (>= 22.10) honours `module-sync` for `require`,
 * nft does not. Next 16.3.1 bumped its own `@swc/helpers` dependency 0.5.15 -> 0.5.23, so the
 * traced image carried only `cjs/` and the pod crash-looped on
 * `MODULE_NOT_FOUND .../@swc/helpers/esm/_interop_require_default.js` before the first line of
 * application code ran (civitai#4075).
 *
 * WHAT IT ASSERTS, AND WHY THAT IS THE RIGHT INVARIANT. It does not name a package, a version,
 * a pnpm virtual-store directory or a patch hash — every one of those rots. It reads the
 * GENERATED `server.js` for the specifiers that process actually requires at module scope, and
 * loads them in a child process rooted at the shipped tree. So it tracks whatever Next emits:
 * if a future Next requires something else, or a future dependency flips another condition, the
 * same assertion covers it with no edit here.
 *
 * WHERE IT MUST RUN. Against the runtime filesystem — the runner stage, where `/app` is exactly
 * what ships — NOT against the builder, whose complete `node_modules` sits above `.next/standalone`
 * on the resolution path and can satisfy a require the shipped image cannot.
 *
 * Exit codes: 0 pass, 1 a required module could not be loaded, 2 the check could not observe its
 * input (no root, no `node_modules`, no specifiers found) — a scan that sees nothing must not
 * report health.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, resolve } from 'node:path';

const CHILD_TIMEOUT_MS = 180_000;

const root = resolve(process.argv[2] ?? '.next/standalone');
const entry = join(root, 'server.js');

/** Node builtins are always resolvable and prove nothing about the trace. */
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

function fail2(message) {
  console.error(`FAIL (cannot observe input): ${message}`);
  process.exit(2);
}

if (!existsSync(root)) fail2(`standalone root ${root} does not exist`);
if (!existsSync(entry)) fail2(`${entry} does not exist — this is not a standalone output tree`);
if (!existsSync(join(root, 'node_modules')))
  fail2(`${join(root, 'node_modules')} does not exist — nothing was traced into this tree`);

const source = readFileSync(entry, 'utf8');

// Only UNINDENTED lines. The generated server.js is flat, so column 0 is module scope — which
// keeps two things out: a lazily-required module inside a function body (requiring it eagerly
// here could fail for reasons that are not a trace gap, and a gate that is permanently red is
// worse than no gate), and any `require('…')` that happens to sit inside the inlined
// `const nextConfig = {…}` JSON on its own line. Specifiers never contain whitespace or a
// scheme; anything that does is text, not a module.
const specifiers = [
  ...new Set(
    source
      .split('\n')
      .filter((line) => /^\S/.test(line))
      .flatMap((line) =>
        [...line.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
      )
      .filter((s) => !BUILTINS.has(s) && !/\s|:\/\//.test(s))
  ),
];

if (specifiers.length === 0)
  fail2(
    `found no non-builtin require() specifier in ${entry}. Either Next changed how it emits the ` +
      'standalone entrypoint or this file is not the entrypoint; either way this check proved nothing.'
  );

console.log(`standalone root : ${root}`);
console.log(`entrypoint      : ${entry}`);
console.log(`specifiers      : ${specifiers.join(', ')}`);

// Load them the way the real process does: a child rooted at the shipped tree, so resolution
// walks the shipped node_modules and nothing above it.
const probe = specifiers
  .map((s) => `require(${JSON.stringify(s)}); console.log('  ok  ' + ${JSON.stringify(s)});`)
  .join('\n');

const child = spawnSync(process.execPath, ['-e', probe], {
  cwd: root,
  encoding: 'utf8',
  timeout: CHILD_TIMEOUT_MS,
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
});

if (child.stdout) process.stdout.write(child.stdout);

if (child.status === 0) {
  console.log(`\nOK: all ${specifiers.length} entrypoint module(s) load from the shipped tree.`);
  process.exit(0);
}

if (child.stderr) process.stderr.write(child.stderr);
console.error(
  `\nFAIL: the standalone entrypoint's own require graph does not load from ${root}` +
    (child.signal ? ` (child killed by ${child.signal})` : ` (exit ${child.status})`) +
    '.\n' +
    'The container will crash-loop on boot before any application code runs. A MODULE_NOT_FOUND\n' +
    'here means @vercel/nft traced a different file than Node resolves — typically an `exports`\n' +
    'condition mismatch (`module-sync`/`import` vs `require`). Fix it by force-including the\n' +
    "package's runtime files via `outputFileTracingIncludes` in next.config.mjs; do not pin the\n" +
    'virtual-store path or version, use a wildcard so it survives the next bump.'
);
process.exit(1);
