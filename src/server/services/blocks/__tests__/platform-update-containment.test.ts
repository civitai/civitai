import { describe, expect, it } from 'vitest';
import {
  missingUpdateChanges,
  missingUpdatePaths,
  pathHoldsUpdate,
} from '~/server/services/blocks/platform-update-containment';
import {
  BASE_V,
  OWNER_V,
  UPDATE_V,
  type Versions,
  packageJson,
  pnpmLock,
  twoDocuments,
} from './platform-update-dependency-files.fixture';

/**
 * The ONE "does this tree hold the staff update" predicate, shared by the submit and approve
 * checks and App Assistant's merged report. Each case pins one clause of the rule.
 */

const b = (s: string) => Buffer.from(s, 'utf8');
const BASE = 'line one\nline two\n';
const UPDATE = 'line one\nline two\nadded by staff\n';
const NOT_UTF8 = Buffer.from([0xff, 0xfe, 0x00, 0x41]);

describe('pathHoldsUpdate', () => {
  it('holds when the tree has the update’s exact bytes', () => {
    expect(pathHoldsUpdate({ want: b(UPDATE), base: b(BASE), have: b(UPDATE) })).toBe(true);
  });

  it('holds a hand-merged text file that has every line the update adds', () => {
    const merged = 'owner header\nline one\nline two\nadded by staff\nowner footer\n';
    expect(pathHoldsUpdate({ want: b(UPDATE), base: b(BASE), have: b(merged) })).toBe(true);
  });

  it('does not hold a file missing one added line', () => {
    const want = 'line one\nfirst added\nline two\nsecond added\n';
    const have = 'line one\nfirst added\nline two\nowner edit\n';
    expect(pathHoldsUpdate({ want: b(want), base: b(BASE), have: b(have) })).toBe(false);
  });

  it('does not hold the untouched base (the update not merged at all)', () => {
    expect(pathHoldsUpdate({ want: b(UPDATE), base: b(BASE), have: b(BASE) })).toBe(false);
  });

  it('ignores blank added lines; CRLF and LF lines compare equal', () => {
    const want = 'line one\nline two\n\n   \nadded by staff\n';
    const have = 'line one\r\nline two\r\nadded by staff\r\n';
    expect(pathHoldsUpdate({ want: b(want), base: b(BASE), have: b(have) })).toBe(true);
  });

  it('a created file (no base) holds when every line is present', () => {
    expect(pathHoldsUpdate({ want: b('a\nb\n'), base: null, have: b('a\nowner\nb\n') })).toBe(true);
    expect(pathHoldsUpdate({ want: b('a\nb\n'), base: null, have: b('a\n') })).toBe(false);
  });

  it('a file the tree lacks never holds a create or an update', () => {
    expect(pathHoldsUpdate({ want: b(UPDATE), base: b(BASE), have: null })).toBe(false);
    expect(pathHoldsUpdate({ want: b('new\n'), base: null, have: null })).toBe(false);
  });

  it('a delete holds only when the path is gone', () => {
    expect(pathHoldsUpdate({ want: null, base: b(BASE), have: null })).toBe(true);
    expect(pathHoldsUpdate({ want: null, base: b(BASE), have: b(BASE) })).toBe(false);
    expect(pathHoldsUpdate({ want: null, base: b(BASE), have: b('owner rewrote it\n') })).toBe(
      false
    );
  });

  it('an update that only removes lines holds when the file differs from the base', () => {
    const want = 'line one\n';
    expect(pathHoldsUpdate({ want: b(want), base: b(BASE), have: b('line one\nowner\n') })).toBe(
      true
    );
    expect(pathHoldsUpdate({ want: b(want), base: b(BASE), have: b(BASE) })).toBe(false);
  });

  // The update's change is COUNTED: lines it adds and lines it removes, each with its number of
  // copies.
  describe('counted changes (added and removed lines)', () => {
    const holds = (want: string, base: string | null, have: string) =>
      pathHoldsUpdate({ want: b(want), base: base === null ? null : b(base), have: b(have) });

    it('a remove-only update whose removed line the owner kept is missing', () => {
      const base = 'keep\nbad call\n';
      const want = 'keep\n';
      // The owner's other edits make the file differ from the base, but the bad line is still there.
      expect(holds(want, base, 'keep\nbad call\nowner edit\n')).toBe(false);
      // Positive control: removed, with the owner's edit beside it.
      expect(holds(want, base, 'keep\nowner edit\n')).toBe(true);
    });

    it('a replacement whose old line the owner kept beside the new one is missing', () => {
      const base = 'a\nold();\nz\n';
      const want = 'a\nnew();\nz\n';
      expect(holds(want, base, 'a\nold();\nnew();\nz\n')).toBe(false);
      expect(holds(want, base, 'a\nnew();\nz\nowner\n')).toBe(true);
    });

    it('an added copy of a line the base already has must be there as a copy', () => {
      const base = 'init();\nrun();\n';
      const want = 'init();\nrun();\ninit();\n';
      // One `init();` (the base's): the update's second copy was never added.
      expect(holds(want, base, 'init();\nrun();\nowner();\n')).toBe(false);
      expect(holds(want, base, 'init();\nrun();\nowner();\ninit();\n')).toBe(true);
    });

    it('a reorder-only update holds with the exact bytes alone', () => {
      const base = 'first\nsecond\n';
      const want = 'second\nfirst\n';
      expect(holds(want, base, want)).toBe(true);
      // The owner's other edits beside the base order: nothing shows the reorder was taken.
      expect(holds(want, base, 'first\nsecond\nowner\n')).toBe(false);
      // Even with the update's order and an owner edit: a reorder is never hand-merged.
      expect(holds(want, base, 'second\nfirst\nowner\n')).toBe(false);
      // Blank-line-only change: also exact bytes only.
      expect(holds('first\n\nsecond\n', base, 'first\nsecond\nowner\n')).toBe(false);
    });

    it('a hand-merge with extra owner edits on both sides of the update holds', () => {
      const base = 'import a;\nold();\nend();\n';
      const want = 'import a;\nimport b;\nnew();\nend();\n';
      const have = '// owner\nimport a;\nimport b;\nimport own;\nnew();\nown();\nend();\n';
      expect(holds(want, base, have)).toBe(true);
    });

    it('CRLF against LF holds (line endings are not a change)', () => {
      const base = 'a\nold\n';
      const want = 'a\nnew\n';
      expect(holds(want, base, 'a\r\nnew\r\nowner\r\n')).toBe(true);
      expect(holds(want, base, 'a\r\nold\r\nnew\r\n')).toBe(false);
    });

    it('a line removed from two copies to one: the owner may keep one, not two', () => {
      const base = 'x();\nx();\ny();\n';
      const want = 'x();\ny();\n';
      expect(holds(want, base, 'x();\ny();\nowner\n')).toBe(true);
      expect(holds(want, base, 'x();\nx();\ny();\nowner\n')).toBe(false);
    });
  });

  it('a non-text file must match exactly', () => {
    const want = Buffer.concat([NOT_UTF8, b('v2')]);
    expect(pathHoldsUpdate({ want, base: NOT_UTF8, have: Buffer.from(want) })).toBe(true);
    expect(pathHoldsUpdate({ want, base: NOT_UTF8, have: Buffer.concat([want, b('x')]) })).toBe(
      false
    );
    // Text that contains every "line" of a binary update still does not hold it.
    expect(pathHoldsUpdate({ want: b(UPDATE), base: b(BASE), have: NOT_UTF8 })).toBe(false);
  });
});

describe('missingUpdatePaths', () => {
  it('lists the paths that do not hold, in the record’s order', async () => {
    const sides: Record<string, Parameters<typeof pathHoldsUpdate>[0]> = {
      'b.ts': { want: b(UPDATE), base: b(BASE), have: b(BASE) },
      'a.ts': { want: b(UPDATE), base: b(BASE), have: b(UPDATE) },
      'gone.ts': { want: null, base: b(BASE), have: b(BASE) },
    };
    const missing = await missingUpdatePaths(
      [{ path: 'b.ts' }, { path: 'a.ts' }, { path: 'gone.ts' }],
      async (path) => sides[path]
    );
    expect(missing).toEqual(['b.ts', 'gone.ts']);
  });
});

// ---------------------------------------------------------------------------
// Dependency files: an update that bumps packages, in a bundle whose package.json and pnpm
// lockfile carry later, unrelated bumps of other packages.
// ---------------------------------------------------------------------------

const DEP_PATHS = [{ path: 'package.json' }, { path: 'pnpm-lock.yaml' }];

/** The two dependency files' sides: the update's, its base, and the bundle's. */
function depSides(have: { pkg: string; lock: string } | null, opts: { twoDocs?: boolean } = {}) {
  const wrap = (lock: string) => (opts.twoDocs ? twoDocuments(lock) : lock);
  const files = {
    'package.json': {
      want: b(packageJson(UPDATE_V)),
      base: b(packageJson(BASE_V)),
      have: have ? b(have.pkg) : null,
    },
    'pnpm-lock.yaml': {
      want: b(wrap(pnpmLock(UPDATE_V))),
      base: b(wrap(pnpmLock(BASE_V))),
      have: have ? b(have.lock) : null,
    },
  } as Record<string, Parameters<typeof pathHoldsUpdate>[0]>;
  return async (path: string) => files[path];
}

describe('dependency files (package.json, pnpm-lock.yaml)', () => {
  const owner = { pkg: packageJson(OWNER_V), lock: pnpmLock(OWNER_V) };

  it('🔴 holds when the bundle has the update’s versions plus later dev-only bumps elsewhere', async () => {
    // The reported case: the staff lockfile can never be byte-identical (nor line-merged: the
    // owner's vite bump moves every peer suffix and snapshot that names it).
    expect(pathHoldsUpdate(await depSides(owner)('pnpm-lock.yaml'))).toBe(false);
    expect(await missingUpdatePaths(DEP_PATHS, depSides(owner))).toEqual([]);
  });

  it('🔴 holds for a pnpm 11+ two-document lockfile (the project document is the last)', async () => {
    const sides = depSides({ pkg: owner.pkg, lock: twoDocuments(owner.lock) }, { twoDocs: true });
    expect(await missingUpdatePaths(DEP_PATHS, sides)).toEqual([]);
  });

  it('🔴 a bundle with an older @civitai/sdk is missing, and the refusal names that package', async () => {
    const old = { ...OWNER_V, sdk: '0.33.7' };
    const missing = await missingUpdateChanges(
      DEP_PATHS,
      depSides({ pkg: packageJson(old), lock: pnpmLock(old) })
    );
    expect(missing).toEqual([
      {
        path: 'package.json',
        changes: ['package.json: @civitai/sdk (dependencies) must be 0.34.0, bundle has 0.33.7'],
      },
      {
        path: 'pnpm-lock.yaml',
        changes: ['pnpm-lock.yaml: @civitai/sdk must resolve to 0.34.0, bundle has 0.33.7'],
      },
    ]);
  });

  it('only the lockfile behind: the lockfile alone is missing', async () => {
    const lockBehind = { ...OWNER_V, blocksReact: '0.87.9' };
    const missing = await missingUpdateChanges(
      DEP_PATHS,
      depSides({ pkg: owner.pkg, lock: pnpmLock(lockBehind) })
    );
    expect(missing).toEqual([
      {
        path: 'pnpm-lock.yaml',
        changes: [
          'pnpm-lock.yaml: @civitai/blocks-react must resolve to 0.88.0, bundle has 0.87.9',
        ],
      },
    ]);
  });

  it('🔴 an unparseable lockfile is missing (fail closed), with no change named', async () => {
    const broken = `${owner.lock}\n  '@civitai/sdk@0.34.0: {[unclosed\n`;
    const missing = await missingUpdateChanges(
      DEP_PATHS,
      depSides({ pkg: owner.pkg, lock: broken })
    );
    expect(missing).toEqual([{ path: 'pnpm-lock.yaml', changes: [] }]);
  });

  it('an unparseable package.json gets only the line check', async () => {
    const broken = (v: Versions) => packageJson(v).replace('{', '{,');
    // Every line the update adds is there: the line check holds it, as before this rule.
    expect(
      await missingUpdatePaths(DEP_PATHS, depSides({ pkg: broken(OWNER_V), lock: owner.lock }))
    ).toEqual([]);
    // An added line missing: refused, with no change named (nothing parsed to name it).
    const old = broken({ ...OWNER_V, sdk: '0.33.7' });
    expect(await missingUpdateChanges(DEP_PATHS, depSides({ pkg: old, lock: owner.lock }))).toEqual(
      [{ path: 'package.json', changes: [] }]
    );
  });

  it('package.json: key order and formatting are not changes; other keys may differ', async () => {
    const pkg = JSON.parse(packageJson(OWNER_V));
    const reordered = {
      devDependencies: { ...pkg.devDependencies, prettier: '^3.3.3' },
      dependencies: Object.fromEntries(Object.entries(pkg.dependencies).reverse()),
      scripts: { ...pkg.scripts, lint: 'eslint .' },
      name: pkg.name,
      type: pkg.type,
      private: true,
    };
    const sides = depSides({ pkg: JSON.stringify(reordered), lock: owner.lock });
    expect(await missingUpdatePaths(DEP_PATHS, sides)).toEqual([]);
  });

  it('a dependency the update removes must be gone from the bundle', async () => {
    const base = packageJson(BASE_V, { optionalDependencies: { 'left-pad': '^1.3.0' } });
    const want = packageJson(UPDATE_V);
    const sides = (have: string) => ({ want: b(want), base: b(base), have: b(have) });
    const kept = packageJson(OWNER_V, { optionalDependencies: { 'left-pad': '^1.3.0' } });
    expect(await missingUpdateChanges([{ path: 'package.json' }], async () => sides(kept))).toEqual(
      [
        {
          path: 'package.json',
          changes: [
            'package.json: left-pad (optionalDependencies) must be removed, bundle has ^1.3.0',
          ],
        },
      ]
    );
    expect(
      await missingUpdatePaths([{ path: 'package.json' }], async () =>
        sides(packageJson(OWNER_V, { optionalDependencies: {} }))
      )
    ).toEqual([]);
  });

  it('a package the update drops from the lockfile must not resolve in the bundle', async () => {
    const withExtra = (lock: string) =>
      lock.replace(
        '    devDependencies:\n',
        '      left-pad:\n        specifier: ^1.3.0\n        version: 1.3.0\n    devDependencies:\n'
      );
    const sides = (have: string) => ({
      want: b(pnpmLock(UPDATE_V)),
      base: b(withExtra(pnpmLock(BASE_V))),
      have: b(have),
    });
    expect(
      await missingUpdateChanges([{ path: 'pnpm-lock.yaml' }], async () =>
        sides(withExtra(owner.lock))
      )
    ).toEqual([
      {
        path: 'pnpm-lock.yaml',
        changes: ['pnpm-lock.yaml: left-pad must be removed, bundle resolves 1.3.0'],
      },
    ]);
    expect(
      await missingUpdatePaths([{ path: 'pnpm-lock.yaml' }], async () => sides(owner.lock))
    ).toEqual([]);
  });

  it('a non-dependency value the update changes in package.json is still required', async () => {
    const base = packageJson(BASE_V);
    const want = packageJson(UPDATE_V, { engines: { node: '>=20' } });
    const sides = (have: string) => ({ want: b(want), base: b(base), have: b(have) });
    expect(
      await missingUpdateChanges([{ path: 'package.json' }], async () =>
        sides(packageJson(OWNER_V, { engines: { node: '>=18' } }))
      )
    ).toEqual([
      {
        path: 'package.json',
        changes: ['package.json: engines.node must be >=20, bundle has >=18'],
      },
    ]);
  });

  it('🔴 a lockfile whose aliases fan one mapping out to many importers is not walked', async () => {
    // 300 importers × the same 300-entry mapping: 90,000 entries from a few KB of YAML, past the
    // cap, so the file gets only the line check (and is refused, naming no change).
    const n = 300;
    const bomb = [
      "lockfileVersion: '9.0'",
      'importers:',
      '  .:',
      '    dependencies: &d',
      ...Array.from(
        { length: n },
        (_, i) => `      p${i}: {specifier: ^1.0.${i}, version: 1.0.${i}}`
      ),
      ...Array.from({ length: n }, (_, i) => `  i${i}:\n    dependencies: *d`),
    ].join('\n');
    expect(await missingUpdateChanges(DEP_PATHS, depSides({ pkg: owner.pkg, lock: bomb }))).toEqual(
      [{ path: 'pnpm-lock.yaml', changes: [] }]
    );
  });

  it('a package.json update that changes no value (formatting only) gets only the line check', async () => {
    const base = packageJson(BASE_V);
    const want = JSON.stringify(JSON.parse(base));
    // Parses, every value equal: no dependency reading, so only the exact bytes hold it.
    expect(
      await missingUpdatePaths([{ path: 'package.json' }], async () => ({
        want: b(want),
        base: b(base),
        have: b(packageJson(OWNER_V)),
      }))
    ).toEqual(['package.json']);
  });

  it('an importer the update removes must have its packages gone', async () => {
    const withSub = (lock: string) =>
      lock.replace(
        'packages:\n',
        '  tools:\n    devDependencies:\n      rimraf:\n        specifier: ^5.0.1\n' +
          '        version: 5.0.1\n\npackages:\n'
      );
    const sides = (have: string) => ({
      want: b(pnpmLock(UPDATE_V)),
      base: b(withSub(pnpmLock(BASE_V))),
      have: b(have),
    });
    expect(
      await missingUpdateChanges([{ path: 'pnpm-lock.yaml' }], async () =>
        sides(withSub(owner.lock))
      )
    ).toEqual([
      {
        path: 'pnpm-lock.yaml',
        changes: ['pnpm-lock.yaml (importer tools): rimraf must be removed, bundle resolves 5.0.1'],
      },
    ]);
  });

  it('the dependency reading applies by file name only: another file keeps the line check', async () => {
    const sides = await depSides(owner)('pnpm-lock.yaml');
    expect(await missingUpdatePaths([{ path: 'deps.yaml' }], async () => sides)).toEqual([
      'deps.yaml',
    ]);
    // A dependency file in a subdirectory gets the dependency reading too.
    expect(await missingUpdatePaths([{ path: 'app/pnpm-lock.yaml' }], async () => sides)).toEqual(
      []
    );
  });
});
