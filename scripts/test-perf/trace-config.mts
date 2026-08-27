/**
 * Module-execution tracer for the unit suite.
 *
 *   pnpm exec vitest run --project unit-trace --config scripts/test-perf/trace-config.mts \
 *     --max-workers=1 path/to/one.test.ts
 *
 * ⚠️ NOT via `bench.mjs`: that harness hardcodes `--project unit` (bench.mjs:68) and this config
 * deliberately names its project `unit-trace` (see below), so the pairing this docstring used to
 * advertise now exits 1 with `No projects matched the filter "unit"`. It fails loudly, so it is
 * recorded here rather than papered over by widening bench.mjs's filter, which would silently drag
 * the `unit-native` project into every yardstick run.
 *
 * The suite's cost is module EXECUTION, not assertions, and a static import graph can't see it:
 * a `vi.mock` factory stops the real module (and its subtree) from ever running, so the static
 * closure overstates by an unknown amount. This appends one counter call to the end of every
 * transformed first-party module, so what we count is what actually ran.
 *
 * Writes one `.test-perf/trace/<worker>.json` per worker; `node scripts/test-perf/trace-report.mjs`
 * merges them by SUMMING, which is why the directory is cleared below at the start of every run.
 */
import base from '../../vitest.config.mts';
import path from 'path';
import { existsSync, readdirSync, rmSync } from 'fs';
import { fileURLToPath } from 'url';
import { SNAPSHOT_FILE_RE } from './trace-snapshot-name';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// 🔴 Snapshots from a PREVIOUS run are indistinguishable from this run's once they are on disk, and
// `trace-report.mjs` sums every `*.json` it finds — so without this, a second traced run reports
// roughly doubled `loads`/`selfMs`/`totalMs` and nothing looks wrong. Cleared here, in the main
// process at config load, rather than in the workers, which would race each other. The cost is that
// two traced runs must not overlap; use TESTPERF_TRACE_DIR to give one of them its own directory.
//
// Deletes the SNAPSHOTS, not the directory: TESTPERF_TRACE_DIR is caller-supplied, so removing the
// directory itself would destroy whatever else the caller keeps there, and it turned a clean
// assertion in the regression test into an ENOENT crash when the directory it had just created
// vanished underneath it.
// Scoped to THIS tool's snapshot filenames, not to `*.json`: TESTPERF_TRACE_DIR is caller-supplied
// and the README invites pointing it anywhere, so an unscoped delete would destroy a directory's
// other JSON without asking. The shape is `<pid>-<suffix>.json`, written by trace-setup.ts.
// Wrapped because a throw here happens at CONFIG LOAD and would abort the entire run with a raw
// stack — e.g. a directory that happens to match the pattern (`force` is not `recursive`), or
// TESTPERF_TRACE_DIR pointing at a file.
const traceDir = process.env.TESTPERF_TRACE_DIR ?? path.join(repoRoot, '.test-perf/trace');
try {
  if (existsSync(traceDir))
    for (const f of readdirSync(traceDir))
      if (SNAPSHOT_FILE_RE.test(f)) rmSync(path.join(traceDir, f), { force: true });
} catch (err) {
  process.stderr.write(
    `[trace-config] could not clear old snapshots in ${traceDir}: ${String(err)}\n` +
      `[trace-config] the report SUMS snapshots, so stale ones will inflate this run's numbers\n`
  );
}

const tracer = {
  name: 'civitai:module-trace',
  enforce: 'post' as const,
  transform(code: string, id: string) {
    if (id.includes('/node_modules/')) return null;
    if (!/\.[cm]?[jt]sx?($|\?)/.test(id)) return null;
    const rel = path.relative(repoRoot, id.split('?')[0]).replace(/\\/g, '/');
    if (rel.startsWith('..')) return null;
    // Prepended AND appended: the pair brackets the module body, so a module that is slow because
    // of its own top-level work is distinguishable from one that is slow because of what it imports.
    return {
      code:
        `globalThis.__modTraceIn && globalThis.__modTraceIn(${JSON.stringify(rel)});\n` +
        code +
        `\n;globalThis.__modTraceOut && globalThis.__modTraceOut(${JSON.stringify(rel)});`,
      map: null,
    };
  },
};

const unit = (base as any).test.projects.find((p: any) => p?.test?.name === 'unit');

export default {
  ...base,
  test: {
    ...(base as any).test,
    projects: [
      {
        ...unit,
        plugins: [tracer],
        test: {
          ...unit.test,
          // 🔴 NOT 'unit', and this is a correctness requirement rather than a label. Vitest keys a
          // project's dep-optimizer cache on sha1(projectName), and Vite's own config hash includes
          // the PLUGIN NAMES — so a traced project called 'unit' resolves to the SAME
          // `node_modules/.vite/vitest/<hash>/deps_ssr` as the normal unit suite while hashing
          // differently, and Vite responds by deleting and re-bundling that directory. Measured: a
          // 53-file selection that includes a traced child run went 16 files RED with
          // `Cannot find module '…/deps_ssr/prom-client.js'`, because unrelated workers were
          // importing those chunks while they were being rewritten underneath them.
          name: 'unit-trace',
          setupFiles: [
            path.join(repoRoot, 'scripts/test-perf/trace-setup.ts').replace(/\\/g, '/'),
            ...unit.test.setupFiles,
          ],
        },
      },
    ],
  },
};
