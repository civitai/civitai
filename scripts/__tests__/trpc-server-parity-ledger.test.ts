import { describe, expect, it } from 'vitest';
import { middlewares } from '~/server/middleware';
import type { Middleware } from '~/server/middleware/middleware-utils';
import { nextBehaviourLedger, proxyMiddlewareLedger } from '../trpc-server/parity-ledger.mjs';

/**
 * The standalone tRPC server's parity ledger must name every middleware in the proxy chain, in
 * order. Adding, removing or reordering one in `src/server/middleware/index.ts` turns this red until
 * the ledger says what the new chain does to a tRPC call (and so whether the fast path still serves
 * it identically).
 */

const modules = import.meta.glob<Record<string, unknown>>('../../src/server/middleware/*.ts', {
  eager: true,
});

function exportNameOf(middleware: Middleware): string {
  for (const mod of Object.values(modules)) {
    for (const [name, value] of Object.entries(mod)) if (value === middleware) return name;
  }
  return '<a middleware exported from no src/server/middleware/*.ts module>';
}

describe('standalone tRPC server parity ledger', () => {
  it('lists exactly the proxy chain, in order', () => {
    expect(middlewares.map(exportNameOf)).toEqual(Object.keys(proxyMiddlewareLedger));
  });

  it('gives every entry a reason', () => {
    const entries = [...Object.values(proxyMiddlewareLedger), ...nextBehaviourLedger];
    for (const entry of entries) {
      expect(['same-code', 'replicated', 'checked', 'not-applicable']).toContain(entry.how);
      expect(entry.why.trim()).not.toBe('');
    }
  });
});
