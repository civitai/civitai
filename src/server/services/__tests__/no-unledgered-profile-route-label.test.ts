import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { countAll, productionSources, unwrap, walk } from './source-ratchet.harness';

/**
 * Which requests carry a Pyroscope `route` label is decided by where `withProfileRoute` is called,
 * so its call sites are a ledger, per file and per call in the syntax tree (comments are not in
 * it): this fails when a call is added or one disappears. Update the ledger with the change.
 */

const files = productionSources(['src/**/*.{ts,tsx}'], ['src/server/pyroscope-labels.ts']);

const calls = () =>
  countAll(files, 'withProfileRoute', (sf) => {
    let count = 0;
    walk(sf, (node) => {
      if (!ts.isCallExpression(node)) return;
      const callee = unwrap(node.expression);
      if (ts.isIdentifier(callee) && callee.text === 'withProfileRoute') count++;
    });
    return count;
  });

describe('no-unledgered-profile-route-label', () => {
  it('scans the source tree', () => {
    expect(files.length).toBeGreaterThan(1000);
  });

  it('calls withProfileRoute only from the ledgered request wrappers', () => {
    expect(calls()).toEqual({
      'src/pages/api/trpc/[trpc].ts': 1, // whole tRPC request
      'src/server/trpc.ts': 2, // each procedure, and a batch result's serialize
      'src/server/utils/endpoint-helpers.ts': 1, // pages API via withApiMetrics
    });
  });
});
