import { describe, it, expect } from 'vitest';
import {
  ORCHESTRATOR_GATEWAY_PROCEDURES,
  shouldRouteToGateway,
} from '~/utils/orchestrator-gateway-routing';

const GATEWAY = 'https://orchestrator-gateway.civitai.com/api/trpc';

describe('shouldRouteToGateway — DARK no-op guarantee (empty allowlist)', () => {
  it('the shipped allowlist is EMPTY (the hard dark guarantee)', () => {
    expect(ORCHESTRATOR_GATEWAY_PROCEDURES).toEqual([]);
  });

  it('routes NOTHING to the gateway with the real (empty) allowlist, even when flag on + URL set', () => {
    // Sample of real orchestrator.* procedure paths — none should route while the
    // module allowlist is empty. This is the provable no-op.
    const orchestratorPaths = [
      'orchestrator.whatIfFromGraph',
      'orchestrator.generate',
      'orchestrator.getWorkflow',
      'orchestrator.queryWorkflows',
      'orchestrator.cancelWorkflow',
      'orchestrator.getWorkflowStatusUpdate',
      'orchestrator.enhancePrompt',
    ];
    for (const path of orchestratorPaths) {
      // Uses the DEFAULT (module) allowlist — no override.
      expect(shouldRouteToGateway(path, { enabled: true, url: GATEWAY })).toBe(false);
    }
  });

  it('non-orchestrator paths never route to the gateway', () => {
    expect(
      shouldRouteToGateway('image.getInfinite', {
        enabled: true,
        url: GATEWAY,
        allowlist: ['getInfinite'],
      })
    ).toBe(false);
    expect(
      shouldRouteToGateway('model.getById', { enabled: true, url: GATEWAY, allowlist: ['getById'] })
    ).toBe(false);
  });
});

describe('shouldRouteToGateway — the gateway branch IS reachable once a procedure is allowlisted', () => {
  const allowlist = ['whatIfFromGraph'];

  it('routes to the gateway when path allowlisted AND flag on AND url set', () => {
    expect(
      shouldRouteToGateway('orchestrator.whatIfFromGraph', {
        enabled: true,
        url: GATEWAY,
        allowlist,
      })
    ).toBe(true);
  });

  it('stays on the monolith when the flag is OFF (cohort gate)', () => {
    expect(
      shouldRouteToGateway('orchestrator.whatIfFromGraph', {
        enabled: false,
        url: GATEWAY,
        allowlist,
      })
    ).toBe(false);
  });

  it('stays on the monolith when the gateway URL is empty/undefined', () => {
    expect(
      shouldRouteToGateway('orchestrator.whatIfFromGraph', {
        enabled: true,
        url: '',
        allowlist,
      })
    ).toBe(false);
    expect(
      shouldRouteToGateway('orchestrator.whatIfFromGraph', {
        enabled: true,
        url: undefined,
        allowlist,
      })
    ).toBe(false);
  });

  it('stays on the monolith when the procedure is NOT in the allowlist (allowlist miss)', () => {
    expect(
      shouldRouteToGateway('orchestrator.generate', {
        enabled: true,
        url: GATEWAY,
        allowlist, // only whatIfFromGraph
      })
    ).toBe(false);
  });

  it('matches on the procedure name only (prefix stripped), not the full path', () => {
    // An allowlist entry must be the bare procedure, not the prefixed path.
    expect(
      shouldRouteToGateway('orchestrator.whatIfFromGraph', {
        enabled: true,
        url: GATEWAY,
        allowlist: ['orchestrator.whatIfFromGraph'], // wrong shape → no match
      })
    ).toBe(false);
  });
});
