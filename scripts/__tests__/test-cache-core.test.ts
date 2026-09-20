import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

import * as Core from '../test-cache/core.mjs';

type Node = { id: string; importedModules: Set<Node> };
type Fingerprint = (rel: string) => string;

const {
  closureOf,
  toRel,
  isCoveredElsewhere,
  alwaysRuns,
  keyFor,
  makeFingerprinter,
  mode,
  shadowCandidates,
  changedSince,
  tripped,
} = Core as unknown as {
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
  shadowCandidates: (rel: string) => string[];
  changedSince: (root: string, rel: string, sinceMs: number) => boolean;
  tripped: (dir: string) => { at: string } | null;
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

  // The assertion above was red on POSIX from the moment it landed, because `fileURLToPath`
  // resolves a Windows file URL to `/C:/...` here and to `C:\...` on Windows. It is the
  // regression guard for that defect, and a mutation table showed it is also the STRONGEST
  // one available: of four mutants — normalisation deleted, inverted, prefix-compare broken,
  // and "strip any leading slash" — it kills the first three.
  //
  // 🔴 An earlier draft of this fix added a second regression test asserting that the URL and
  // path spellings return the SAME key. It was removed rather than kept: it is subsumed. It
  // kills the deleted-normalisation mutant, which the assertion above already kills, and it
  // PASSES both the inverted and broken-prefix mutants, because an equality with no anchor is
  // satisfied when both sides return null. Do not re-add it — an unanchored equality reads as
  // robustness and is the weaker check.
  //
  // What follows is an INVARIANT guard, labelled from what it was MEASURED to do at the
  // pre-fix commit rather than from what it was written to do: it passes before the fix and
  // after, so it is NOT regression coverage and must not be counted as any. It earns its
  // place on a different axis — every other `toRel` assertion in this file is Windows-shaped
  // while CI and every Linux/macOS dev run POSIX, and it is the only thing that kills the
  // "strip any leading slash" mutant.
  it('invariant: POSIX ids are unaffected by the drive-letter normalisation', () => {
    expect(toRel('/home/u/repo/src/b.ts', '/home/u/repo')).toBe('src/b.ts');
    expect(toRel('file:///home/u/repo/src/b.ts', '/home/u/repo')).toBe('src/b.ts');
    expect(toRel('/var/tmp/x.json', '/home/u/repo')).toBeNull();
    expect(toRel('src/c.ts', '/home/u/repo')).toBe('src/c.ts');
  });

  // The narrowing above (normalising inside the `file://` branch) is what keeps this true:
  // a POSIX path whose first segment is a letter and a colon is NOT a platform artefact and
  // must not be repaired. Measured against the unscoped draft, which returned null here.
  it('invariant: a POSIX path that merely looks like a drive letter is left alone', () => {
    expect(toRel('/C:/notes/x.md', '/C:')).toBe('notes/x.md');
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
    ["import { execSync } from 'node:child_process';"],
    ["import * as cp from 'child_process';"],
    ["const { Worker } = require('worker_threads');"],
    ['const m = await import(`./pages/${name}`);'],
    ['const m = await import(target);'],
    // A bare-specifier computed import is cacheable (below), but only where its head cannot name
    // first-party source or a builtin. Whoever widens that: these three are why it is narrow.
    ['const m = await import(`~/server/${name}`);'],
    ['const m = await import(`@civitai/ui/${name}`);'],
    ['const m = await import(`node:${mod}`);'],
    // The form this repo uses, which the first version of the pattern let through.
    ['return import(/* @vite-ignore */ file);'],
    ["const files = globSync('src/**/*.ts');"],
    ["import fg from 'fast-glob';"],
  ])('recognises %s', (source) => {
    expect(alwaysRuns(source)).toBe(true);
  });

  // Plain file reads are no longer a reason to always run: the tracker records them into the key.
  // A literal dynamic import is in the module graph.
  // `regex.exec(` is not a process: the call-name pattern this replaced matched it in
  // src/__tests__/setup.ts, which every test loads, and nothing was cacheable at all.
  it.each([
    ["readFileSync('src/x.ts', 'utf8');"],
    ["await import('./dep');"],
    ['const m = /^a(b)$/.exec(input);'],
    // `'cluster'` is an ordinary value in this repo's Redis and telemetry code, reached by every
    // test's setup. Matching the bare word made all 1880 unit tests uncacheable.
    ["const opts = { client: 'cluster' };"],
    ["// Module not found: Can't resolve 'cluster'"],
    // Whatever it computes lives under node_modules, which the lockfile covers. The real site is
    // src/hooks/useDateLocale.ts, and treating it as opaque cost 44 test files.
    ['const m = await import(`dayjs/locale/${tag}.js`);'],
  ])('leaves %s cacheable', (source) => {
    expect(alwaysRuns(source)).toBe(false);
  });
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

describe('what a key must see besides content', () => {
  // `./foo` resolving to `foo/index.ts` is overtaken by a new `foo.ts` without any file in the
  // dependency list changing.
  it('names the files that would shadow an index module or an extension', () => {
    const c = shadowCandidates('src/foo/index.ts');
    expect(c).toContain('src/foo.ts');
    expect(c).toContain('src/foo/index.tsx');
    expect(c).not.toContain('src/foo/index.ts');
  });

  it('changes when a shadowing file appears', () => {
    const root = mkdtempSync(join(tmpdir(), 'test-cache-shadow-'));
    mkdirSync(join(root, 'src/foo'), { recursive: true });
    writeFileSync(join(root, 't.test.ts'), 't');
    writeFileSync(join(root, 'src/foo/index.ts'), 'i');
    const k = () =>
      keyFor({
        salt: 's',
        project: 'unit',
        testRel: 't.test.ts',
        entries: ['src/foo/index.ts'],
        fingerprint: makeFingerprinter(root),
      });
    const before = k();
    writeFileSync(join(root, 'src/foo.ts'), 'f');
    expect(k()).not.toBe(before);
  });

  // The key is computed at the END of a run; an input written after the run started is not what
  // ran. Measured by review: without this an edit made during a queued suite was recorded as passing.
  describe('what changed during a run', () => {
    // The tree is built, THEN the "run" starts, so each assertion below moves exactly one thing
    // past `since`. Not backdated with utimes: that bumps ctime to now, and ctime is checked on
    // purpose — it is what catches an edit made with a backdated mtime.
    const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    const setup = () => {
      const root = mkdtempSync(join(tmpdir(), 'test-cache-mtime-'));
      mkdirSync(join(root, 'd/deep'), { recursive: true });
      mkdirSync(join(root, 'h'), { recursive: true });
      writeFileSync(join(root, 'a.ts'), 'a');
      writeFileSync(join(root, 'h/gone.ts'), 'g');
      pause(50);
      const since = Date.now();
      pause(50);
      return { root, since };
    };

    it('reports nothing for inputs untouched since the run started', () => {
      const { root, since } = setup();
      expect(changedSince(root, 'a.ts', since)).toBe(false);
      expect(changedSince(root, 'd', since)).toBe(false);
      expect(changedSince(root, 'h/gone.ts', since)).toBe(false);
    });

    it('sees a file edited after the run started', () => {
      const { root, since } = setup();
      writeFileSync(join(root, 'a.ts'), 'a2');
      expect(changedSince(root, 'a.ts', since)).toBe(true);
    });

    // A convention guard lists a directory recursively; a file added three levels down counts.
    it('sees a directory whose subtree gained a file', () => {
      const { root, since } = setup();
      writeFileSync(join(root, 'd/deep/new.ts'), 'n');
      expect(changedSince(root, 'd', since)).toBe(true);
    });

    // The test ran WITH the file. Recording its absence would skip it green next time — confirmed
    // by review as a false skip before this existed.
    // Every test probes `__snapshots__/<file>.snap`, a directory that usually never existed.
    // Reading a missing parent as "changed" refused every record in the repo.
    it('does not count a probe into a directory that never existed', () => {
      const { root, since } = setup();
      expect(changedSince(root, 'd/__snapshots__/x.test.ts.snap', since)).toBe(false);
    });

    it('sees a whole directory removed after the run started', () => {
      const { root, since } = setup();
      rmSync(join(root, 'd'), { recursive: true });
      expect(changedSince(root, 'd/deep/x.ts', since)).toBe(true);
    });

    it('sees a file deleted after the run started', () => {
      const { root, since } = setup();
      rmSync(join(root, 'h/gone.ts'));
      expect(changedSince(root, 'h/gone.ts', since)).toBe(true);
    });
  });

  // A half-written marker must read as tripped, never as "safe to skip".
  it('treats an unreadable trip marker as tripped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'test-cache-trip-'));
    expect(tripped(dir)).toBeNull();
    writeFileSync(join(dir, 'TRIPPED.json'), '{"at": "2026');
    expect(tripped(dir)).not.toBeNull();
  });
});
