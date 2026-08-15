import { hybridNode, registerDefaults, type HybridNode } from './hybrid';

/**
 * Canonical mock for `~/server/logging/client`.
 *
 * Unlike db/redis this module is mostly PURE — `classifyErrorFault`,
 * `buildCentralErrorLog`, `wasServerFaultLogged` are real logic that code under test
 * legitimately runs. Only `logToAxiom` has an I/O side effect a test must not perform, so
 * the registration in setup.ts spreads the original and overrides that one export.
 *
 * What this module contributes is a STABLE `logToAxiom` identity plus reset, which the
 * previous inline `vi.fn()` in the setup factory did not have: under `isolate: false` the
 * factory runs once per worker, so its spy accumulated calls across every file that
 * shared the worker. That is the `expected "X" to be called 2 times` failure class.
 *
 *   import { loggingMock } from '~/__tests__/mocks/logging.mock';
 *   expect(loggingMock.logToAxiom).toHaveBeenCalledWith(expect.objectContaining({ … }));
 */

registerDefaults((path) =>
  path === 'logToAxiom' ? () => Promise.resolve(undefined) : undefined
);

export const loggingMock: { logToAxiom: HybridNode } = {
  logToAxiom: hybridNode('logToAxiom'),
};
