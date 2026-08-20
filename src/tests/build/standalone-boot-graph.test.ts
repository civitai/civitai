import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Regression guard for the civitai#4075 boot crash, and for the gate that catches it.
 *
 * WHAT BROKE. `output: 'standalone'` does not ship `node_modules`; it ships the subset
 * @vercel/nft traced. nft resolves a bare specifier under the `require`/`default` conditions.
 * Node (>= 22.10) additionally honours `module-sync` for a CJS `require`. When a package's
 * `exports` map points those two at different files, the build traces one file and the running
 * process asks for the other.
 *
 * Next's own `dist/shared/lib/constants.js` does
 * `require('@swc/helpers/_/_interop_require_default')`, reached from the generated `server.js`
 * via `next` -> `config.js` -> `constants.js`. On @swc/helpers 0.5.15 (next 16.3.0) that subpath
 * exported only `{ import, default }` and both resolvers landed on
 * `cjs/_interop_require_default.cjs`. 0.5.17+ added `module-sync` ->
 * `esm/_interop_require_default.js`, and next 16.3.1 bumped its dependency to 0.5.23. The image
 * therefore shipped `cjs/` only and every pod crash-looped with
 * `MODULE_NOT_FOUND .../@swc/helpers/esm/_interop_require_default.js` before the first line of
 * application code ran.
 *
 * 🔴 WHY NO SOURCE-LEVEL TEST COULD HAVE CAUGHT IT. The source tree was correct, the lockfile
 * was correct, the build succeeded, and the unit suite, typecheck, ESLint and the compiled-branch
 * gate were all green. The defect exists only in the file SET of the produced artefact. The only
 * red signal was the deploy.
 *
 * WHAT THIS TEST PINS. Not the specific package — @swc/helpers is the instance, not the class,
 * and naming it here would make this test rot on the next bump. It builds a miniature standalone
 * tree that reproduces the MECHANISM (a `module-sync`/`default` split where only the `default`
 * branch was "traced") and asserts that `scripts/ci/assert-standalone-boot-graph.mjs`:
 *
 *   - goes RED (exit 1) on it, naming the module that could not be found;
 *   - goes GREEN (exit 0) on the same tree once the `module-sync` target is present;
 *   - exits 2 — never 0 — when it cannot observe its input.
 *
 * The gate itself was additionally watched red and green against the real published PR image:
 * `docker run --rm -v <script>:/probe.mjs --entrypoint node <image> /probe.mjs /app` exited 1 with
 * this exact MODULE_NOT_FOUND on the broken image, and 0 on the same image with the missing
 * `esm/` directory added and nothing else changed.
 */

const SCRIPT = join(process.cwd(), 'scripts/ci/assert-standalone-boot-graph.mjs');

function run(...args: string[]) {
  // spawnSync, not execFileSync: the latter throws on a non-zero exit, which is the outcome
  // half these cases are asserting.
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

/**
 * A miniature standalone tree: an entrypoint that requires one package, and a package whose
 * `exports` map splits `module-sync` (what Node picks for a CJS require) from `default` (what
 * the tracer picks). `traceModuleSync: false` is the shipped-image bug — the `default` branch is
 * present, the `module-sync` branch is not.
 */
function makeTree(root: string, { traceModuleSync }: { traceModuleSync: boolean }) {
  const pkg = join(root, 'node_modules', 'condition-split');
  mkdirSync(join(pkg, 'cjs'), { recursive: true });
  mkdirSync(join(pkg, 'esm'), { recursive: true });

  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({
      name: 'condition-split',
      version: '1.0.0',
      type: 'module',
      exports: {
        '.': {
          'module-sync': './esm/index.js',
          import: './esm/index.js',
          default: './cjs/index.cjs',
        },
      },
    })
  );
  writeFileSync(join(pkg, 'cjs', 'index.cjs'), 'exports._ = 1;\n');
  if (traceModuleSync) writeFileSync(join(pkg, 'esm', 'index.js'), 'export const _ = 1;\n');

  writeFileSync(
    join(root, 'server.js'),
    ["const path = require('path')", "require('condition-split')", 'console.log(path.sep)'].join(
      '\n'
    )
  );
}

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'standalone-boot-graph-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('scripts/ci/assert-standalone-boot-graph.mjs', () => {
  it('is red when the module-sync target was not traced into the tree', () => {
    const root = join(dir, 'broken');
    makeTree(root, { traceModuleSync: false });

    const res = run(root);

    expect(res.status).toBe(1);
    // The specific failure, not merely "something failed": a different defect passing this
    // assertion would make the red arm meaningless.
    expect(`${res.stdout}${res.stderr}`).toContain('MODULE_NOT_FOUND');
    // Node prints the unresolved specifier as a NATIVE path, so the separator is a backslash on
    // Windows and the POSIX form below would never match there.
    expect(`${res.stdout}${res.stderr}`.split(sep).join('/')).toContain('esm/index.js');
    expect(res.stderr).toContain('does not load from');
  });

  it('is green on the same tree once the module-sync target is present', () => {
    const root = join(dir, 'fixed');
    makeTree(root, { traceModuleSync: true });

    const res = run(root);

    expect(res.stderr).toBe('');
    expect(res.status).toBe(0);
    // Positive control: it really loaded the package rather than skipping it.
    expect(res.stdout).toContain('ok  condition-split');
    expect(res.stdout).toContain('OK: all 1 entrypoint module(s) load');
  });

  it('never reports a builtin-only entrypoint as healthy', () => {
    const root = join(dir, 'builtins-only');
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    writeFileSync(join(root, 'server.js'), "const path = require('path')\nconsole.log(path.sep)\n");

    const res = run(root);

    // 2, not 0: a check with nothing to observe must not certify the artefact.
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('cannot observe input');
  });

  it('exits 2 when the standalone root or entrypoint is absent', () => {
    expect(run(join(dir, 'no-such-dir')).status).toBe(2);

    const empty = join(dir, 'empty');
    mkdirSync(empty, { recursive: true });
    expect(run(empty).status).toBe(2);
  });

  it('exits 2 when nothing was traced into the tree at all', () => {
    const root = join(dir, 'no-node-modules');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'server.js'), "require('condition-split')\n");

    const res = run(root);

    expect(res.status).toBe(2);
    expect(res.stderr).toContain('node_modules');
  });
});
