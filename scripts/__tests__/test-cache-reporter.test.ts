import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

import * as Core from '../test-cache/core.mjs';

type Node = { id: string; importedModules: Set<Node> };
type Fingerprint = (rel: string) => string;

const { closureOf, toRel, isCoveredElsewhere, alwaysRuns, keyFor, makeFingerprinter, mode } =
  Core as unknown as {
    closureOf: (
      g: { getModuleById: (id: string) => Node | undefined },
      id: string
    ) => Set<string> | null;
    toRel: (id: string, root: string) => string | null;
    isCoveredElsewhere: (rel: string | null) => boolean;
    alwaysRuns: (source: string) => boolean;
    keyFor: (a: {
      salt: string;
      project: string;
      testRel: string;
      entries: string[];
      fingerprint: Fingerprint;
    }) => string;
    makeFingerprinter: (root: string) => Fingerprint;
    mode: (env: Record<string, string | undefined>) => string;
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

  // null, not an empty set: an empty dependency set is a key no change can ever invalidate.
  it('reports a file missing from the graph as unknown rather than dependency-free', () => {
    expect(closureOf(graphOf({}), 'missing.test.ts')).toBeNull();
  });
});

describe('keys are portable between worktrees', () => {
  // One tree's green run covers every other tree whose files are identical. A key that embedded
  // the worktree path would never hit across trees.
  it('gives the same path for the same file in two worktrees, URL or path', () => {
    expect(toRel('C:/Dev/wt/one/src/a.ts?v=123', 'C:\\Dev\\wt\\one')).toBe('src/a.ts');
    expect(toRel('file:///C:/Dev/wt/two/src/a.ts', 'C:/Dev/wt/two/')).toBe('src/a.ts');
  });

  // A read outside the repo (a temp file the test wrote itself) is not an input anyone else shares.
  it('drops absolute paths outside the repo', () => {
    expect(toRel('D:/elsewhere/x.json', 'C:/Dev/wt/one')).toBeNull();
    expect(isCoveredElsewhere(null)).toBe(true);
  });

  it('leaves node_modules and builtins to the lockfile', () => {
    expect(isCoveredElsewhere('node_modules/.vite/vitest/x/deps_ssr/zod.js')).toBe(true);
    expect(isCoveredElsewhere('crypto')).toBe(true);
    expect(isCoveredElsewhere('src/server/services/image.service.ts')).toBe(false);
  });
});

describe('the key', () => {
  const root = mkdtempSync(join(tmpdir(), 'test-cache-'));
  mkdirSync(join(root, 'src/sub'), { recursive: true });
  writeFileSync(join(root, 't.test.ts'), 'test');
  writeFileSync(join(root, 'src/a.ts'), 'a');
  const key = (entries: string[]) =>
    keyFor({
      salt: 's',
      project: 'unit',
      testRel: 't.test.ts',
      entries,
      fingerprint: makeFingerprinter(root),
    });

  it('does not depend on the order dependencies were discovered in', () => {
    expect(key(['src/a.ts', 'src'])).toBe(key(['src', 'src/a.ts']));
  });

  it('changes when a dependency changes', () => {
    const before = key(['src/a.ts']);
    writeFileSync(join(root, 'src/a.ts'), 'a2');
    expect(key(['src/a.ts'])).not.toBe(before);
  });

  // A convention guard lists a directory recursively in ONE call. A file added three levels down
  // changes what that call returns, so it has to change the key.
  it('changes when a file appears anywhere below a directory that was read', () => {
    const before = key(['src']);
    writeFileSync(join(root, 'src/sub/new.ts'), 'n');
    expect(key(['src'])).not.toBe(before);
  });
});

describe('tests that always run', () => {
  it.each([
    ["spawn(process.execPath, ['x.mjs']);"],
    ['const m = await import(`./pages/${name}`);'],
    ['const m = await import(target);'],
    ["const files = globSync('src/**/*.ts');"],
    ["import fg from 'fast-glob';"],
  ])('recognises %s', (source) => {
    expect(alwaysRuns(source)).toBe(true);
  });

  // Plain file reads are no longer a reason to always run: the tracker records them into the key.
  // A literal dynamic import is in the module graph.
  it.each([["readFileSync('src/x.ts', 'utf8');"], ["await import('./dep');"]])(
    'leaves %s cacheable',
    (source) => {
      expect(alwaysRuns(source)).toBe(false);
    }
  );
});

// CI must always run everything: it is the check that still runs when nothing local does.
describe('when the cache is active', () => {
  it('is off in CI whatever the mode says', () => {
    expect(mode({ CI: 'true', CIVITAI_TEST_CACHE: 'on' })).toBe('off');
  });

  it('is off unless a known mode is named', () => {
    expect(mode({})).toBe('off');
    expect(mode({ CIVITAI_TEST_CACHE: 'yes' })).toBe('off');
    expect(mode({ CIVITAI_TEST_CACHE: 'on' })).toBe('on');
  });
});
