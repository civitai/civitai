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
});

// Without this log line a transient ClickHouse read degrades silently — the 503 is one the
// central tRPC handler deliberately does not ingest. See runClickHouseRead's JSDoc.
describe('runClickHouseRead — Axiom fail-soft log line', () => {
  beforeEach(() => {
    inc.mockClear();
    logToAxiom.mockClear();
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
