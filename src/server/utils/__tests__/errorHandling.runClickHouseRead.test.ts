import { TRPCError } from '@trpc/server';
import { describe, it, expect, vi } from 'vitest';
import { runClickHouseRead } from '~/server/utils/errorHandling';

// Regression for the recurring "transient ClickHouse read → raw 500" class.
//
// 2026-07-11: /api/trpc/buzz.getDailyBuzzCompensation 500'd (~1.2/h) on a transient
// ClickHouse connection blip — its `clickhouse.$query` SELECT against
// orchestration.resourceCompensations threw `Error('ClickHouse query failed: socket
// hang up')`, which bubbled up un-try-caught and tRPC wrapped as
// INTERNAL_SERVER_ERROR (500). Same class #3064 fixed for the New Order counters.
//
// runClickHouseRead is the reusable form of that guard: getDailyCompensationRewardByUser
// wraps its CH read in it, so this suite pins the exact behavior that endpoint relies on
// (importing the real buzz.service in a unit test is impractical — its module graph drags
// in the whole search-index/event-engine chain, which is why every sibling suite mocks it).
//
// Contract:
//   - a TRANSIENT connection/transport error (socket hang up, syscall reset, CH transient
//     Code 279/210/209/202) → TRPCError SERVICE_UNAVAILABLE (503), original preserved as cause;
//   - a REAL query/schema fault (non-connection CH error, e.g. Code: 62 syntax) → rethrown
//     UNCHANGED so it still surfaces (and alerts) as a 500;
//   - a successful read passes its value straight through.

describe('runClickHouseRead — transient ClickHouse error → 503 (SERVICE_UNAVAILABLE)', () => {
  it('passes the value through on success (no wrapping)', async () => {
    const rows = [{ id: 1 }];
    await expect(runClickHouseRead(async () => rows)).resolves.toBe(rows);
  });

  it('maps a `socket hang up` read failure to a TRPCError SERVICE_UNAVAILABLE', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('ClickHouse query failed: socket hang up'));
    await expect(runClickHouseRead(fn)).rejects.toSatisfy(
      (e: unknown) => e instanceof TRPCError && e.code === 'SERVICE_UNAVAILABLE'
    );
  });

  it('maps a transient CH capacity brownout (Code: 202) to SERVICE_UNAVAILABLE', async () => {
    const fn = vi
      .fn()
      .mockRejectedValue(
        new Error('ClickHouse query failed: Code: 202. DB::Exception: Too many simultaneous queries')
      );
    await expect(runClickHouseRead(fn)).rejects.toSatisfy(
      (e: unknown) => e instanceof TRPCError && e.code === 'SERVICE_UNAVAILABLE'
    );
  });

  it('maps a raw socket syscall (ECONNRESET) to SERVICE_UNAVAILABLE', async () => {
    const err = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    await expect(runClickHouseRead(async () => Promise.reject(err))).rejects.toSatisfy(
      (e: unknown) => e instanceof TRPCError && e.code === 'SERVICE_UNAVAILABLE'
    );
  });

  it('uses the caller-supplied message and preserves the original error as cause', async () => {
    const original = new Error('ClickHouse query failed: socket hang up');
    const err = await runClickHouseRead(
      () => Promise.reject(original),
      'Daily Buzz compensation is temporarily unavailable, please retry.'
    ).catch((e) => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe('SERVICE_UNAVAILABLE');
    expect((err as TRPCError).message).toBe(
      'Daily Buzz compensation is temporarily unavailable, please retry.'
    );
    expect((err as TRPCError).cause).toBe(original);
  });

  it('does NOT convert a real (non-connection) CH error — a syntax fault surfaces raw', async () => {
    // Code: 62 = syntax error — a genuine query/schema bug, NOT a transient blip. It must
    // NOT be masked as a 503 (so a schema break / bad SELECT still 500s + alerts).
    const original = new Error('ClickHouse query failed: Code: 62. DB::Exception: Syntax error');
    const err = await runClickHouseRead(() => Promise.reject(original)).catch((e) => e);
    expect(err).toBe(original);
    expect(err instanceof TRPCError).toBe(false);
  });

  it('does NOT convert an arbitrary application error (e.g. undefined access) — surfaces raw', async () => {
    const original = new TypeError("Cannot read properties of undefined (reading 'x')");
    const err = await runClickHouseRead(() => Promise.reject(original)).catch((e) => e);
    expect(err).toBe(original);
    expect(err instanceof TRPCError).toBe(false);
  });
});
