import { describe, expect, it } from 'vitest';

import * as Reporter from '../test-cache/reporter.mjs';

type Node = { id: string; importedModules: Set<Node> };

const { closureOf, normaliseId, isCoveredElsewhere, isUncacheableSource } = Reporter as unknown as {
  closureOf: (
    graph: { getModuleById: (id: string) => Node | undefined },
    id: string
  ) => Set<string> | null;
  normaliseId: (id: string, root: string) => string;
  isCoveredElsewhere: (rel: string) => boolean;
  isUncacheableSource: (source: string) => boolean;
};

function graphOf(edges: Record<string, string[]>) {
  const nodes = new Map<string, Node>();
  const node = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, { id, importedModules: new Set() });
    return nodes.get(id)!;
  };
  for (const [from, tos] of Object.entries(edges))
    for (const to of tos) node(from).importedModules.add(node(to));
  return { getModuleById: (id: string) => nodes.get(id) };
}

describe('the dependency set a key is built from', () => {
  it('follows imports transitively and terminates on a cycle', () => {
    const graph = graphOf({ 't.test.ts': ['a.ts'], 'a.ts': ['b.ts'], 'b.ts': ['a.ts', 'c.ts'] });
    expect([...closureOf(graph, 't.test.ts')!].sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  // null, not an empty set: "not in the graph" must make the file uncacheable, never key it on
  // nothing — an empty dependency set is a key that no change can ever invalidate.
  it('reports a file missing from the graph as unknown rather than dependency-free', () => {
    expect(closureOf(graphOf({}), 'missing.test.ts')).toBeNull();
  });
});

describe('keys are portable between worktrees', () => {
  // The whole point of keying on content: one tree's green run covers every other tree whose files
  // are identical. A key that embedded the worktree path would never hit across trees.
  it('gives the same id for the same file in two worktrees', () => {
    const a = normaliseId('C:/Dev/wt/one/src/a.ts?v=123', 'C:\\Dev\\wt\\one');
    const b = normaliseId('C:/Dev/wt/two/src/a.ts', 'C:/Dev/wt/two/');
    expect(a).toBe('src/a.ts');
    expect(b).toBe('src/a.ts');
  });

  it('leaves dependencies to the lockfile when they live in node_modules or are builtins', () => {
    expect(isCoveredElsewhere('node_modules/.vite/vitest/x/deps_ssr/zod.js')).toBe(true);
    expect(isCoveredElsewhere('crypto')).toBe(true);
    expect(isCoveredElsewhere('node:fs')).toBe(true);
    expect(isCoveredElsewhere('src/server/services/image.service.ts')).toBe(false);
    expect(isCoveredElsewhere('packages/civitai-shared/src/lazy.ts')).toBe(false);
  });
});

/**
 * A test whose inputs are not imports has a dependency the graph cannot see, so it must always run.
 * The largest group is the convention guards, which read source as TEXT: a change to the code they
 * police changes no import edge of theirs.
 */
describe('tests that always run', () => {
  it.each([
    ["const s = readFileSync('src/x.ts', 'utf8');"],
    ['const files = readdirSync(dir);'],
    ["spawn(process.execPath, ['x.mjs']);"],
    ['const m = await import(`./pages/${name}`);'],
    ['const m = await import(target);'],
  ])('are recognised: %s', (source) => {
    expect(isUncacheableSource(source)).toBe(true);
  });

  // A literal dynamic import IS in the module graph — measured, it is exactly the case
  // `diagnostic().importDurations` missed and the ssr graph caught — so it stays cacheable.
  it.each([["const m = await import('./dep');"], ["import { a } from './a';"]])(
    'does not flag an ordinary import: %s',
    (source) => {
      expect(isUncacheableSource(source)).toBe(false);
    }
  );
});
