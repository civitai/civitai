import { describe, it, expect, beforeEach, vi } from 'vitest';

// Regression guard for ClickUp 868kta7p0. The blocked-hash writers moved their values
// through a JS `number`, which holds 53 bits — every 64-bit hash was silently rounded on
// the way in, while both readers pass the value through at full precision. Nothing errors
// and the row count looks right, so the only thing that catches it is asserting the exact
// value at the clickhouse boundary.
//
// image.service is the graph root. db/redis/logging come from the canonical shared mocks
// registered in setup; what is left here is the clickhouse boundary this asserts on, plus
// the env and submodule stubs image.service needs to import at all.

const capturedInserts: Array<{ table: string; values: any[] }> = [];
const capturedQueries: string[] = [];
let queryResult: any[] = [];

function makePermissive(overrides: Record<string, unknown> = {}): any {
  const handler: ProxyHandler<any> = {
    get(target, prop) {
      if (prop === 'then') return undefined;
      if (typeof prop === 'symbol') return undefined;
      if (prop in overrides) return overrides[prop as string];
      if (!(prop in target)) target[prop as string] = makePermissive();
      return target[prop as string];
    },
    apply() {
      return Promise.resolve([]);
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  return new Proxy(function () {}, handler);
}

// event-engine-common is a git submodule, not checked out by default.
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

// Real env validation throws in test; a Proxy hands back safe defaults for whatever
// image.service reads at import time.
vi.mock('~/env/server', () => ({
  env: new Proxy({ LOGGING: [] as string[] } as Record<string, unknown>, {
    get: (target, prop) => {
      if (prop in target) return target[prop as string];
      if (typeof prop === 'string' && (prop.endsWith('_URL') || prop.endsWith('_ENDPOINT')))
        return 'https://test:test@localhost:5432/test';
      if (
        typeof prop === 'string' &&
        /(_CONCURRENCY|_LIMIT|_MS|_PORT|_TIMEOUT|_MAX|_SIZE|_COUNT)$/.test(prop)
      )
        return 1;
      return undefined;
    },
  }),
}));

vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: makePermissive({
    insert: async (args: { table: string; values: any[] }) => {
      capturedInserts.push({ table: args.table, values: args.values });
    },
    $query: (strings: TemplateStringsArray, ...values: unknown[]) => {
      capturedQueries.push(
        Array.isArray(strings)
          ? strings.reduce((acc, part, i) => acc + part + (values[i] ?? ''), '')
          : String(strings)
      );
      return Promise.resolve(queryResult);
    },
  }),
}));

const { addBlockedImage, bulkAddBlockedImages, bulkRemoveBlockedImages } = await import(
  '../image.service'
);

// A real 64-bit pHash: past 2^53, and one whose rounded form is visibly different so a
// revert prints the wrong value beside the right one rather than timing out.
const HASH = -4276845791567733103n;
const ROUNDED = String(Number(HASH)); // '-4276845791567733000'

describe('blocked-image hashes keep all 64 bits (ClickUp 868kta7p0)', () => {
  beforeEach(() => {
    capturedInserts.length = 0;
    capturedQueries.length = 0;
    queryResult = [];
  });

  it('addBlockedImage writes the exact hash', async () => {
    await addBlockedImage({ hash: HASH, reason: 'TOS' as any });

    expect(capturedInserts).toHaveLength(1);
    expect(String(capturedInserts[0].values[0].hash)).toBe(HASH.toString());
  });

  it('bulkAddBlockedImages writes the exact hash', async () => {
    await bulkAddBlockedImages({ data: [{ hash: HASH, reason: 'TOS' as any }] });

    expect(capturedInserts).toHaveLength(1);
    expect(String(capturedInserts[0].values[0].hash)).toBe(HASH.toString());
  });

  it('bulkRemoveBlockedImages selects the hash as text and re-writes it exactly', async () => {
    // The client sets output_format_json_quote_64bit_integers: 0, so an unquoted Int64
    // comes back already rounded — the disable row must be built from text.
    queryResult = [{ hash: HASH.toString(), reason: 'TOS' }];

    await bulkRemoveBlockedImages([HASH]);

    expect(capturedQueries[0]).toContain('toString(hash)');
    expect(capturedQueries[0]).toContain(HASH.toString());
    expect(capturedInserts).toHaveLength(1);
    expect(capturedInserts[0].values[0]).toMatchObject({ hash: HASH.toString(), disabled: true });
  });

  it('the rounded form these guards exclude really is a different value', () => {
    expect(ROUNDED).not.toBe(HASH.toString());
  });
});
