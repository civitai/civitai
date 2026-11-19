import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// apps/content-policy-go's golden test decides every vector in this committed file and compares it
// with what the REAL Node code answered when the file was generated. This test regenerates the file
// from today's Node code (the site's and the registry adapter's own functions) and fails when the
// committed one differs, so a Node change that moves an answer cannot merge without the Go side
// being checked against it. Regenerate:
//
//   pnpm exec tsx --tsconfig tsconfig.json apps/content-policy-go/testdata/golden/gen.ts

import type * as GenModule from '../../apps/content-policy-go/testdata/golden/gen';
import type { Vector } from '../../apps/content-policy-go/testdata/golden/gen';

type Gen = typeof GenModule;

const ENV_KEYS = [
  'REGION_RESTRICTION_CONFIG',
  'REGION_BLOCK_CONFIG',
  'SERVER_DOMAIN_GREEN',
  'SERVER_DOMAIN_BLUE',
  'SERVER_DOMAIN_RED',
  'SERVER_DOMAIN_GREEN_ALIASES',
  'SERVER_DOMAIN_BLUE_ALIASES',
  'SERVER_DOMAIN_RED_ALIASES',
  'REGISTRY_ADAPTER_TRUST_META',
  'DEV_REGION_OVERRIDE',
];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let gen: Gen;
let rendered: string;
let committed: string;

beforeAll(async () => {
  // The generator sets the region lists and hosts before importing the modules that read them at
  // load; a fresh module registry makes sure none was loaded earlier with other values.
  vi.resetModules();
  gen = await import('../../apps/content-policy-go/testdata/golden/gen');
  rendered = await gen.renderVectors();
  committed = readFileSync(gen.CONTENT_POLICY_VECTORS_PATH, 'utf8');
}, 180_000);

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** The first line where `a` and `b` differ, with both versions, or null when they are equal. */
function firstDifference(a: string, b: string) {
  if (a === b) return null;
  const la = a.split('\n');
  const lb = b.split('\n');
  for (let i = 0; i < Math.max(la.length, lb.length); i++)
    if (la[i] !== lb[i]) return { line: i + 1, committed: la[i], generated: lb[i] };
  return { line: -1, committed: '(lengths differ)', generated: '' };
}

describe('apps/content-policy-go testdata/golden/vectors.json', () => {
  it('is what the Node code answers today (regenerate with gen.ts, see the file comment)', () => {
    expect(firstDifference(committed, rendered)).toBeNull();
  });

  // Positive control: the generator ran the real functions over the matrix, so known answers must be
  // in it, pinned as literals (a generator that ran nothing, or ran it under other region lists,
  // would still produce a file).
  it('holds answers the Node code is known to give', () => {
    const { vectors } = JSON.parse(rendered) as { vectors: Vector[] };
    expect(vectors.length).toBeGreaterThan(2000);
    const find = (p: Partial<Vector>) =>
      vectors.find((v) =>
        Object.entries(p).every(([k, val]) => (v as Record<string, unknown>)[k] === val)
      )?.want;
    // The adapter holds an unknown country to SFW; the site serves it unrestricted.
    expect(
      find({ context: 'registry-subscription', country: 'XX', user: 's1-l31-m0' })
    ).toMatchObject({
      regionHold: 'restricted',
      reason: 'unknown-country',
      ratings: ['g', 'pg', 'pg13'],
    });
    expect(find({ context: 'site', country: 'XX', user: 's1-l31-m0', host: 'red' })).toMatchObject({
      regionHold: 'none',
      browsingLevel: 31,
    });
    // FR is restricted from the END of 2025-08-01, not before.
    expect(
      find({ context: 'public-api', country: 'FR', user: null, at: '2025-08-01T23:59:59.998Z' })
    ).toMatchObject({ regionHold: 'none', browsingLevel: 31 });
    expect(
      find({ context: 'public-api', country: 'FR', user: null, at: '2025-08-01T23:59:59.999Z' })
    ).toMatchObject({ regionHold: 'restricted', browsingLevel: 3 });
    // A blocked region: held to SFW by the adapter, refused by the site.
    expect(
      find({ context: 'registry-subscription', country: 'GB', user: 's1-l31-m0' })
    ).toMatchObject({ regionHold: 'blocked', ratings: ['g', 'pg', 'pg13'] });
    expect(find({ context: 'site', country: 'GB', user: 's1-l31-m0', host: 'red' })).toEqual({
      ratings: [],
      unknownRating: false,
      browsingLevel: 0,
      regionHold: 'blocked',
      reason: 'region-blocked',
    });
  });
});
