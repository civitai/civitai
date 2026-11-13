import client from 'prom-client';
import { TRPCError } from '@trpc/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import {
  SHARED_STORAGE_OPS,
  SHARED_STORAGE_REACHABLE_OUTCOMES,
  SHARED_STORAGE_REACHABLE_SERIES,
  seedAppBlockSharedStorageMetrics,
  sharedStorageOutcomeOf,
  tagSharedStorageOutcome,
  withSharedStorageMetrics,
} from '../app-block-shared-storage.metrics';

/**
 * Zero-seeding, outcome classification and the recording wrapper for the App Blocks SHARED
 * storage metrics, against the REAL prom-client default registry (`src/__tests__/setup.ts`
 * replaces only `~/server/prom/client`). Never `client.register.clear()` here: the metrics are
 * built once at package module scope, and clearing drops them for the rest of the file.
 */

const OPS = 'civitai_app_block_shared_storage_ops_total';
const LATENCY = 'civitai_app_block_shared_storage_latency_seconds';

type Values = Array<{ labels: Record<string, string>; value: number; metricName?: string }>;

async function valuesOf(name: string): Promise<Values> {
  const metric = client.register.getSingleMetric(name) as
    | { get(): Promise<{ values: Values }> | { values: Values } }
    | undefined;
  if (!metric) return [];
  const { values } = await metric.get();
  return values;
}

async function latencyCount(op: string): Promise<number> {
  return (
    (await valuesOf(LATENCY)).find(
      (v) => (v.metricName ?? '').endsWith('_count') && v.labels.op === op
    )?.value ?? 0
  );
}

async function opsValue(op: string, outcome: string): Promise<number> {
  return (
    (await valuesOf(OPS)).find((v) => v.labels.op === op && v.labels.outcome === outcome)?.value ??
    0
  );
}

beforeAll(async () => {
  await seedAppBlockSharedStorageMetrics();
});

describe('seedAppBlockSharedStorageMetrics', () => {
  it('publishes every reachable (op, outcome) pair at 0, and no other', async () => {
    const values = await valuesOf(OPS);
    expect(values.map((v) => `${v.labels.op}/${v.labels.outcome}`).sort()).toEqual(
      SHARED_STORAGE_REACHABLE_SERIES.map((s) => `${s.op}/${s.outcome}`).sort()
    );
    for (const v of values) expect(v.value).toBe(0);
  });

  it('🔴 publishes 230 series per scraped pod — 76 of them (op, outcome) pairs', async () => {
    // Literal, because a cardinality budget is sized against this figure.
    expect(SHARED_STORAGE_REACHABLE_SERIES.length).toBe(76);
    expect((await valuesOf(OPS)).length + (await valuesOf(LATENCY)).length).toBe(230);
  });

  it('publishes one zeroed latency child per op', async () => {
    const counts = (await valuesOf(LATENCY)).filter((v) => (v.metricName ?? '').endsWith('_count'));
    expect(counts.map((v) => v.labels.op).sort()).toEqual([...SHARED_STORAGE_OPS].sort());
    for (const v of counts) expect(v.value).toBe(0);
  });

  it('every op can report ok, a token refusal, a disabled flag and an error', () => {
    for (const op of SHARED_STORAGE_OPS) {
      expect(SHARED_STORAGE_REACHABLE_OUTCOMES[op], op).toEqual(
        expect.arrayContaining(['ok', 'unauthorized', 'disabled', 'error'])
      );
    }
  });

  it('appears in the scrape output under the names an operator queries', async () => {
    const scrape = await client.register.metrics();
    expect(scrape).toContain(`${OPS}{op="append",outcome="moderation_blocked"} 0`);
    expect(scrape).toContain(`${OPS}{op="increment",outcome="rate_limited"} 0`);
    expect(scrape).toContain(`${LATENCY}_count{op="getTop"} 0`);
  });
});

describe('recording', () => {
  it('re-seeding keeps a recorded latency observation and counter value', async () => {
    const latencyBefore = await latencyCount('vote');
    const okBefore = await opsValue('vote', 'ok');
    await withSharedStorageMetrics('vote', async () => 'done');
    expect(await latencyCount('vote')).toBe(latencyBefore + 1);
    expect(await opsValue('vote', 'ok')).toBe(okBefore + 1);

    await seedAppBlockSharedStorageMetrics();

    expect(await latencyCount('vote')).toBe(latencyBefore + 1);
    expect(await opsValue('vote', 'ok')).toBe(okBefore + 1);
  });

  it('a rejected call records its outcome once and rethrows the same error', async () => {
    const before = await opsValue('report', 'not_found');
    const latencyBefore = await latencyCount('report');
    const failure = new TRPCError({ code: 'NOT_FOUND', message: 'request not found' });

    await expect(
      withSharedStorageMetrics('report', async () => {
        throw failure;
      })
    ).rejects.toBe(failure);

    expect(await opsValue('report', 'not_found')).toBe(before + 1);
    expect(await latencyCount('report')).toBe(latencyBefore + 1);
  });

  it('🔴 observes the elapsed time in SECONDS, measured around the call', async () => {
    // 1.75 s between the two clock reads. Not a bucket boundary, so a value scaled by any power
    // of ten, or a clock read after the call (0 s), lands somewhere else.
    async function sumAndBucket(op: string) {
      const values = await valuesOf(LATENCY);
      const of = (suffix: string, le?: string) =>
        values.find(
          (v) =>
            (v.metricName ?? '').endsWith(suffix) &&
            v.labels.op === op &&
            (le === undefined || String(v.labels.le) === le)
        )?.value ?? 0;
      return { sum: of('_sum'), le1: of('_bucket', '1'), le2_5: of('_bucket', '2.5') };
    }
    const before = await sumAndBucket('withdraw');
    const clock = vi
      .spyOn(process.hrtime, 'bigint')
      .mockReturnValueOnce(BigInt(1_000_000_000))
      .mockReturnValueOnce(BigInt(2_750_000_000));
    try {
      await withSharedStorageMetrics('withdraw', async () => 'done');
    } finally {
      clock.mockRestore();
    }
    const after = await sumAndBucket('withdraw');
    expect(after.sum - before.sum).toBeCloseTo(1.75, 9);
    expect(after.le1 - before.le1).toBe(0);
    expect(after.le2_5 - before.le2_5).toBe(1);
  });

  it('a failing latency read costs the seed, never the scrape', async () => {
    const handle = client.register.getSingleMetric(LATENCY) as unknown as {
      get: () => Promise<unknown>;
    };
    const spy = vi.spyOn(handle, 'get').mockRejectedValue(new Error('registry read failed'));
    try {
      await expect(seedAppBlockSharedStorageMetrics()).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('sharedStorageOutcomeOf', () => {
  it('a tag wins over the tRPC code', () => {
    const forbidden = new TRPCError({ code: 'FORBIDDEN', message: 'x' });
    expect(sharedStorageOutcomeOf(forbidden)).toBe('forbidden');
    expect(sharedStorageOutcomeOf(tagSharedStorageOutcome(forbidden, 'trust_refused'))).toBe(
      'trust_refused'
    );
  });

  it('tagging returns the same object and adds nothing to it', () => {
    const err = new TRPCError({ code: 'BAD_REQUEST', message: 'x' });
    const keysBefore = Reflect.ownKeys(err);
    expect(tagSharedStorageOutcome(err, 'moderation_blocked')).toBe(err);
    expect(Reflect.ownKeys(err)).toEqual(keysBefore);
  });

  it.each([
    ['UNAUTHORIZED', 'unauthorized'],
    ['FORBIDDEN', 'forbidden'],
    ['TOO_MANY_REQUESTS', 'rate_limited'],
    ['PAYLOAD_TOO_LARGE', 'payload_too_large'],
    ['BAD_REQUEST', 'bad_request'],
    ['NOT_FOUND', 'not_found'],
    ['INTERNAL_SERVER_ERROR', 'error'],
    ['SERVICE_UNAVAILABLE', 'error'],
  ] as const)('untagged %s is %s', (code, outcome) => {
    expect(sharedStorageOutcomeOf(new TRPCError({ code, message: 'x' }))).toBe(outcome);
  });

  it('anything that is not a TRPCError is an error', () => {
    expect(sharedStorageOutcomeOf(new Error('pg down'))).toBe('error');
    expect(sharedStorageOutcomeOf('thrown string')).toBe('error');
    expect(sharedStorageOutcomeOf(undefined)).toBe('error');
  });
});
