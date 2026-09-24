import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { clickhouseFailSoftCounter } from '~/server/prom/client';
import { runClickHouseRead } from '~/server/utils/errorHandling';

const inc = vi.mocked(clickhouseFailSoftCounter.inc);
const logToAxiom = vi.mocked(loggingMock.logToAxiom);

describe('runClickHouseRead — clickhouseFailSoftCounter', () => {
  beforeEach(() => {
    inc.mockClear();
    logToAxiom.mockClear();
  });

  it('counts a `socket hang up` under the caller-supplied path', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('ClickHouse query failed: socket hang up'));
    await expect(runClickHouseRead(fn, { path: 'buzz-compensation' })).rejects.toThrow();
    expect(inc).toHaveBeenCalledTimes(1);
    expect(inc).toHaveBeenCalledWith({ path: 'buzz-compensation' });
  });

  it('counts a raw syscall reset under the caller-supplied path', async () => {
    const err = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    await expect(
      runClickHouseRead(() => Promise.reject(err), { path: 'new-order-ratings' })
    ).rejects.toThrow();
    expect(inc).toHaveBeenCalledTimes(1);
    expect(inc).toHaveBeenCalledWith({ path: 'new-order-ratings' });
  });

  it('does NOT count a syntax fault (Code: 62)', async () => {
    const original = new Error('ClickHouse query failed: Code: 62. DB::Exception: Syntax error');
    const err = await runClickHouseRead(() => Promise.reject(original), {
      path: 'buzz-compensation',
    }).catch((e) => e);
    expect(err).toBe(original);
    expect(inc).not.toHaveBeenCalled();
  });

  it('does NOT count an UNKNOWN_TABLE fault (Code: 60)', async () => {
    const original = new Error(
      'ClickHouse query failed: Code: 60. DB::Exception: Table orchestration.resourceCompensations does not exist'
    );
    const err = await runClickHouseRead(() => Promise.reject(original), {
      path: 'model-version-generations',
    }).catch((e) => e);
    expect(err).toBe(original);
    expect(inc).not.toHaveBeenCalled();
  });

  it('does NOT count a successful read', async () => {
    const rows = [{ id: 1 }];
    await expect(runClickHouseRead(async () => rows, { path: 'buzz-compensation' })).resolves.toBe(
      rows
    );
    expect(inc).not.toHaveBeenCalled();
  });
});

// Without this log line a transient ClickHouse read degrades silently — the 503 is one the
// central tRPC handler deliberately does not ingest. See runClickHouseRead's JSDoc.
describe('runClickHouseRead — Axiom fail-soft log line', () => {
  beforeEach(() => {
    inc.mockClear();
    logToAxiom.mockClear();
  });

  it('logs the failing message and path to the clickhouse datastream on a transient error', async () => {
    const original = new Error(
      'ClickHouse query failed: socket hang up\nQuery: SELECT 1 FROM orchestration.resourceCompensations'
    );
    await expect(
      runClickHouseRead(() => Promise.reject(original), { path: 'buzz-compensation' })
    ).rejects.toThrow();

    expect(logToAxiom).toHaveBeenCalledTimes(1);
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'warning',
        name: 'clickhouse-failsoft',
        path: 'buzz-compensation',
        // The ORIGINAL message, which for a $query read embeds the SQL — the whole point
        // of the line. Logging the 503's own text instead would lose the query.
        error:
          'ClickHouse query failed: socket hang up\nQuery: SELECT 1 FROM orchestration.resourceCompensations',
      }),
      'clickhouse'
    );
  });

  it('does NOT log a query/schema fault (that one still 500s and is ingested normally)', async () => {
    const original = new Error('ClickHouse query failed: Code: 62. DB::Exception: Syntax error');
    const err = await runClickHouseRead(() => Promise.reject(original), {
      path: 'buzz-compensation',
    }).catch((e) => e);
    expect(err).toBe(original);
    expect(logToAxiom).not.toHaveBeenCalled();
  });

  it('does NOT log a successful read', async () => {
    await expect(runClickHouseRead(async () => [], { path: 'buzz-compensation' })).resolves.toEqual(
      []
    );
    expect(logToAxiom).not.toHaveBeenCalled();
  });

  it('still throws the 503 — unchanged — when the log line rejects', async () => {
    logToAxiom.mockRejectedValueOnce(new Error('axiom ingest unreachable'));
    const original = new Error('ClickHouse query failed: socket hang up');
    const thrown = await runClickHouseRead(() => Promise.reject(original), {
      path: 'buzz-compensation',
    }).catch((e) => e);

    expect(thrown).toBeInstanceOf(TRPCError);
    expect((thrown as TRPCError).code).toBe('SERVICE_UNAVAILABLE');
    expect((thrown as TRPCError).cause).toBe(original);
  });

  // The rejection handler must take an ARGUMENT. A bare `.catch()` reads as fire-and-forget
  // but installs no handler at all: the rejection passes straight through and surfaces as an
  // unhandledRejection, which on the `jobs` pods is fatal (see the 2026-08-23 Axiom outage
  // note in @civitai/axiom's client).
  it('does not leak an unhandled rejection when the log line rejects', async () => {
    logToAxiom.mockRejectedValueOnce(new Error('axiom ingest unreachable'));
    const leaked: unknown[] = [];
    const onUnhandled = (reason: unknown) => leaked.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      await runClickHouseRead(() => Promise.reject(new Error('socket hang up')), {
        path: 'buzz-compensation',
      }).catch(() => undefined);
      // unhandledRejection is emitted after the microtask queue drains, so give the loop
      // two macrotask turns before reading the result.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(leaked).toEqual([]);
  });
});
