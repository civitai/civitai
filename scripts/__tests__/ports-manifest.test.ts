import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { schemaErrors, semanticErrors } from '../ports/manifest.mjs';

// ports/manifest.schema.json and the checks beside it (scripts/ports/manifest.mjs): the lifecycle
// rules in ports/README.md, each case a single change to a port the schema accepts.

const REPO = resolve(__dirname, '../..');
const schema = JSON.parse(readFileSync(join(REPO, 'ports/manifest.schema.json'), 'utf8'));

type Port = Record<string, unknown>;
const base = (): Port => ({
  id: 'image.getInfinite',
  kind: 'trpc',
  service: 'feed-go',
  status: 'shadow',
  routes: ['/api/trpc/image.getInfinite'],
  nodeEntry: { file: 'src/server/routers/image.router.ts', symbol: 'imageRouter.getInfinite' },
  goHandler: ['apps/feed-go/internal/feed/infinite.go'],
  flags: { shadow: 'fx-shadow', transport: 'fx-transport', probe: null },
  holdout: null,
  soak: null,
  nodeDeps: ['src/server/routers/image.router.ts'],
  goDeps: ['apps/feed-go/internal/feed/infinite.go'],
});
const errs = (port: Port) => schemaErrors({ ports: [port] }, schema);
const signedOff = { startedAt: '2026-01-01', signedOffBy: 'a-reviewer', signedOffAt: '2026-01-20' };

describe('manifest schema', () => {
  it('accepts a valid port at every stage', () => {
    expect(errs(base())).toEqual([]);
    expect(errs({ ...base(), status: 'ramp' })).toEqual([]);
    expect(
      errs({
        ...base(),
        status: 'soak',
        holdout: 5,
        soak: { startedAt: '2026-01-01', signedOffBy: null, signedOffAt: null },
      })
    ).toEqual([]);
    expect(errs({ ...base(), status: 'node-fallback', soak: signedOff })).toEqual([]);
    expect(
      errs({ ...base(), status: 'go-only', soak: signedOff, nodeEntry: null, nodeDeps: [] })
    ).toEqual([]);
  });

  it.each<[string, Port]>([
    ['an unknown status', { ...base(), status: 'live' }],
    [
      'shadow without a shadow flag',
      { ...base(), flags: { shadow: null, transport: null, probe: null } },
    ],
    ['shadow with a holdout', { ...base(), holdout: 5 }],
    [
      'ramp without a transport flag',
      { ...base(), status: 'ramp', flags: { shadow: 'fx-shadow', transport: null, probe: null } },
    ],
    [
      'soak without a holdout',
      {
        ...base(),
        status: 'soak',
        soak: { startedAt: '2026-01-01', signedOffBy: null, signedOffAt: null },
      },
    ],
    ['soak without a soak record', { ...base(), status: 'soak', holdout: 5 }],
    [
      'node-fallback without a sign-off',
      { ...base(), status: 'node-fallback', soak: { ...signedOff, signedOffBy: null } },
    ],
    ['go-only that still has a Node entry', { ...base(), status: 'go-only', soak: signedOff }],
    [
      'a Node entry outside src/',
      { ...base(), nodeEntry: { file: 'apps/x/route.ts', symbol: 'default' } },
    ],
    ['a Go handler outside the Go services', { ...base(), goHandler: ['apps/other/main.go'] }],
    ['a tRPC id that is a REST route', { ...base(), id: 'GET /api/v1/images' }],
    ['a REST id without a method', { ...base(), kind: 'rest', id: '/api/v1/images' }],
    ['a port without generated deps', (({ nodeDeps: _n, ...rest }) => rest)(base())],
    ['a holdout over 100%', { ...base(), status: 'soak', holdout: 101, soak: signedOff }],
  ])('rejects %s', (_name, port) => {
    expect(errs(port)).not.toEqual([]);
  });
});

// Not every test builds a fixture.
let root = '';
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});
function fixture() {
  root = mkdtempSync(join(tmpdir(), 'ports-manifest-'));
  const put = (rel: string, text: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  put('src/server/routers/image.router.ts', '');
  put('apps/feed-go/internal/feed/infinite.go', 'package feed\n');
  put('flags.ts', "export const A = 'fx-shadow';\nexport const B = 'fx-transport';\n");
}
const semantic = (...ports: Port[]) => semanticErrors(root, { ports }, ['flags.ts']);

describe('manifest checks beyond the schema', () => {
  it('accepts a valid port', () => {
    fixture();
    expect(semantic(base())).toEqual([]);
  });

  it('rejects a duplicate id', () => {
    fixture();
    expect(semantic(base(), base())).toEqual(['port image.getInfinite: duplicate id']);
  });

  it('rejects a flag no flag source declares', () => {
    fixture();
    expect(
      semantic({
        ...base(),
        flags: { shadow: 'fx-shadow', transport: null, probe: 'fx-undeclared' },
      })
    ).toEqual(["port image.getInfinite: flags.probe 'fx-undeclared' is not declared in flags.ts"]);
  });

  it('rejects a sign-off before the 14-day soak has run, at the boundary', () => {
    fixture();
    const at = (signedOffAt: string) =>
      semantic({
        ...base(),
        status: 'node-fallback',
        soak: { startedAt: '2026-01-01', signedOffBy: 'r', signedOffAt },
      });
    expect(at('2026-01-15')).toEqual([]);
    expect(at('2026-01-14')).toEqual([
      'port image.getInfinite: soak signed off 2026-01-14, 13 days after it started (2026-01-01); the gate is 14 days',
    ]);
  });

  it('rejects a missing Node entry file and a Go handler outside its service', () => {
    fixture();
    expect(
      semantic({
        ...base(),
        nodeEntry: { file: 'src/gone.ts', symbol: 'default' },
        goHandler: ['apps/beacon-go/internal/server/server.go'],
      })
    ).toEqual([
      'port image.getInfinite: nodeEntry.file src/gone.ts does not exist',
      'port image.getInfinite: goHandler apps/beacon-go/internal/server/server.go is outside apps/feed-go',
    ]);
  });
});

describe('the committed manifest', () => {
  it('passes the schema and the checks beside it', () => {
    const manifest = JSON.parse(readFileSync(join(REPO, 'ports/manifest.json'), 'utf8'));
    expect(manifest.ports.length).toBeGreaterThan(0);
    expect(schemaErrors(manifest, schema)).toEqual([]);
    expect(semanticErrors(REPO, manifest)).toEqual([]);
  });
});
