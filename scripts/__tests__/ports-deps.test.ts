import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';

import { computeGoDeps } from '../ports/go-deps.mjs';
import { computeNodeDeps, findEntryNode } from '../ports/node-deps.mjs';

// A port's Node and Go dependencies (scripts/ports/{node,go}-deps.mjs), which CI computes from
// source, on fixtures whose file names are all distinct, so a list holding the wrong file cannot
// pass.

// Not every test builds a fixture.
let root = '';
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

const put = (rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

// A git repo with `files` tracked: imports resolve against `git ls-files`, not the disk.
function fixture(files: Record<string, string>) {
  root = mkdtempSync(join(tmpdir(), 'ports-deps-'));
  for (const [rel, text] of Object.entries(files)) put(rel, text);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  return root;
}

const TSCONFIG = JSON.stringify({
  // tsconfig allows comments; the loader must too.
  compilerOptions: { paths: { '~/*': ['./src/*'], '@fx/pkg': ['./packages/fx-pkg/src/index'] } },
});

const ROUTER = `
import type { RouterShape } from './router-types';
import { portedHandler } from './ported-handler';
import { otherHandler } from './other-handler';
import { portedSchema } from '~/schemas/ported-schema';
import { localHelperDep } from './local-helper-dep';

const localHelper = () => localHelperDep();

export const appRouter = router({
  ported: proc.input(portedSchema).query(() => portedHandler() + localHelper()),
  other: proc.query(() => otherHandler()),
});
export type AppRouter = RouterShape;
`;

const NODE_FILES = {
  'tsconfig.json': `// fixture\n${TSCONFIG}`,
  '.gitmodules':
    '[submodule "fx-sub"]\n\tpath = fx-sub\n\turl = https://example.invalid/fx-sub.git\n',
  'src/router.ts': ROUTER,
  'src/router-types.ts': 'export type RouterShape = {};\n',
  'src/ported-handler.ts': [
    "import type { OnlyAType } from './only-a-type';",
    "import { type AlsoAType } from './also-a-type';",
    "import { transitiveDep } from './transitive-dep';",
    "import { fromPkg } from '@fx/pkg';",
    "import { fromSub } from '../fx-sub/lib';",
    "import 'some-external-package';",
    "export { type ReExportedType } from './reexported-type';",
    'export async function portedHandler(): Promise<OnlyAType & AlsoAType> {',
    "  const lazy = await import('./lazy-dep');",
    '  return transitiveDep() + fromPkg() + fromSub() + lazy.x;',
    '}',
  ].join('\n'),
  'src/only-a-type.ts': 'export type OnlyAType = number;\n',
  'src/also-a-type.ts': 'export type AlsoAType = number;\n',
  'src/reexported-type.ts': 'export type ReExportedType = number;\n',
  'src/transitive-dep.ts':
    "export * from './esm-style.js';\nexport const transitiveDep = () => 1;\n",
  'src/esm-style.ts': 'export const esm = 1;\n',
  'src/lazy-dep.ts': 'export const x = 1;\n',
  'src/other-handler.ts':
    "import { otherOnlyDep } from './other-only-dep';\nexport const otherHandler = otherOnlyDep;\n",
  'src/other-only-dep.ts': 'export const otherOnlyDep = () => 1;\n',
  'src/schemas/ported-schema.ts': 'export const portedSchema = {};\n',
  'src/local-helper-dep.ts': 'export const localHelperDep = () => 1;\n',
  'packages/fx-pkg/src/index.ts': 'export const fromPkg = () => 1;\n',
  'src/rest-route.ts': [
    "import { restOnlyDep } from './rest-only-dep';",
    "import { notReached } from './not-reached';",
    'function restHandler() { return restOnlyDep(); }',
    'export const unrelated = notReached;',
    'export default wrap(restHandler);',
  ].join('\n'),
  'src/rest-only-dep.ts': 'export const restOnlyDep = () => 1;\n',
  'src/not-reached.ts': 'export const notReached = 1;\n',
};

describe('computeNodeDeps', () => {
  it('follows the entry symbol out of its file, then every runtime import, and nothing type-only', () => {
    fixture(NODE_FILES);
    expect(computeNodeDeps(root, { file: 'src/router.ts', symbol: 'appRouter.ported' })).toEqual([
      'fx-sub',
      'packages/fx-pkg/src/index.ts',
      'src/esm-style.ts',
      'src/lazy-dep.ts',
      'src/local-helper-dep.ts',
      'src/ported-handler.ts',
      'src/router.ts',
      'src/schemas/ported-schema.ts',
      'src/transitive-dep.ts',
    ]);
  });

  it("does not take a sibling procedure's imports", () => {
    fixture(NODE_FILES);
    expect(computeNodeDeps(root, { file: 'src/router.ts', symbol: 'appRouter.other' })).toEqual([
      'src/other-handler.ts',
      'src/other-only-dep.ts',
      'src/router.ts',
    ]);
  });

  it('follows a default export through the local declarations it names', () => {
    fixture(NODE_FILES);
    expect(computeNodeDeps(root, { file: 'src/rest-route.ts', symbol: 'default' })).toEqual([
      'src/rest-only-dep.ts',
      'src/rest-route.ts',
    ]);
  });

  it('fails on a relative import that resolves to no file, naming it', () => {
    fixture({
      ...NODE_FILES,
      'src/lazy-dep.ts': "import { gone } from './no-such-file';\nexport const x = gone;\n",
    });
    expect(() =>
      computeNodeDeps(root, { file: 'src/router.ts', symbol: 'appRouter.ported' })
    ).toThrow("src/lazy-dep.ts: './no-such-file'");
  });

  it('does not resolve an import to a file git does not track, even when it is on disk', () => {
    fixture({
      ...NODE_FILES,
      'src/lazy-dep.ts': "import { y } from './untracked-only';\nexport const x = y;\n",
    });
    put('src/untracked-only.ts', 'export const y = 1;\n');
    expect(() =>
      computeNodeDeps(root, { file: 'src/router.ts', symbol: 'appRouter.ported' })
    ).toThrow("src/lazy-dep.ts: './untracked-only'");
  });

  it('resolves to the tracked candidate when an untracked one would win on disk', () => {
    fixture({
      'src/entry.ts':
        "import { v } from './two-kinds';\nexport default function h() { return v; }\n",
      'src/two-kinds.tsx': 'export const v = 1;\n',
    });
    // `.ts` is probed before `.tsx`: on disk this stray file would be taken.
    put('src/two-kinds.ts', 'export const v = 2;\n');
    expect(computeNodeDeps(root, { file: 'src/entry.ts', symbol: 'default' })).toEqual([
      'src/entry.ts',
      'src/two-kinds.tsx',
    ]);
  });

  // Also held before overloads were handled explicitly (the signature's own name led to the
  // implementation); the findEntryNode case below pins the choice itself.
  it('follows the implementation of an overloaded entry function', () => {
    fixture({
      'src/overloaded.ts': [
        "import { implOnlyDep } from './impl-only-dep';",
        'export function entry(a: string): string;',
        'export function entry(a: number): number;',
        'export function entry(a: unknown) {',
        '  return implOnlyDep(a);',
        '}',
      ].join('\n'),
      'src/impl-only-dep.ts': 'export const implOnlyDep = (a: unknown) => a;\n',
    });
    expect(computeNodeDeps(root, { file: 'src/overloaded.ts', symbol: 'entry' })).toEqual([
      'src/impl-only-dep.ts',
      'src/overloaded.ts',
    ]);
  });

  it.each([
    ['a named function', 'entry', 'export function entry'],
    ['a default export', 'default', 'export default function entry'],
  ])(
    'locates %s overloads: marker on the first signature, code from the body',
    (_n, symbol, decl) => {
      const text = [
        `${decl}(a: string): string;`,
        `${decl}(a: number): number;`,
        `${decl}(a: unknown) {`,
        '  return a;',
        '}',
      ].join('\n');
      const sf = ts.createSourceFile('src/o.ts', text, ts.ScriptTarget.Latest, true);
      const found = findEntryNode(sf, symbol);
      expect(found).not.toBeNull();
      expect(found?.markerNode).toBe(sf.statements[0]);
      expect(found?.bodyNode).toBe(sf.statements[2]);
    }
  );

  it('fails on a symbol the file does not define', () => {
    fixture(NODE_FILES);
    expect(() =>
      computeNodeDeps(root, { file: 'src/router.ts', symbol: 'appRouter.renamed' })
    ).toThrow('symbol `appRouter.renamed` not found');
  });
});

describe('computeGoDeps', () => {
  const MOD = 'example.com/fx';
  // What `go list -deps -f <FORMAT>` prints: records end in \x1e, fields are tab-separated.
  const record = (
    importPath: string,
    dir: string,
    goFiles: string[],
    embed: string[] = [],
    err = ''
  ) => `${importPath}\t${dir}\t${goFiles.join(',')}\t${embed.join(',')}\t${err}\x1e\n`;

  it("keeps the module's own packages, with embedded files, and the handler files", () => {
    fixture({ 'apps/fx/go.mod': `module ${MOD}\n\ngo 1.22\n`, 'apps/fx/go.sum': '' });
    const goList = (dir: string, pkgs: string[]) => {
      expect(pkgs).toEqual(['./internal/alpha']);
      return [
        record('fmt', '/usr/lib/go/src/fmt', ['print.go']),
        record('github.com/other/lib', '/gomod/github.com/other/lib', ['lib.go']),
        record(`${MOD}/internal/beta`, join(dir, 'internal/beta'), ['beta.go'], ['beta-data.json']),
        record(`${MOD}/internal/alpha`, join(dir, 'internal/alpha'), ['alpha.go']),
      ].join('');
    };
    expect(
      computeGoDeps(
        root,
        'apps/fx',
        ['apps/fx/internal/alpha'],
        ['apps/fx/internal/server/handler.go'],
        goList
      )
    ).toEqual([
      'apps/fx/go.mod',
      'apps/fx/go.sum',
      'apps/fx/internal/alpha/alpha.go',
      'apps/fx/internal/beta/beta-data.json',
      'apps/fx/internal/beta/beta.go',
      'apps/fx/internal/server/handler.go',
    ]);
  });

  it("fails on an error in one of the module's packages, and ignores one outside it", () => {
    fixture({ 'apps/fx/go.mod': `module ${MOD}\n` });
    const goList = (dir: string) =>
      record('github.com/missing/dep', '', [], [], 'cannot find module') +
      record(
        `${MOD}/internal/alpha`,
        join(dir, 'internal/alpha'),
        ['alpha.go'],
        [],
        'alpha.go:3:1: expected declaration\nfound EOF'
      );
    expect(() => computeGoDeps(root, 'apps/fx', ['apps/fx/internal/alpha'], [], goList)).toThrow(
      `${MOD}/internal/alpha: alpha.go:3:1: expected declaration\nfound EOF`
    );
  });

  // The fake above pins the parsing; this pins the `go list` invocation itself. Skipped without a
  // Go toolchain unless PORTS_REQUIRE_GO is set, which the ports workflow sets.
  const haveGo = (() => {
    try {
      execFileSync('go', ['version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();
  it.skipIf(!haveGo && !process.env.PORTS_REQUIRE_GO)(
    'lists a real module: deps of the root only, no test files, no other platform',
    () => {
      fixture({
        'apps/fx/go.mod': `module ${MOD}\n\ngo 1.21\n`,
        'apps/fx/internal/alpha/alpha.go': `package alpha\n\nimport (\n\t"fmt"\n\n\t"${MOD}/internal/beta"\n)\n\nfunc A() string { return fmt.Sprint(beta.B) }\n`,
        'apps/fx/internal/alpha/alpha_test.go': 'package alpha\n',
        'apps/fx/internal/beta/beta.go': 'package beta\n\nconst B = 1\n',
        'apps/fx/internal/beta/beta_windows.go': 'package beta\n\nconst W = 1\n',
        'apps/fx/internal/gamma/gamma.go': 'package gamma\n',
      });
      expect(computeGoDeps(root, 'apps/fx', ['apps/fx/internal/alpha'])).toEqual([
        'apps/fx/go.mod',
        'apps/fx/internal/alpha/alpha.go',
        'apps/fx/internal/beta/beta.go',
      ]);
    }
  );
});
