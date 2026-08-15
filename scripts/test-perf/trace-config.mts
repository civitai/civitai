/**
 * Module-execution tracer for the unit suite.
 *
 *   node scripts/test-perf/bench.mjs --label trace --workers 4 -- --config scripts/test-perf/trace-config.mts
 *
 * The suite's cost is module EXECUTION, not assertions, and a static import graph can't see it:
 * a `vi.mock` factory stops the real module (and its subtree) from ever running, so the static
 * closure overstates by an unknown amount. This appends one counter call to the end of every
 * transformed first-party module, so what we count is what actually ran.
 *
 * Writes `.test-perf/trace/<pid>.json` per worker; `node scripts/test-perf/trace-report.mjs`
 * merges them.
 */
import base from '../../vitest.config.mts';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

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
          setupFiles: [
            path.join(repoRoot, 'scripts/test-perf/trace-setup.ts').replace(/\\/g, '/'),
            ...unit.test.setupFiles,
          ],
        },
      },
    ],
  },
};
