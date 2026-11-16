import { describe, expect, it } from 'vitest';

import { portsTouched } from '../ports/touched.mjs';

// scripts/ports/touched.mjs: a change's files against each port's generated deps. Dep files are
// distinct per port, so a match credited to the wrong port cannot pass.

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
