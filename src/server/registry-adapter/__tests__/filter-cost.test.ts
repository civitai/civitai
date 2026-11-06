import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { Adapter, Change, Entity } from '~/server/registry-adapter/protocol';
import { createRegistryServer } from '~/server/registry-adapter/serve';

/**
 * A request's `filter` is evaluated synchronously, per entity and per poll, on the one event loop
 * that serves every stream. One whose cost is not bounded by its size is not applied (the registry
 * applies it anyway, spec rule 6), so an anonymous consumer cannot stall the source.
 */

const APPS = 'urn:schema:apps.civitai.com:app@v1';
const one: Entity = {
  urn: 'urn:apps.civitai.com:app/orbit-notes',
  schemas: [APPS],
  rev: 'rev-7a',
  body: { slug: 'orbit-notes' },
};

async function* nothing(): AsyncGenerator<Change> {}

const adapter: Adapter = {
  namespace: 'apps.civitai.com',
  serves: (schema) => schema === APPS,
  // eslint-disable-next-line local-rules/no-unbounded-paging-fake -- a snapshot is one call, not a page loop
  snapshot: async () => ({ cursor: 'c1.snapshot-cursor', entities: [one] }),
  changes: async () => nothing(),
};

let server: Server | undefined;
afterEach(
  () => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
);

async function get(filter: unknown) {
  server = createRegistryServer(adapter);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const started = performance.now();
  const res = await fetch(
    `http://127.0.0.1:${port}/subscribe?schema=${encodeURIComponent(APPS)}` +
      `&filter=${encodeURIComponent(JSON.stringify(filter))}`
  );
  const text = await res.text();
  return { status: res.status, text, ms: performance.now() - started };
}

/**
 * Definitions that each hold two references to the next: evaluating `d0` evaluates `d<depth>`
 * 2^depth times. The last one admits nothing, so `anyOf` must try both branches at every level,
 * and the filter, if applied, excludes the entity. Measured with ajv directly: depth 20 takes
 * ~0.4s, 22 over 1s, and 24 exhausted a 4 GB heap; the filter stays under 1.5 KiB throughout.
 */
function refDag(depth: number, key: '$defs' | 'definitions' = '$defs') {
  const defs: Record<string, unknown> = {};
  for (let i = 0; i < depth; i++) {
    const next = { $ref: `#/${key}/d${i + 1}` };
    defs[`d${i}`] = { anyOf: [next, next] };
  }
  defs[`d${depth}`] = { not: {} };
  return { $ref: `#/${key}/d0`, [key]: defs };
}

describe('🔴 a filter whose evaluation cost is unbounded by its size is not applied', () => {
  it.each([['$defs' as const], ['definitions' as const]])(
    'an exponential $ref DAG through %s: not applied, so the entity it would exclude is still sent, promptly',
    async (key) => {
      const res = await get(refDag(20, key));
      expect(res.status).toBe(200);
      expect(res.text.startsWith('event: upsert')).toBe(true);
      expect(res.ms).toBeLessThan(2_000);
    }
  );

  it.each([
    ['$dynamicRef', { $dynamicRef: '#meta', not: {} }],
    ['$recursiveRef', { $recursiveRef: '#', not: {} }],
    ['a $ref with no definitions', { not: { $ref: '#' } }],
  ])('a filter using %s is not applied either', async (_name, filter) => {
    const res = await get(filter);
    expect(res.text.startsWith('event: upsert')).toBe(true);
  });

  it('a filter nested deeper than the bound is not applied', async () => {
    let deep: Record<string, unknown> = { not: {} };
    for (let i = 0; i < 40; i++) deep = { allOf: [deep] };
    const res = await get(deep);
    expect(res.text.startsWith('event: upsert')).toBe(true);
  });

  it.each([
    ['const', { properties: { slug: { const: 'zzz' } } }],
    ['enum', { properties: { slug: { enum: ['zzz', 'yyy'] } } }],
    ['required + type', { required: ['missing'], properties: { slug: { type: 'string' } } }],
    ['shallow composition', { anyOf: [{ properties: { slug: { const: 'a' } } }, { not: {} }] }],
  ])('positive control: a %s filter is still applied (the entity is excluded)', async (_n, f) => {
    const res = await get(f);
    expect(res.text.startsWith('event: live')).toBe(true);
  });
});
