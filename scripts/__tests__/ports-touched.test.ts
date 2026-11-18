import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { portsTouched, summary, withDeps } from '../ports/touched.mjs';

// scripts/ports/touched.mjs: a change's files against each port's dependencies, which it computes
// from source (withDeps). Dep files are distinct per port, so a match credited to the wrong port
// cannot pass.

const port = (
  id: string,
  nodeDeps: string[],
  goDeps: string[],
  over: Record<string, unknown> = {}
) => ({
  id,
  service: 'feed-go',
  status: 'shadow',
  routes: [`/api/trpc/${id}`],
  nodeDeps,
  goDeps,
  ...over,
});
const head = {
  ports: [
    port('a.first', ['src/shared.ts', 'src/only-first.ts'], ['apps/feed-go/first.go']),
    port('b.second', ['src/shared.ts', 'src/only-second.ts'], ['apps/feed-go/second.go']),
  ],
};

describe('portsTouched', () => {
  it('reports each port whose Node or Go deps the change touches, with the files', () => {
    expect(
      portsTouched([head], ['src/only-first.ts', 'apps/feed-go/second.go', 'README.md'])
    ).toEqual([
      {
        id: 'a.first',
        service: 'feed-go',
        status: 'shadow',
        manifest: false,
        node: ['src/only-first.ts'],
        go: [],
      },
      {
        id: 'b.second',
        service: 'feed-go',
        status: 'shadow',
        manifest: false,
        node: [],
        go: ['apps/feed-go/second.go'],
      },
    ]);
  });

  it('reports nothing for a change outside every port', () => {
    expect(portsTouched([head], ['src/unrelated.ts', 'apps/feed-go/unrelated.go'])).toEqual([]);
  });

  it('still reports a port when the change deleted the dep that tied it (base manifest)', () => {
    const after = {
      ports: [port('a.first', ['src/shared.ts'], ['apps/feed-go/first.go']), head.ports[1]],
    };
    expect(portsTouched([after], ['src/only-first.ts'])).toEqual([]);
    expect(portsTouched([after, head], ['src/only-first.ts'], head).map((p) => p.id)).toEqual([
      'a.first',
    ]);
  });

  it('marks the port whose manifest entry changed, and not the others', () => {
    const after = { ports: [{ ...head.ports[0], status: 'ramp' }, head.ports[1]] };
    expect(portsTouched([after, head], ['ports/manifest.json'], head)).toEqual([
      { id: 'a.first', service: 'feed-go', status: 'ramp', manifest: true, node: [], go: [] },
    ]);
  });

  it('does not count a regenerated dep list as a manifest change', () => {
    const after = { ports: [{ ...head.ports[0], nodeDeps: ['src/shared.ts'] }, head.ports[1]] };
    expect(portsTouched([after, head], ['ports/manifest.json'], head)).toEqual([]);
  });

  it('reports a port the change adds', () => {
    const after = { ports: [...head.ports, port('c.third', ['src/only-third.ts'], [])] };
    expect(portsTouched([after, head], ['ports/manifest.json'], head).map((p) => p.id)).toEqual([
      'c.third',
    ]);
  });
});

// Not every test builds a fixture.
let root = '';
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

describe('withDeps', () => {
  it('computes each port from source, and reports a port it cannot compute without dropping it', () => {
    root = mkdtempSync(join(tmpdir(), 'ports-touched-'));
    const files: Record<string, string> = {
      'src/route.ts': "import { h } from './route-dep';\nexport default h;\n",
      'src/route-dep.ts': 'export const h = 1;\n',
      'apps/feed-go/go.mod': 'module example.com/fx\n',
    };
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    const p = (id: string, file: string) => ({
      id,
      service: 'feed-go',
      status: 'shadow',
      nodeEntry: { file, symbol: 'default' },
      goHandler: ['apps/feed-go/internal/server/handler.go'],
    });
    const goList = () => '';
    const { ports, errors } = withDeps(
      root,
      { ports: [p('GET /api/fx', 'src/route.ts'), p('GET /api/gone', 'src/gone.ts')] },
      { goList, label: 'HEAD' }
    );
    expect(
      ports.map((x: { id: string; nodeDeps: string[]; goDeps: string[] }) => [
        x.id,
        x.nodeDeps,
        x.goDeps,
      ])
    ).toEqual([
      [
        'GET /api/fx',
        ['src/route-dep.ts', 'src/route.ts'],
        ['apps/feed-go/go.mod', 'apps/feed-go/internal/server/handler.go'],
      ],
      ['GET /api/gone', [], ['apps/feed-go/go.mod', 'apps/feed-go/internal/server/handler.go']],
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^HEAD: port GET \/api\/gone: Node deps: /);
  });
});

describe('summary', () => {
  it('lists each touched port with its changed files, and the errors', () => {
    expect(
      summary({
        changedFiles: 3,
        ports: [
          {
            id: 'a.first',
            service: 'feed-go',
            status: 'shadow',
            manifest: false,
            node: ['src/only-first.ts'],
            go: ['apps/feed-go/first.go'],
          },
        ],
        errors: ['base abc: port b.second: Go deps: go list failed\n  detail'],
      })
    ).toBe(
      [
        '### Node→Go ports touched\n',
        '3 changed file(s).\n',
        '| Port | Service | Status | Node deps changed | Go deps changed | Manifest entry changed |',
        '|---|---|---|---|---|---|',
        '| `a.first` | feed-go | shadow | 1 | 1 |  |',
        '',
        '<details><summary><code>a.first</code>: 2 changed file(s)</summary>\n',
        '- `src/only-first.ts`',
        '- `apps/feed-go/first.go`',
        '\n</details>\n',
        '**Could not compute every dependency list** (report-only; this does not fail CI):\n',
        '- base abc: port b.second: Go deps: go list failed',
        '',
      ].join('\n') + '\n'
    );
  });
});
