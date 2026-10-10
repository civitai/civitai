import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { recordsFor } from '../test-cache/core.mjs';
import TestCacheReporter from '../test-cache/reporter.mjs';
import TestCacheSequencer from '../test-cache/sequencer.mjs';

/**
 * The reporter and sequencer driven with fake vitest objects, so each guard can be reverted and
 * seen to fail. Every case below was a false skip, or a hole in the check that catches one, found
 * by adversarial review of this cache and reproduced on a fixture before it was fixed.
 */

type Node = { id: string; importedModules: Set<Node> };
type State = {
  hits: Set<string>;
  sampled: Set<string>;
  skipped: string[];
  startedAt: number;
  bailed?: string | null;
};

const fwd = (p: string) => p.replace(/\\/g, '/');
let root: string;
let cacheDir: string;

function graphOf(edges: Record<string, string[]>) {
  const nodes = new Map<string, Node>();
  const node = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, { id, importedModules: new Set() });
    return nodes.get(id)!;
  };
  for (const [from, tos] of Object.entries(edges)) {
    node(from);
    for (const to of tos) node(from).importedModules.add(node(to));
  }
  return { getModuleById: (id: string) => nodes.get(id) };
}

function write(rel: string, content = rel) {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), content);
}

function testModule(
  rel: string,
  {
    passed = true,
    deps = [] as string[],
    reads = [] as string[],
    setupFiles = [] as string[],
    edges = {} as Record<string, string[]>,
    loaded = undefined as string[] | undefined,
    loadedSelf = true,
  } = {}
) {
  const abs = fwd(join(root, rel));
  const at = (r: string) => (r.startsWith('/') || /^[A-Za-z]:/.test(r) ? r : fwd(join(root, r)));
  const graph = graphOf({
    [abs]: deps.map(at),
    ...Object.fromEntries(Object.entries(edges).map(([from, tos]) => [at(from), tos.map(at)])),
  });
  return {
    moduleId: abs,
    project: {
      name: 'unit',
      config: { setupFiles: setupFiles.map((s) => fwd(join(root, s))) },
      vite: { environments: { ssr: { moduleGraph: graph } } },
    },
    meta: () => ({
      testCacheReads: reads.map((r) => join(root, r)),
      ...(loaded ? { testCacheLoaded: [...(loadedSelf ? [abs] : []), ...loaded.map(at)] } : {}),
    }),
    diagnostic: () => ({}),
    state: () => (passed ? 'passed' : 'failed'),
    children: {
      *allTests() {
        yield { result: () => ({ state: passed ? 'passed' : 'failed' }) };
      },
    },
  };
}

function run(
  modules: ReturnType<typeof testModule>[],
  { errors = [] as unknown[], state = {} as Partial<State> } = {}
) {
  (globalThis as { __civitaiTestCache?: State }).__civitaiTestCache = {
    hits: new Set(),
    sampled: new Set(),
    skipped: [],
    // Well in the future, so nothing counts as changed during the run unless a case says so.
    startedAt: Date.now() + 60_000,
    ...state,
  };
  const reporter = new TestCacheReporter();
  reporter.onInit({ config: { root }, version: 'test' } as never);
  reporter.onTestRunEnd(modules as never, errors as never, 'passed' as never);
}

/** How many stored records name `rel` as their test file's own entry. */
function records(rel: string) {
  const recDir = join(cacheDir, 'rec');
  if (!existsSync(recDir)) return 0;
  let n = 0;
  for (const d of readdirSync(recDir)) {
    for (const f of readdirSync(join(recDir, d))) {
      const body = JSON.parse(readFileSync(join(recDir, d, f), 'utf8'));
      if (body.entries.includes(rel)) n += 1;
    }
  }
  return n;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'test-cache-root-'));
  cacheDir = mkdtempSync(join(tmpdir(), 'test-cache-dir-'));
  vi.stubEnv('CIVITAI_TEST_CACHE', 'on');
  vi.stubEnv('CIVITAI_TEST_CACHE_DIR', cacheDir);
  vi.stubEnv('CI', '');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  delete (globalThis as { __civitaiTestCache?: State }).__civitaiTestCache;
});

describe('recording a pass', () => {
  // The positive control every case below leans on: without it, "not recorded" passes vacuously —
  // which is exactly how an earlier round of these fixes certified itself while recording nothing.
  it('records an ordinary passing file', () => {
    write('a.test.ts');
    write('dep.ts');
    run([testModule('a.test.ts', { deps: ['dep.ts'] })]);
    expect(records('a.test.ts')).toBe(1);
  });

  /**
   * The control above, shaped like a REAL test file — the shape the fakes first left out. Every real
   * test probes a snapshot path in a `__snapshots__` directory that usually never existed, and its
   * setup closure reaches Redis code where `'cluster'` is an ordinary value. Review measured each of
   * those, separately, making every one of the repo's 1880 unit tests unrecordable while the plain
   * control stayed green.
   */
  it('records a file shaped like a real one: snapshot probe, and a setup closure mentioning cluster', () => {
    write('src/a.test.ts');
    write('src/__tests__/setup.ts');
    write('packages/redis/client.ts', "export const opts = { client: 'cluster' };");
    const abs = (r: string) => fwd(join(root, r));
    const m = testModule('src/a.test.ts', {
      reads: ['src/__snapshots__/a.test.ts.snap'],
      setupFiles: ['src/__tests__/setup.ts'],
    });
    const g = m.project.vite.environments.ssr.moduleGraph as ReturnType<typeof graphOf>;
    const setupGraph = graphOf({
      [abs('src/a.test.ts')]: [],
      [abs('src/__tests__/setup.ts')]: [abs('packages/redis/client.ts')],
    });
    m.project.vite.environments.ssr.moduleGraph = {
      getModuleById: (id: string) => g.getModuleById(id) ?? setupGraph.getModuleById(id),
    };
    run([m]);
    expect(records('src/a.test.ts')).toBe(1);
  });

  it('refuses a file whose input changed after the run started', () => {
    write('a.test.ts');
    write('dep.ts');
    run([testModule('a.test.ts', { deps: ['dep.ts'] })], { state: { startedAt: 0 } });
    expect(records('a.test.ts')).toBe(0);
  });

  // The test ran WITH the module; recording its absence would skip it green next time.
  it('refuses a file whose imported module is gone by the end of the run', () => {
    write('a.test.ts');
    run([testModule('a.test.ts', { deps: ['deleted.ts'] })]);
    expect(records('a.test.ts')).toBe(0);
  });

  it('refuses a file whose HELPER makes a computed import', () => {
    write('a.test.ts');
    write('helper.ts', 'export const load = (f: string) => import(/* @vite-ignore */ f);');
    run([testModule('a.test.ts', { deps: ['helper.ts'] })]);
    expect(records('a.test.ts')).toBe(0);
  });

  it('refuses a file whose helper reaches child_process by any syntax', () => {
    write('a.test.ts');
    write('helper.ts', "const cp = process.getBuiltinModule('node:child_process');");
    run([testModule('a.test.ts', { deps: ['helper.ts'] })]);
    expect(records('a.test.ts')).toBe(0);
  });
});

/** The entries of the one record for `rel`. */
function entriesOf(rel: string): string[] {
  const found = (recordsFor as (d: string, p: string, t: string) => { entries: string[] }[])(
    cacheDir,
    'unit',
    rel
  );
  expect(found).toHaveLength(1);
  return found[0].entries;
}

describe('modules the file never loaded', () => {
  // The graph is shared by the whole run: m.ts carries c.ts because ANOTHER file loaded it for real.
  // This file replaced m.ts with a vi.mock factory, so its runner never started m.ts.
  const shape = { deps: ['a.ts', 'm.ts'], edges: { 'a.ts': ['b.ts'], 'm.ts': ['c.ts'] } };
  const files = () => ['a.test.ts', 'a.ts', 'b.ts', 'm.ts', 'c.ts'].forEach((f) => write(f));

  it('keys the mocked module but not the subtree a sibling loaded under it', () => {
    files();
    run([testModule('a.test.ts', { ...shape, loaded: ['a.ts', 'b.ts'] })]);
    expect(entriesOf('a.test.ts').sort()).toEqual(['a.test.ts', 'a.ts', 'b.ts', 'm.ts']);
  });

  // The control for the case above, and the fallback: a tracker that reported nothing (an older
  // tree, a vitest without the internal) must key exactly as before, on the whole subtree.
  it('walks the whole graph when the file reported nothing about what it loaded', () => {
    files();
    run([testModule('a.test.ts', shape)]);
    expect(entriesOf('a.test.ts').sort()).toEqual(['a.test.ts', 'a.ts', 'b.ts', 'c.ts', 'm.ts']);
  });

  // Windows hands the same file back with a different drive-letter or segment case.
  it('matches what the file loaded regardless of case', () => {
    files();
    run([
      testModule('a.test.ts', {
        ...shape,
        loaded: ['a.ts', 'b.ts', 'M.TS'].map((r) => fwd(join(root, r)).toUpperCase()),
      }),
    ]);
    expect(entriesOf('a.test.ts')).toContain('c.ts');
  });

  // A list that does not name the test file itself cannot be a record of what loaded: a vitest whose
  // module-state fields changed would report nothing loaded, and narrow every key to direct imports.
  it('walks the whole graph when the report does not include the test file itself', () => {
    files();
    run([testModule('a.test.ts', { ...shape, loaded: [], loadedSelf: false })]);
    expect(entriesOf('a.test.ts')).toContain('c.ts');
  });

  // `?raw` and `?url` imports, and vitest's own `?_vitest_original` for importOriginal.
  it('matches a loaded id that carries a query', () => {
    files();
    run([testModule('a.test.ts', { ...shape, loaded: ['a.ts', 'b.ts', 'm.ts?_vitest_original'] })]);
    expect(entriesOf('a.test.ts')).toContain('c.ts');
  });

  // node_modules is the lockfile's job and is never in what the runner reports in a usable form; a
  // first-party file reached through it must still be found.
  it('still walks through modules outside the repo', () => {
    files();
    run([
      testModule('a.test.ts', {
        deps: ['node_modules/pkg/index.js'],
        edges: { 'node_modules/pkg/index.js': ['c.ts'] },
        loaded: [],
      }),
    ]);
    expect(entriesOf('a.test.ts')).toContain('c.ts');
  });
});

describe('unhandled errors', () => {
  it('blocks only the file the error is attributed to', () => {
    write('a.test.ts');
    write('b.test.ts');
    run([testModule('a.test.ts'), testModule('b.test.ts')], {
      errors: [{ VITEST_TEST_PATH: fwd(join(root, 'a.test.ts')) }],
    });
    expect(records('a.test.ts')).toBe(0);
    expect(records('b.test.ts')).toBe(1);
  });

  it('blocks every file when an error cannot be attributed', () => {
    write('a.test.ts');
    write('b.test.ts');
    run([testModule('a.test.ts'), testModule('b.test.ts')], { errors: [{ message: 'somewhere' }] });
    expect(records('a.test.ts')).toBe(0);
    expect(records('b.test.ts')).toBe(0);
  });
});

describe('setup files', () => {
  // The fs tracker is instrumentation whose own code imports child_process. Walking it marked every
  // test uncacheable; it is covered by the salt instead.
  it('does not let the cache tracker itself make a file uncacheable', () => {
    write('a.test.ts');
    run([testModule('a.test.ts', { setupFiles: ['scripts/test-cache/fs-tracker.mjs'] })]);
    expect(records('a.test.ts')).toBe(1);
  });

  it('refuses a file whose ordinary setup file is missing from the graph', () => {
    write('a.test.ts');
    run([testModule('a.test.ts', { setupFiles: ['src/__tests__/setup.ts'] })]);
    expect(records('a.test.ts')).toBe(0);
  });
});

describe('a false skip', () => {
  it('trips the cache and forgets the file, so clearing the trip cannot revive the skip', () => {
    write('a.test.ts');
    run([testModule('a.test.ts')]);
    expect(records('a.test.ts')).toBe(1);

    const hit = `unit\0${fwd(join(root, 'a.test.ts'))}`;
    run([testModule('a.test.ts', { passed: false })], { state: { hits: new Set([hit]) } });

    expect(existsSync(join(cacheDir, 'TRIPPED.json'))).toBe(true);
    expect(records('a.test.ts')).toBe(0);
  });

  // stdout is reserved for a caller's own `--reporter=json`.
  it('says everything on stderr, nothing on stdout', () => {
    write('a.test.ts');
    run([testModule('a.test.ts')]);
    expect(console.error).toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
  });
});

describe('when the sequencer declines to skip', () => {
  const bailFor = async (ctx: Record<string, unknown>) => {
    const seq = new TestCacheSequencer({ config: {}, reporters: [], ...ctx } as never);
    await seq.sort([]);
    return (globalThis as { __civitaiTestCache?: State }).__civitaiTestCache?.bailed;
  };
  const withReporter = [new TestCacheReporter()];

  it('declines on a name filter', async () => {
    expect(await bailFor({ config: { testNamePattern: /x/ }, reporters: withReporter })).toBe(
      'name filter'
    );
  });

  it('declines when the run names files', async () => {
    expect(await bailFor({ filenamePattern: ['a.test.ts'], reporters: withReporter })).toBe(
      'file filter'
    );
  });

  // Nothing would record or check the sample, so a skip would be unobserved.
  it('declines when the cache reporter is not loaded', async () => {
    expect(await bailFor({ reporters: [] })).toBe('cache reporter not loaded');
  });

  it('does not decline a whole-suite run with the reporter loaded', async () => {
    expect(
      await bailFor({ config: { root }, reporters: withReporter, version: 'test' })
    ).toBeNull();
  });
});

describe('the fs tracker', () => {
  // Wrapping a function drops properties that live ON it. `fs.realpathSync.native` is one, and
  // next's lib/realpath.js calls it off-Windows — review confirmed the tracker stripped it.
  it('keeps realpathSync.native callable after wrapping fs', async () => {
    vi.stubEnv('CIVITAI_TEST_CACHE', 'on');
    await import('../test-cache/fs-tracker.mjs');
    const fs = await import('node:fs');
    expect(typeof fs.realpathSync.native).toBe('function');
    expect(fs.realpathSync.native(root)).toBeTruthy();
  });
});
