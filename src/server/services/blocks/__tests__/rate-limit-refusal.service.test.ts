import client from 'prom-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import {
  LOG_THROTTLE_WINDOW_MS,
  recordAppBlockRateLimitRefusal,
  recordBlockClaimsRateLimitRefusal,
  recordBridgeRateLimitRefusal,
  resetRateLimitRefusalLogThrottleForTests,
} from '../rate-limit-refusal.service';

/**
 * The ONE recorder every App Blocks limiter calls, against the real prom-client registry and the
 * shared logging mock. The per-surface suites prove each limiter REACHES it; this proves what it
 * emits: the series name and its exact label set, the clamp, the dev bucketing, the log line and
 * its throttle, and that it never throws.
 */

const METRIC = 'civitai_app_block_rate_limit_refusals_total';
const RETIRED_BRIDGE_METRIC = 'civitai_app_block_bridge_rate_limit_refusals_total';

type Series = { labels: Record<string, string>; value: number };
async function values(name: string): Promise<Series[]> {
  const metric = client.register.getSingleMetric(name) as
    | { get(): Promise<{ values: Series[] }> }
    | undefined;
  return metric ? (await metric.get()).values : [];
}
async function value(name: string, labels: Record<string, string>): Promise<number> {
  const found = (await values(name)).find((v) =>
    Object.entries(labels).every(([k, want]) => v.labels[k] === want)
  );
  return found?.value ?? 0;
}
function lines() {
  return loggingMock.logToAxiom.mock.calls
    .map(([data]) => data as Record<string, unknown>)
    .filter((d) => d.name === 'app-blocks-rate-limit-refusal');
}

const BASE = {
  appBlockId: 'apb_recorder_fixture',
  surface: 'doc_store' as const,
  bucket: 'write' as const,
  endpoint: 'storage_write',
  retryAfterSeconds: 41,
  userId: 9031,
  status: 429,
};

let now = Date.parse('2031-03-04T05:06:07.000Z');

beforeEach(() => {
  client.register.clear();
  resetRateLimitRefusalLogThrottleForTests();
  loggingMock.logToAxiom.mockClear();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe(METRIC, () => {
  it('one call is one increment, under exactly {app_block_id, surface, bucket}', async () => {
    recordAppBlockRateLimitRefusal(BASE);

    const all = await values(METRIC);
    expect(all).toEqual([
      {
        labels: { app_block_id: 'apb_recorder_fixture', surface: 'doc_store', bucket: 'write' },
        value: 1,
      },
    ]);
  });

  it('keeps apps, surfaces and buckets apart', async () => {
    recordAppBlockRateLimitRefusal(BASE);
    recordAppBlockRateLimitRefusal({ ...BASE, appBlockId: 'apb_other_fixture' });
    recordAppBlockRateLimitRefusal({ ...BASE, bucket: 'read' });
    recordAppBlockRateLimitRefusal({ ...BASE, surface: 'sub_listings' });

    expect(
      await value(METRIC, {
        app_block_id: 'apb_recorder_fixture',
        bucket: 'write',
        surface: 'doc_store',
      })
    ).toBe(1);
    expect(await value(METRIC, { app_block_id: 'apb_other_fixture', bucket: 'write' })).toBe(1);
    expect(await value(METRIC, { app_block_id: 'apb_recorder_fixture', bucket: 'read' })).toBe(1);
    expect(await value(METRIC, { surface: 'sub_listings' })).toBe(1);
  });

  it('CLAMPS a surface or bucket outside the closed sets to "other"', async () => {
    recordAppBlockRateLimitRefusal({
      ...BASE,
      bucket: 'made-up' as never,
      surface: 'nope' as never,
    });
    expect(await values(METRIC)).toEqual([
      {
        labels: { app_block_id: 'apb_recorder_fixture', surface: 'other', bucket: 'other' },
        value: 1,
      },
    ]);
  });

  it('NEVER THROWS — a metrics or logging fault must not change the refusal', () => {
    client.register.clear();
    new client.Gauge({ name: METRIC, help: 'collides on purpose' });
    loggingMock.logToAxiom.mockImplementationOnce(() => {
      throw new Error('log sink down');
    });
    expect(() => recordAppBlockRateLimitRefusal(BASE)).not.toThrow();
  });
});

describe('the log line', () => {
  it('names app, surface, bucket, endpoint, status, retryAfter and the viewer', () => {
    recordAppBlockRateLimitRefusal(BASE);
    expect(lines()).toEqual([
      {
        name: 'app-blocks-rate-limit-refusal',
        type: 'info',
        appBlockId: 'apb_recorder_fixture',
        surface: 'doc_store',
        bucket: 'write',
        endpoint: 'storage_write',
        status: 429,
        retryAfter: 41,
        userId: 9031,
        suppressed: 0,
      },
    ]);
  });

  it('is THROTTLED per (app, surface, bucket, viewer): one line per window, the rest counted', async () => {
    for (let i = 0; i < 5; i++) recordAppBlockRateLimitRefusal(BASE);
    // The metric is never throttled.
    expect(await value(METRIC, { bucket: 'write' })).toBe(5);
    expect(lines()).toHaveLength(1);

    now += LOG_THROTTLE_WINDOW_MS - 1;
    recordAppBlockRateLimitRefusal(BASE);
    expect(lines()).toHaveLength(1);

    now += 1;
    recordAppBlockRateLimitRefusal(BASE);
    expect(lines()).toHaveLength(2);
    // The five refusals the throttle held back since the first line.
    expect(lines()[1].suppressed).toBe(5);
  });

  it('a different viewer, bucket or app is its own key', () => {
    recordAppBlockRateLimitRefusal(BASE);
    recordAppBlockRateLimitRefusal({ ...BASE, userId: 9032 });
    recordAppBlockRateLimitRefusal({ ...BASE, bucket: 'read' });
    recordAppBlockRateLimitRefusal({ ...BASE, appBlockId: 'apb_other_fixture' });
    recordAppBlockRateLimitRefusal({ ...BASE, userId: null });
    expect(lines()).toHaveLength(5);
  });
});

describe('a document-store version conflict', () => {
  it('is a {doc_store, version_conflict} refusal with a 409 log line', async () => {
    recordAppBlockRateLimitRefusal({
      ...BASE,
      bucket: 'version_conflict',
      status: 409,
      retryAfterSeconds: undefined,
    });
    expect(await values(METRIC)).toEqual([
      {
        labels: {
          app_block_id: 'apb_recorder_fixture',
          surface: 'doc_store',
          bucket: 'version_conflict',
        },
        value: 1,
      },
    ]);
    expect(lines()[0]).toMatchObject({ bucket: 'version_conflict', status: 409, retryAfter: null });
  });
});

describe('recordBlockClaimsRateLimitRefusal', () => {
  it('labels a dev token "dev" and reads the viewer from the verified subject', async () => {
    recordBlockClaimsRateLimitRefusal({
      claims: { dev: true, appBlockId: 'apb_synthetic_dev', sub: 'user:7714' },
      surface: 'rest',
      bucket: 'catalog',
      endpoint: 'models',
      retryAfterSeconds: 9,
    });
    expect(await values(METRIC)).toEqual([
      { labels: { app_block_id: 'dev', surface: 'rest', bucket: 'catalog' }, value: 1 },
    ]);
    expect(lines()[0]).toMatchObject({ appBlockId: 'dev', userId: 7714, status: 429 });
  });

  it('an anonymous subject is a null viewer', () => {
    recordBlockClaimsRateLimitRefusal({
      claims: { appBlockId: 'apb_recorder_fixture', sub: 'anon' },
      surface: 'rest',
      bucket: 'catalog',
      endpoint: 'images',
    });
    expect(lines()[0]).toMatchObject({ userId: null, retryAfter: null });
  });
});

describe('recordBridgeRateLimitRefusal', () => {
  it('moves the per-app counter only; the procedure-only bridge counter is retired', async () => {
    recordBridgeRateLimitRefusal(
      'queryAppWorkflows',
      'catalog',
      { appBlockId: 'apb_recorder_fixture', sub: 'user:9031' },
      5
    );
    expect(client.register.getSingleMetric(RETIRED_BRIDGE_METRIC)).toBeUndefined();
    expect(
      await value(METRIC, {
        app_block_id: 'apb_recorder_fixture',
        surface: 'bridge',
        bucket: 'catalog',
      })
    ).toBe(1);
  });

  it('carries the status a returning path answered (200 for a shed poll)', () => {
    recordBridgeRateLimitRefusal(
      'pollWorkflow',
      'poll',
      { appBlockId: 'apb_recorder_fixture', sub: 'user:9031' },
      2,
      200
    );
    expect(lines()[0]).toMatchObject({ endpoint: 'pollWorkflow', bucket: 'poll', status: 200 });
  });
});
