import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { APP_STATIC_SERVER_JS_EXTENSIONS } from '~/shared/constants/app-static-server.constants';
import {
  assertBundleModuleGraphLoads,
  checkModuleGraph,
  describeModuleGraphProblem,
  isModuleGraphRefusal,
  type ModuleGraphRefusal,
  resolveBundlePath,
} from '~/server/services/blocks/bundle-module-graph';

/** An in-memory bundle: path → file text. */
function bundle(files: Record<string, string>) {
  return {
    exists: async (p: string) => p in files,
    read: async (p: string) => (p in files ? files[p] : null),
  };
}
const page = (body: string) => `<!doctype html><html><head>${body}</head><body></body></html>`;
const lint = async (files: Record<string, string>) =>
  (await checkModuleGraph(bundle(files))).problems;

describe('APP_STATIC_SERVER_JS_EXTENSIONS', () => {
  it('is exactly js and mjs (must match the app static server)', () => {
    expect(APP_STATIC_SERVER_JS_EXTENSIONS).toEqual(['js', 'mjs']);
  });
});

describe('checkModuleGraph', () => {
  it('🔴 a page importing ./x.ts is refused, naming the importer and the specifier', async () => {
    expect(
      await lint({
        'index.html': page('<script type="module" src="./main.js"></script>'),
        'main.js': "import { x } from './x.ts';\nconsole.log(x);",
        'x.ts': 'export const x: number = 1;',
      })
    ).toEqual([
      { kind: 'non-js-extension', importer: 'main.js', specifier: './x.ts', resolved: 'x.ts' },
    ]);
  });

  it('🔴 .mjs modules load (the shape of a live unbundled app: index → app.js → *.mjs → *.mjs)', async () => {
    const result = await checkModuleGraph(
      bundle({
        'index.html': page('<script type="module" src="./src/app.js"></script>'),
        'src/app.js': "import { search } from './search.mjs';\nsearch();",
        'src/search.mjs': "export { search } from './query-language.mjs';",
        'src/query-language.mjs': 'export function search() {}',
      })
    );
    expect(result).toEqual({ status: 'checked', problems: [], modulesChecked: 4, unparsed: [] });
  });

  it.each([
    ['.tsx', "import App from './App.tsx';", 'App.tsx'],
    ['.jsx', "import App from './App.jsx';", 'App.jsx'],
    ['.vue', "import App from './App.vue';", 'App.vue'],
    ['no extension', "import App from './App';", 'App'],
    ['an export-from', "export * from './lib.ts';", 'lib.ts'],
  ])('a static import of %s is refused', async (_label, code, target) => {
    const problems = await lint({
      'index.html': page('<script type="module" src="./main.js"></script>'),
      'main.js': code,
      [target]: 'export default 1',
    });
    expect(problems.map((p) => p.kind)).toEqual(['non-js-extension']);
  });

  it('the entry script itself with a non-JavaScript extension is refused', async () => {
    expect(
      await lint({
        'index.html': page('<script type="module" src="/src/main.tsx"></script>'),
        'src/main.tsx': 'export {}',
      })
    ).toEqual([
      {
        kind: 'non-js-extension',
        importer: 'index.html',
        specifier: '/src/main.tsx',
        resolved: 'src/main.tsx',
      },
    ]);
  });

  it('a dynamic import of a SHIPPED .ts file is refused', async () => {
    expect(
      (
        await lint({
          'index.html': page('<script type="module" src="./main.js"></script>'),
          'main.js': "const m = await import('./lazy.ts');",
          'lazy.ts': 'export {}',
        })
      ).map((p) => p.kind)
    ).toEqual(['non-js-extension']);
  });

  it('a static import of a file the bundle does not ship is refused', async () => {
    expect(
      await lint({
        'index.html': page('<script type="module" src="./main.js"></script>'),
        'main.js': "import './gone.js';",
      })
    ).toEqual([
      { kind: 'missing', importer: 'main.js', specifier: './gone.js', resolved: 'gone.js' },
    ]);
  });

  it('a dynamic import of a file the bundle does not ship is NOT refused (dev-only, behind a flag)', async () => {
    expect(
      await lint({
        'index.html': page('<script type="module" src="./src/app.js"></script>'),
        'src/app.js': "if (mock) { await import('../mock/panel.mjs'); }",
      })
    ).toEqual([]);
  });

  it('🔴 a bare specifier in an unbundled page is refused; mapped by an import map it loads', async () => {
    const files = {
      'index.html': page('<script type="module" src="./main.js"></script>'),
      'main.js': "import React from 'react';",
    };
    expect(await lint(files)).toEqual([
      { kind: 'bare-specifier', importer: 'main.js', specifier: 'react' },
    ]);
    expect(
      await lint({
        ...files,
        'index.html': page(
          '<script type="importmap">{"imports":{"react":"https://esm.sh/react@19"}}</script>' +
            '<script type="module" src="./main.js"></script>'
        ),
      })
    ).toEqual([]);
  });

  it('an import-map prefix that points into the bundle is followed and checked', async () => {
    expect(
      await lint({
        'index.html': page(
          '<script type="importmap">{"imports":{"lib/":"./vendor/lib/"}}</script>' +
            '<script type="module" src="./main.js"></script>'
        ),
        'main.js': "import 'lib/a.js'; import 'lib/b.ts';",
        'vendor/lib/a.js': '',
        'vendor/lib/b.ts': '',
      })
    ).toEqual([
      {
        kind: 'non-js-extension',
        importer: 'main.js',
        specifier: 'lib/b.ts',
        resolved: 'vendor/lib/b.ts',
      },
    ]);
  });

  it('a page-relative src written without ./ (src="main.js") resolves next to the page', async () => {
    expect(
      await lint({
        'index.html': page('<script type="module" src="main.js"></script>'),
        'main.js': 'export {}',
      })
    ).toEqual([]);
  });

  it('full URLs, JSON modules with an import attribute and inline modules', async () => {
    expect(
      await lint({
        'index.html': page(
          '<script type="module">import "./boot.js";</script>' +
            '<script type="module" src="https://cdn.example/x.ts"></script>'
        ),
        'boot.js':
          "import data from './data.json' with { type: 'json' };\nimport 'https://cdn.example/y.tsx';",
        'data.json': '{}',
      })
    ).toEqual([]);
  });

  it('a JSON import WITHOUT an import attribute is refused', async () => {
    expect(
      (
        await lint({
          'index.html': page('<script type="module" src="./main.js"></script>'),
          'main.js': "import data from './data.json';",
          'data.json': '{}',
        })
      ).map((p) => p.kind)
    ).toEqual(['non-js-extension']);
  });

  it('files the page never loads are not checked (build tooling importing .ts and node:fs)', async () => {
    expect(
      await lint({
        'index.html': page('<script type="module" src="./main.js"></script>'),
        'main.js': 'export {}',
        'scripts/build.mjs': "import fs from 'node:fs'; import './helpers.ts';",
      })
    ).toEqual([]);
  });

  it('a reached module that does not parse is skipped, never refused', async () => {
    const result = await checkModuleGraph(
      bundle({
        'index.html': page('<script type="module" src="./main.js"></script>'),
        'main.js': 'export const = ;',
      })
    );
    expect(result).toEqual({
      status: 'checked',
      problems: [],
      modulesChecked: 2,
      unparsed: ['main.js'],
    });
  });

  it('a path that climbs out of the bundle is reported missing', async () => {
    expect(
      await lint({
        'index.html': page('<script type="module" src="./main.js"></script>'),
        'main.js': "import '../../etc/x.js';",
      })
    ).toEqual([
      {
        kind: 'missing',
        importer: 'main.js',
        specifier: '../../etc/x.js',
        resolved: '(outside the bundle)',
      },
    ]);
  });

  it('no index.html: skipped', async () => {
    expect((await checkModuleGraph(bundle({ 'main.js': '' }))).status).toBe('skipped');
  });
});

describe('resolveBundlePath', () => {
  it.each([
    ['index.html', './a.js', 'a.js'],
    ['src/app.js', '../lib/b.mjs', 'lib/b.mjs'],
    ['src/app.js', '/root.js?v=2#x', 'root.js'],
    ['src/app.js', './my%20file.js', 'src/my file.js'],
    ['a.js', '../x.js', null],
  ])('%s + %s → %s', (importer, spec, out) => {
    expect(resolveBundlePath(importer, spec)).toBe(out);
  });
});

describe('the refusal the author reads', () => {
  it('names the file, the specifier and the fix', () => {
    expect(
      describeModuleGraphProblem({
        kind: 'non-js-extension',
        importer: 'main.js',
        specifier: './x.ts',
        resolved: 'x.ts',
      })
    ).toBe(
      'main.js imports "./x.ts" (x.ts), but the app server sends only .js and .mjs files as JavaScript, so the browser will not run it. Ship that module as .js or .mjs (build the app first, or set buildCommand and outputDir in the manifest so the platform builds it).'
    );
  });
});

describe('assertBundleModuleGraphLoads (a submitted ZIP)', () => {
  async function zip(files: Record<string, string>): Promise<Buffer> {
    const z = new JSZip();
    for (const [p, c] of Object.entries(files)) z.file(p, c);
    return z.generateAsync({ type: 'nodebuffer' });
  }

  it('🔴 refuses a no-build bundle importing ./x.ts, with the problem list', async () => {
    const buf = await zip({
      'block.manifest.json': '{}',
      'index.html': page('<script type="module" src="./main.js"></script>'),
      'main.js': "import './x.ts';",
      'x.ts': '',
    });
    const err = await assertBundleModuleGraphLoads(buf, {}).catch((e: unknown) => e);
    expect(isModuleGraphRefusal(err)).toBe(true);
    expect((err as ModuleGraphRefusal).problems).toEqual([
      { kind: 'non-js-extension', importer: 'main.js', specifier: './x.ts', resolved: 'x.ts' },
    ]);
    expect((err as Error).message).toBe(
      'This bundle\'s JavaScript would not load in the browser: main.js imports "./x.ts" (x.ts), but the app server sends only .js and .mjs files as JavaScript, so the browser will not run it. Ship that module as .js or .mjs (build the app first, or set buildCommand and outputDir in the manifest so the platform builds it).'
    );
  });

  it('passes a no-build bundle of .js + .mjs modules', async () => {
    const buf = await zip({
      'index.html': page('<script type="module" src="./a.js"></script>'),
      'a.js': "import './b.mjs';",
      'b.mjs': '',
    });
    expect((await assertBundleModuleGraphLoads(buf, {})).status).toBe('checked');
  });

  it('a bundle the platform builds (buildCommand) is not linted: its files are source', async () => {
    const buf = await zip({
      'index.html': page('<script type="module" src="/src/main.tsx"></script>'),
      'src/main.tsx': "import React from 'react';",
    });
    expect(
      await assertBundleModuleGraphLoads(buf, { buildCommand: 'vite build', outputDir: 'dist' })
    ).toEqual({
      status: 'skipped',
      reason: 'the platform builds this bundle (buildCommand)',
      problems: [],
    });
  });

  it('more than three problems: the message shows three and counts the rest', async () => {
    const buf = await zip({
      'index.html': page('<script type="module" src="./main.js"></script>'),
      'main.js':
        "import './a.ts'; import './b.ts'; import './c.ts'; import './d.ts'; import './e.ts';",
      'a.ts': '',
      'b.ts': '',
      'c.ts': '',
      'd.ts': '',
      'e.ts': '',
    });
    const err = (await assertBundleModuleGraphLoads(buf, {}).catch(
      (e: unknown) => e
    )) as ModuleGraphRefusal;
    expect(err.problems).toHaveLength(5);
    expect(err.message.endsWith(' (2 more problems in moduleGraphErrors.)')).toBe(true);
  });
});
