/**
 * The App Storage shadow read (`app-data-shadow.service.ts`): which lists are shadowed, what is
 * asked of app-data-go, how the two answers are compared, and that every failure is an outcome
 * rather than an error.
 *
 * Driven through `createAppDataShadow` with the flag, randomness, config, app-data-go's HTTP
 * answers and the schema major passed in; nothing of this repo is module-mocked. The counters are
 * the real ones, read as deltas from the registry `/api/metrics` scrapes.
 */
import { instrumentationRegistry } from '@civitai/telemetry/client';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  APP_DATA_REGISTRY_ONLY_HEADER,
  compareRecords,
  createAppDataShadow,
  type AppDataShadowConfig,
  type AppDataShadowInput,
  type AppDataShadowLogEntry,
} from '~/server/services/apps/app-data-shadow.service';

const BASE = 'http://app-data.invalid/base/';
const AUTH = 'Bearer eyJhbGciOiJSUzI1NiJ9.eyJqdGkiOiJzaGFkb3cifQ.c2ln';

type Call = { url: string; headers: Record<string, string>; timeoutMs: number };
let calls: Call[];
let flagCalls: [string, string][];
let flag: boolean;
let config: AppDataShadowConfig;
let random: number;
let major: () => Promise<number | null>;
let logs: AppDataShadowLogEntry[];
let reply: () => Promise<Response> | Response;

function makeShadow() {
  return createAppDataShadow({
    enabled: async (appBlockId, blockId) => {
      flagCalls.push([appBlockId, blockId]);
      return flag;
    },
    config: () => config,
    random: () => random,
    fetch: async (url, init) => {
      calls.push({ url, headers: init.headers, timeoutMs: init.timeoutMs });
      return reply();
    },
    major: () => major(),
    log: (entry) => logs.push(entry),
  });
}

/** Pairwise-distinct record bodies; none equals another, and none is a constant the code names. */
const R1 = { data: { score: 71, model: 'bench-alpha-4c1' } };
const R2 = { data: { score: 18, model: 'bench-bravo-9e7' } };
const R3 = { data: { score: 55, model: 'bench-charlie-2d3' } };

function input(over: Partial<AppDataShadowInput> = {}): AppDataShadowInput {
  return {
    authorization: AUTH,
    own: true,
    published: true,
    tokenKind: 'app',
    signedIn: true,
    visibility: 'private',
    queryKeys: [],
    appBlockId: 'apb_bench01',
    blockId: 'model-benchmarking',
    collection: 'runs',
    head: undefined,
    served: { items: [R1, R2], nextCursor: null },
    ...over,
  };
}

const registryAnswer = (items: { data: unknown }[]) => () =>
  Response.json({
    source: 'registry',
    items: items.map((r, i) => ({ urn: `urn:x/${i}`, rev: `r${i}`, data: r.data })),
  });
const noneAnswer = (reason: string) => () => Response.json({ source: 'none', reason, items: [] });

async function readCounter(name: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const metric = instrumentationRegistry.getSingleMetric(name);
  if (!metric) return out;
  for (const v of (await metric.get()).values) {
    const key = Object.values(v.labels).join('/');
    out.set(key, (out.get(key) ?? 0) + v.value);
  }
  return out;
}
const COUNTERS = [
  'app_data_shadow_requests_total',
  'app_data_shadow_registry_misses_total',
  'app_data_shadow_compared_total',
  'app_data_shadow_compared_records_total',
  'app_data_shadow_mismatched_records_total',
] as const;
let baseline: Map<string, Map<string, number>>;
/** Every counter series that moved since the test began, as `name{labels}:delta`. */
async function moved(): Promise<string[]> {
  const out: string[] = [];
  for (const name of COUNTERS) {
    const before = baseline.get(name) ?? new Map<string, number>();
    for (const [k, v] of await readCounter(name)) {
      const d = v - (before.get(k) ?? 0);
      if (d > 0) out.push(`${name.replace('app_data_shadow_', '')}{${k}}:${d}`);
    }
  }
  return out.sort();
}

beforeEach(async () => {
  calls = [];
  flagCalls = [];
  logs = [];
  flag = true;
  random = 0;
  config = { url: BASE, sample: 1, maxInFlight: 4, timeoutMs: 1700 };
  major = async () => 3;
  reply = registryAnswer([R1, R2]);
  baseline = new Map();
  for (const name of COUNTERS) baseline.set(name, await readCounter(name));
});

describe('which lists are shadowed', () => {
  it('🔴 flag off: no shadow call, and nothing is counted', async () => {
    flag = false;
    await makeShadow().shadow(input());
    expect(flagCalls).toEqual([['apb_bench01', 'model-benchmarking']]);
    expect(calls).toEqual([]);
    expect(await moved()).toEqual([]);
  });

  it('APP_DATA_SHADOW_URL unset: the flag is not even read', async () => {
    config.url = undefined;
    expect(makeShadow().shadow(input())).toBeUndefined();
    expect(flagCalls).toEqual([]);
    expect(calls).toEqual([]);
    expect(await moved()).toEqual([]);
  });

  it('sampling: only a draw strictly below the rate is shadowed', async () => {
    const shadow = makeShadow();
    config.sample = 0.3;
    random = 0.3;
    expect(shadow.shadow(input())).toBeUndefined();
    random = 0.71;
    expect(shadow.shadow(input())).toBeUndefined();
    expect(flagCalls).toEqual([]);
    random = 0.29;
    await shadow.shadow(input());
    expect(calls).toHaveLength(1);
    config.sample = 0;
    random = 0;
    expect(shadow.shadow(input())).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(await moved()).toContain('requests_total{compared}:1');
  });

  it('a list app-data-go cannot answer the same way is counted and not asked', async () => {
    const shadow = makeShadow();
    for (const over of [
      { own: false },
      { published: false },
      { tokenKind: 'dev' as const },
      { tokenKind: 'review' as const },
      { signedIn: false },
      { visibility: 'shared' as const },
      { visibility: undefined },
      { authorization: undefined },
      { queryKeys: ['limit', 'sort'] },
      { queryKeys: ['cursor'] },
      { queryKeys: ['where[score]'] },
    ]) {
      await shadow.shadow(input(over));
    }
    await shadow.shadow(input({ served: { items: [R1], nextCursor: 'c2' } }));
    expect(calls).toEqual([]);
    expect(await moved()).toEqual([
      'requests_total{incomplete}:1',
      'requests_total{unsupported_input}:11',
    ]);
  });

  it('a hub token and a page size alone are shadowed', async () => {
    const shadow = makeShadow();
    await shadow.shadow(input({ tokenKind: 'hub' }));
    await shadow.shadow(input({ queryKeys: ['limit'] }));
    expect(calls).toHaveLength(2);
  });
});

describe('what is asked of app-data-go', () => {
  it("the app's own collection at its schema major, with the caller's token, registry only", async () => {
    await makeShadow().shadow(input());
    expect(calls).toEqual([
      {
        url: 'http://app-data.invalid/base/v1/apps/model-benchmarking/collections/runs/records?major=3',
        headers: {
          accept: 'application/json',
          authorization: AUTH,
          [APP_DATA_REGISTRY_ONLY_HEADER]: '1',
        },
        timeoutMs: 1700,
      },
    ]);
    expect(APP_DATA_REGISTRY_ONLY_HEADER).toBe('X-App-Data-Registry-Only');
  });

  it('a collection with no major, or whose major cannot be read, is read at major 1', async () => {
    const shadow = makeShadow();
    major = async () => null;
    await shadow.shadow(input());
    major = async () => {
      throw new Error('replica down');
    };
    await shadow.shadow(input());
    expect(calls.map((c) => new URL(c.url).searchParams.get('major'))).toEqual(['1', '1']);
  });
});

describe('the comparison', () => {
  it('records are matched by their data, whatever its key order', async () => {
    reply = registryAnswer([{ data: { model: 'bench-bravo-9e7', score: 18 } }, R1]);
    await makeShadow().shadow(input());
    expect(logs).toEqual([]);
    expect(await moved()).toEqual([
      'compared_records_total{}:2',
      'compared_total{match}:1',
      'requests_total{compared}:1',
    ]);
  });

  it('🔴 a mismatch is counted per side and logged with counts only, never a value', async () => {
    reply = registryAnswer([R1, R3]);
    await makeShadow().shadow(input());
    expect(logs).toEqual([
      {
        appBlockId: 'apb_bench01',
        collection: 'runs',
        restCount: 2,
        registryCount: 2,
        restOnly: 1,
        registryOnly: 1,
      },
    ]);
    const text = JSON.stringify(logs);
    for (const v of ['bench-alpha-4c1', 'bench-bravo-9e7', 'bench-charlie-2d3', AUTH]) {
      expect(text).not.toContain(v);
    }
    expect(await moved()).toEqual([
      'compared_records_total{}:3',
      'compared_total{mismatch}:1',
      'mismatched_records_total{registry_only}:1',
      'mismatched_records_total{rest_only}:1',
      'requests_total{compared}:1',
    ]);
  });

  it('records are a multiset: a duplicate on one side only is a mismatch', () => {
    expect(compareRecords([R1, R1, R2], [R2, R1])).toEqual({
      restCount: 3,
      registryCount: 2,
      restOnly: 1,
      registryOnly: 0,
    });
    expect(compareRecords([R2], [R2, R3, R3])).toEqual({
      restCount: 1,
      registryCount: 3,
      restOnly: 0,
      registryOnly: 2,
    });
  });

  it('a registry miss is counted by its reason; an unknown reason is `other`', async () => {
    const shadow = makeShadow();
    reply = noneAnswer('token_not_exchangeable');
    await shadow.shadow(input());
    reply = noneAnswer('a-reason-added-later');
    await shadow.shadow(input());
    expect(logs).toEqual([]);
    expect(await moved()).toEqual([
      'registry_misses_total{other}:1',
      'registry_misses_total{token_not_exchangeable}:1',
      'requests_total{registry_miss}:2',
    ]);
  });

  it('an empty registry answer agrees with an empty REST answer and is a miss against records', async () => {
    const shadow = makeShadow();
    reply = noneAnswer('empty');
    await shadow.shadow(input({ served: { items: [], nextCursor: null } }));
    await shadow.shadow(input());
    expect(await moved()).toEqual([
      'compared_total{match}:1',
      'registry_misses_total{empty}:1',
      'requests_total{compared}:1',
      'requests_total{registry_miss}:1',
    ]);
  });
});

describe('🔴 a failing shadow never touches the served answer', () => {
  const served = () => ({ items: [R1, R2], nextCursor: null });

  it('every failure is an outcome; the promise resolves and the served answer is unchanged', async () => {
    const shadow = makeShadow();
    const failures: (() => Promise<Response> | Response)[] = [
      () => Promise.reject(new Error('connect ECONNREFUSED')),
      () => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError')),
      () => new Response('{"error":"busy"}', { status: 503 }),
      () => new Response('{"error":"moved"}', { status: 307, headers: { location: '/x' } }),
      () => new Response('not json', { status: 200 }),
      () => Response.json({ source: 'registry' }),
      // An app-data-go that did not honour registry-only read the site again.
      () => Response.json({ source: 'rest', items: [{ key: 'k', rev: '1', data: R1.data }] }),
      () => {
        throw new Error('synchronous fetch failure');
      },
    ];
    for (const f of failures) {
      reply = f;
      const list = input({ served: served() });
      await expect(shadow.shadow(list)).resolves.toBeUndefined();
      expect(list.served).toEqual(served());
    }
    expect(shadow.inFlight()).toBe(0);
    expect(await moved()).toEqual([
      'requests_total{bad_response}:3',
      'requests_total{error}:4',
      'requests_total{timeout}:1',
    ]);
  });

  it('a throwing config or flag never escapes', async () => {
    const throwing = createAppDataShadow({
      enabled: async () => {
        throw new Error('flipt down');
      },
      config: () => config,
      random: () => 0,
      fetch: async () => registryAnswer([R1])(),
      major: async () => 1,
      log: () => undefined,
    });
    await expect(throwing.shadow(input())).resolves.toBeUndefined();
    const badConfig = createAppDataShadow({
      enabled: async () => true,
      config: () => {
        throw new Error('env unreadable');
      },
      random: () => 0,
      fetch: async () => registryAnswer([R1])(),
      major: async () => 1,
      log: () => undefined,
    });
    expect(badConfig.shadow(input())).toBeUndefined();
    expect(throwing.inFlight()).toBe(0);
  });

  it('bounded concurrency: over the cap a list is counted `saturated` and not asked', async () => {
    config.maxInFlight = 1;
    let release: (r: Response) => void = () => undefined;
    reply = () => new Promise<Response>((resolve) => (release = resolve));
    const shadow = makeShadow();
    const first = shadow.shadow(input());
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toHaveLength(1);
    expect(shadow.shadow(input())).toBeUndefined();
    expect(calls).toHaveLength(1);
    release(registryAnswer([R1, R2])());
    await first;
    expect(shadow.inFlight()).toBe(0);
    reply = registryAnswer([R1, R2]);
    await shadow.shadow(input());
    expect(calls).toHaveLength(2);
    expect(await moved()).toEqual([
      'compared_records_total{}:4',
      'compared_total{match}:2',
      'requests_total{compared}:2',
      'requests_total{saturated}:1',
    ]);
  });
});
