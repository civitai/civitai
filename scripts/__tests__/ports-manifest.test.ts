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
  metricEndpoint: 'infinite',
  status: 'shadow',
  routes: ['/api/trpc/image.getInfinite'],
  nodeEntry: { file: 'src/server/routers/image.router.ts', symbol: 'imageRouter.getInfinite' },
  goHandler: ['apps/feed-go/internal/feed/infinite.go'],
  flags: { shadow: 'fx-shadow', transport: 'fx-transport', probe: null },
  holdout: null,
  soak: null,
  nodeDeletion: null,
});
const errs = (port: Port) => schemaErrors({ ports: [port] }, schema);
const signedOff = { startedAt: '2026-01-01', signedOffBy: 'a-reviewer', signedOffAt: '2026-01-20' };
const deletionSignedOff = { signedOffBy: 'b-reviewer', signedOffAt: '2026-02-01' };
const goOnly = (): Port => ({
  ...base(),
  status: 'go-only',
  soak: signedOff,
  nodeDeletion: deletionSignedOff,
  nodeEntry: null,
});
const without = (port: Port, key: string): Port => {
  const copy = { ...port };
  delete copy[key];
  return copy;
};

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
      errs({
        ...base(),
        status: 'node-fallback',
        soak: signedOff,
        nodeDeletion: deletionSignedOff,
      })
    ).toEqual([]);
    expect(errs(goOnly())).toEqual([]);
  });

  // Pinned by message: each must be rejected for the Node-deletion rule, not for something else.
  it('rejects go-only without its own Node-deletion sign-off, even with the soak signed off', () => {
    expect(errs({ ...goOnly(), nodeDeletion: null })).toContain(
      '/ports/0/nodeDeletion: must be object'
    );
    expect(errs(without(goOnly(), 'nodeDeletion'))).toEqual([
      "/ports/0: must have required property 'nodeDeletion'",
    ]);
  });

  it('rejects ramp without a shadow flag, for the shadow flag', () => {
    expect(
      errs({
        ...base(),
        status: 'ramp',
        flags: { shadow: null, transport: 'fx-transport', probe: null },
      })
    ).toContain('/ports/0/flags/shadow: must be string');
  });

  // Each row names the error its rule must produce, so a row rejected by some other rule fails.
  it.each<[string, Port, string]>([
    [
      'an unknown status',
      { ...base(), status: 'live' },
      '/ports/0/status: must be equal to one of the allowed values',
    ],
    [
      'shadow without a shadow flag',
      { ...base(), flags: { shadow: null, transport: null, probe: null } },
      '/ports/0/flags/shadow: must be string',
    ],
    ['shadow with a holdout', { ...base(), holdout: 5 }, '/ports/0/holdout: must be null'],
    [
      'ramp without a transport flag',
      { ...base(), status: 'ramp', flags: { shadow: 'fx-shadow', transport: null, probe: null } },
      '/ports/0/flags/transport: must be string',
    ],
    [
      'soak without a holdout',
      {
        ...base(),
        status: 'soak',
        soak: { startedAt: '2026-01-01', signedOffBy: null, signedOffAt: null },
      },
      '/ports/0/holdout: must be number',
    ],
    [
      'soak without a soak record',
      { ...base(), status: 'soak', holdout: 5 },
      '/ports/0/soak: must be object',
    ],
    [
      'node-fallback without a sign-off',
      { ...base(), status: 'node-fallback', soak: { ...signedOff, signedOffBy: null } },
      '/ports/0/soak/signedOffBy: must be string',
    ],
    [
      'go-only that still has a Node entry',
      { ...goOnly(), nodeEntry: base().nodeEntry },
      '/ports/0/nodeEntry: must be null',
    ],
    [
      'go-only whose Node-deletion sign-off names nobody',
      { ...goOnly(), nodeDeletion: { signedOffBy: '', signedOffAt: '2026-02-01' } },
      '/ports/0/nodeDeletion/signedOffBy: must NOT have fewer than 1 characters',
    ],
    [
      'a Node-deletion sign-off during shadow',
      { ...base(), nodeDeletion: deletionSignedOff },
      '/ports/0/nodeDeletion: must be null',
    ],
    [
      'a port without metricEndpoint',
      without(base(), 'metricEndpoint'),
      "/ports/0: must have required property 'metricEndpoint'",
    ],
    [
      'a metricEndpoint that is not a label value',
      { ...base(), metricEndpoint: 'Infinite Feed' },
      '/ports/0/metricEndpoint: must match pattern "^[a-z0-9][a-z0-9-]*$"',
    ],
    // Dependencies are computed in CI and never stored.
    [
      'a port that stores nodeDeps',
      { ...base(), nodeDeps: ['src/a.ts'] },
      '/ports/0: must NOT have additional properties',
    ],
    [
      'a port that stores goDeps',
      { ...base(), goDeps: ['apps/feed-go/a.go'] },
      '/ports/0: must NOT have additional properties',
    ],
    [
      'a Node entry outside src/',
      { ...base(), nodeEntry: { file: 'apps/x/route.ts', symbol: 'default' } },
      '/ports/0/nodeEntry/file: must match pattern "^src/.+\\.tsx?$"',
    ],
    [
      'a Go handler outside the Go services',
      { ...base(), goHandler: ['apps/other/main.go'] },
      '/ports/0/goHandler/0: must match pattern "^apps/(feed-go|beacon-go)/.+\\.go$"',
    ],
    [
      'a tRPC id that is a REST route',
      { ...base(), id: 'GET /api/v1/images' },
      '/ports/0/id: must match pattern "^[a-z][A-Za-z0-9]*\\.[a-z][A-Za-z0-9]*$"',
    ],
    [
      'a REST id without a method',
      { ...base(), kind: 'rest', id: '/api/v1/images' },
      '/ports/0/id: must match pattern "^(GET|POST|PUT|PATCH|DELETE) /api/\\S+$"',
    ],
    [
      'a holdout over 100%',
      { ...base(), status: 'soak', holdout: 101, soak: signedOff },
      '/ports/0/holdout: must be <= 100',
    ],
  ])('rejects %s', (_name, port, expected) => {
    expect(errs(port)).toContain(expected);
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
  // The endpoint labels: two listed in Endpoints, one string constant that is not.
  put(
    'apps/feed-go/internal/server/labels.go',
    [
      'package server',
      '',
      'const (',
      '\tEndpointInfinite = "infinite" // a comment',
      '\tEndpointOther    = "fx-other"',
      ')',
      '',
      'const EndpointUnlisted = "fx-unlisted"',
      '',
      'var Endpoints = []string{EndpointInfinite, EndpointOther}',
      '',
    ].join('\n')
  );
  put('flags.ts', "export const A = 'fx-shadow';\nexport const B = 'fx-transport';\n");
}
const NOW = Date.parse('2026-06-01T12:00:00Z');
const semantic = (...ports: Port[]) => semanticErrors(root, { ports }, ['flags.ts'], NOW);

describe('manifest checks beyond the schema', () => {
  it('accepts a valid port', () => {
    fixture();
    expect(semantic(base())).toEqual([]);
  });

  it('rejects a duplicate id', () => {
    fixture();
    expect(semantic(base(), base())).toEqual([
      'port image.getInfinite: duplicate id',
      "port image.getInfinite: metricEndpoint 'infinite' is also port image.getInfinite's",
    ]);
  });

  it("rejects a metricEndpoint that is not one of the Go service's Endpoints labels", () => {
    fixture();
    expect(semantic({ ...base(), metricEndpoint: 'fx-other' })).toEqual([]);
    // A string constant the Endpoints slice does not list is not a label.
    expect(semantic({ ...base(), metricEndpoint: 'fx-unlisted' })).toEqual([
      "port image.getInfinite: metricEndpoint 'fx-unlisted' is not one of feed-go's endpoint labels (infinite, fx-other)",
    ]);
  });

  it('rejects two ports of a service on one metricEndpoint', () => {
    fixture();
    expect(semantic(base(), { ...base(), id: 'image.getOther' })).toEqual([
      "port image.getOther: metricEndpoint 'infinite' is also port image.getInfinite's",
    ]);
  });

  it('rejects a service without an Endpoints slice', () => {
    fixture();
    expect(
      semantic({
        ...base(),
        service: 'beacon-go',
        goHandler: ['apps/beacon-go/internal/server/server.go'],
      })
    ).toEqual([
      'port image.getInfinite: goHandler apps/beacon-go/internal/server/server.go does not exist',
      'port image.getInfinite: metricEndpoint: no `var Endpoints = []string{...}` in apps/beacon-go',
    ]);
  });

  it('rejects a date in the future, with one day of slack', () => {
    fixture();
    const started = (startedAt: string) =>
      semantic({
        ...base(),
        status: 'soak',
        holdout: 5,
        soak: { startedAt, signedOffBy: null, signedOffAt: null },
      });
    expect(started('2026-06-02')).toEqual([]);
    expect(started('2026-06-03')).toEqual([
      'port image.getInfinite: soak.startedAt 2026-06-03 is in the future or does not parse as a date',
    ]);
    expect(
      semantic({
        ...goOnly(),
        nodeDeletion: { signedOffBy: 'b-reviewer', signedOffAt: '2027-01-01' },
      })
    ).toEqual([
      'port image.getInfinite: nodeDeletion.signedOffAt 2027-01-01 is in the future or does not parse as a date',
    ]);
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
