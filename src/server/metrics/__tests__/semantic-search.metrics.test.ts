import { describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { Registry } from 'prom-client';

vi.mock('~/server/trpc', () => ({ middleware: (fn: unknown) => fn }));

import { timeSemanticSearch } from '~/server/metrics/semantic-search.metrics';

type Next = () => Promise<{ ok: true } | { ok: false; error: TRPCError }>;

async function run(reg: Registry, next: Next) {
  const mw = timeSemanticSearch('images', reg) as unknown as (opts: {
    next: Next;
  }) => Promise<unknown>;
  return mw({ next });
}

async function countFor(reg: Registry, status: string) {
  const text = await reg.getSingleMetricAsString('semantic_search_request_seconds');
  const line = text
    .split('\n')
    .find((l) =>
      l.startsWith(`semantic_search_request_seconds_count{index="images",status="${status}"}`)
    );
  return line ? Number(line.split(' ').pop()) : 0;
}

describe('timeSemanticSearch', () => {
  it('records a success under status ok', async () => {
    const reg = new Registry();
    await run(reg, async () => ({ ok: true }));
    expect(await countFor(reg, 'ok')).toBe(1);
  });

  it('records a refusal under its tRPC code, so rate limits and gateway errors show on the dashboard', async () => {
    const reg = new Registry();
    await run(reg, async () => ({
      ok: false,
      error: new TRPCError({ code: 'TOO_MANY_REQUESTS' }),
    }));
    await run(reg, async () => ({ ok: false, error: new TRPCError({ code: 'BAD_GATEWAY' }) }));
    expect(await countFor(reg, 'TOO_MANY_REQUESTS')).toBe(1);
    expect(await countFor(reg, 'BAD_GATEWAY')).toBe(1);
    expect(await countFor(reg, 'ok')).toBe(0);
  });
});
