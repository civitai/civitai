import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { computeGoDeps } from '../ports/go-deps.mjs';
import { computeNodeDeps } from '../ports/node-deps.mjs';

// The generated halves of ports/manifest.json (scripts/ports/{node,go}-deps.mjs), on fixtures whose
// file names are all distinct, so a list holding the wrong file cannot pass.

// Not every test builds a fixture.
let root = '';
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

function fixture(files: Record<string, string>) {
  root = mkdtempSync(join(tmpdir(), 'ports-deps-'));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
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
