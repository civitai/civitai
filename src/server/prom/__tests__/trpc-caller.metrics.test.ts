import { instrumentationRegistry } from '@civitai/telemetry/client';
import type client from 'prom-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The recording is switched on by TRPC_CALLER_METRICS, read when the module loads.
vi.hoisted(() => {
  process.env.TRPC_CALLER_METRICS = 'true';
});

import {
  recordTrpcCaller,
  safeClassifyTrpcCaller,
  TRPC_CALLER_CLASSES,
  TRPC_CALLER_SECONDS_METRIC,
} from '~/server/prom/trpc-caller.metrics';

type Row = { value: number; labels: Record<string, string> };

async function rows(name: string): Promise<Row[]> {
  const metric = instrumentationRegistry.getSingleMetric(name) as
    | client.Counter<string>
    | undefined;
  return metric ? ((await metric.get()).values as Row[]) : [];
}

describe('classifyTrpcCaller', () => {
  it('no input ever produces a value outside the five classes', () => {
    const allowed = new Set<string>(TRPC_CALLER_CLASSES);
    const inputs: unknown[] = [
      {},
      { cache: undefined },
      { cache: null },
      { userAgent: 42 },
      { userAgent: { toString: () => 'curl' } },
      { userAgent: [] },
      { apiKeyId: 0 },
      { user: 0, userAgent: 'x' },
      { userAgent: 'internal' },
      { userAgent: 'session' },
      { userAgent: '\u0000￿' },
    ];
    for (const input of inputs) {
      const out = safeClassifyTrpcCaller(input as never);
      expect(allowed.has(out), JSON.stringify(input)).toBe(true);
    }
    // A context whose getters throw cannot throw into the request path.
    const hostile = Object.defineProperty({}, 'cache', {
      get() {
        throw new Error('boom');
      },
    });
    expect(safeClassifyTrpcCaller(hostile as never)).toBe('anon_tool_ua');
  });
});

describe('recordTrpcCaller', () => {
  beforeEach(async () => {
    for (const name of [TRPC_CALLER_SECONDS_METRIC]) {
      const metric = instrumentationRegistry.getSingleMetric(name) as client.Counter | undefined;
      await metric?.get(); // fold any pending calls in, then clear them
      metric?.reset();
    }
  });

  it('a negative or non-finite duration adds nothing to its pair', async () => {
    recordTrpcCaller('a.b', 'session', -1);
    recordTrpcCaller('a.b', 'session', Number.NaN);
    recordTrpcCaller('a.b', 'session', Number.POSITIVE_INFINITY);
    recordTrpcCaller('a.b', 'session', 0.5);
    expect(await rows(TRPC_CALLER_SECONDS_METRIC)).toEqual([
      { value: 0.5, labels: { path: 'a.b', caller: 'session' } },
    ]);
  });

  it('a second scrape adds only the seconds recorded since the first', async () => {
    recordTrpcCaller('a.b', 'anon_tool_ua', 0.5);
    expect(await rows(TRPC_CALLER_SECONDS_METRIC)).toEqual([
      { value: 0.5, labels: { path: 'a.b', caller: 'anon_tool_ua' } },
    ]);
    expect(await rows(TRPC_CALLER_SECONDS_METRIC)).toEqual([
      { value: 0.5, labels: { path: 'a.b', caller: 'anon_tool_ua' } },
    ]);
    recordTrpcCaller('a.b', 'anon_tool_ua', 0.25);
    expect(await rows(TRPC_CALLER_SECONDS_METRIC)).toEqual([
      { value: 0.75, labels: { path: 'a.b', caller: 'anon_tool_ua' } },
    ]);
  });
});
