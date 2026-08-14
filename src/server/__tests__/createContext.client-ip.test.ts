import { describe, it, expect, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * BEHAVIOURAL guard on `ctx.ip` — the value, at the three places it is minted.
 *
 * 🔴 WHY THIS FILE EXISTS: A MUTATION SURVIVED WITHOUT IT. The sentinel unit
 * test beside the predicate asserts that `resolveClientIpOrNull(req) ?? ''`
 * yields `''` for an unresolvable request. That is a test of the IDIOM, not of
 * this module — and a mutant that changed the three mint sites to keep the
 * shared label instead of the falsy sentinel passed the entire targeted suite
 * (0 failures / 325 tests). The defect lived in the seam neither side owned:
 * the predicate's tests scope to the predicate, and nothing scoped to what
 * `createContext` does with it.
 *
 * That mutant is not cosmetic. `ctx.ip` is read in 23 places, and two of them
 * treat a falsy address as meaningfully different from a non-address string:
 *
 *   - `base.reward.ts` folds `''` (and `::1`) to `undefined` before the value
 *     can reach a buzz-transaction idempotency key. The shared label is not in
 *     that list, so leaking it changes a key that guards real money.
 *   - The captcha verifier forwards the value to an external verification API
 *     as a remote-address field, on payment-carrying paths.
 *
 * So the property asserted here is the SENTINEL, per mint site:
 *
 *   For a request from which no address resolves, every `ctx.ip` mint yields
 *   the falsy sentinel — never the shared unresolvable label, and never a
 *   non-address string.
 *
 * ...paired with its positive control: for a request that DOES resolve, the
 * same mint yields that address. Without the second half, a context builder
 * that hard-coded `''` would satisfy the first half completely.
 */

/**
 * 🔴 THE MOCKS BELOW REPLACE MODULE-SCOPE WORK, NOT BEHAVIOUR UNDER TEST.
 * `origin-helpers` and `server-domain` build their allowlists at import time
 * from env fields the test runner does not populate. Stubbing `~/env/server`
 * instead was tried and was WORSE: the stub omitted a field one of them reads at
 * module scope, the suite failed to IMPORT, and vitest reported that as
 * `Tests no tests` — not as a failure. A zero test count is indistinguishable
 * from a suite wired to nothing, so this file asserts its own mint count (the
 * first test below) rather than trusting a green run.
 *
 * Neither mocked module participates in deriving `ctx.ip`, which is what is
 * under test here.
 */
vi.mock('~/server/utils/origin-helpers', () => ({
  isAllowedOriginRequest: () => true,
  hostFromUrl: (v: string) => v,
  allowedOriginHosts: new Set<string>(),
}));
vi.mock('~/server/utils/server-domain', () => ({
  getRequestDomainColor: () => 'blue',
  getAllServerHosts: () => ['civitai.com'],
}));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn(async () => undefined) }));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => null),
}));
vi.mock('~/server/services/feature-flags.service', () => ({
  getFeatureFlagsLazy: vi.fn(() => ({})),
}));
// The router tree is pulled in only for `createCallerFactory`; stubbing it keeps
// this suite's import graph to the context module itself.
vi.mock('~/server/routers', () => ({ appRouter: {} }));
vi.mock('~/server/trpc', () => ({
  createCallerFactory: () => (ctx: unknown) => ctx,
}));

import { createContext, publicApiContext, publicApiContext2 } from '../createContext';
import { UNRESOLVED_CLIENT_IP, resolveClientIp } from '~/server/utils/client-ip';

function reqWith(
  headers: Record<string, string | string[]>,
  remoteAddress?: string
): NextApiRequest {
  return {
    headers,
    socket: { remoteAddress },
    cookies: {},
    query: {},
  } as unknown as NextApiRequest;
}

function resStub(): NextApiResponse {
  return { once: vi.fn(), writableEnded: false } as unknown as NextApiResponse;
}

/** Every place `ctx.ip` is minted, so a new one cannot be added unguarded. */
const MINTS: ReadonlyArray<readonly [string, (req: NextApiRequest) => Promise<unknown>]> = [
  ['createContext', async (req) => await createContext({ req, res: resStub() })],
  ['publicApiContext', async (req) => await publicApiContext(req, resStub())],
  ['publicApiContext2', async (req) => await publicApiContext2(req, resStub())],
];

async function ipFrom(mint: (req: NextApiRequest) => Promise<unknown>, req: NextApiRequest) {
  const ctx = (await mint(req)) as { ip: unknown };
  return ctx.ip;
}

describe('createContext: the ctx.ip sentinel and the address it carries', () => {
  it('CONTROL: all three mint sites are covered', () => {
    // A ledger of the mints themselves. If a fourth context builder appears,
    // this is the assertion that says the list was not updated — the per-mint
    // rows below can only guard what they enumerate.
    expect(MINTS.length).toBe(3);
    expect(MINTS.map(([name]) => name).sort()).toEqual([
      'createContext',
      'publicApiContext',
      'publicApiContext2',
    ]);
  });

  describe.each(MINTS)('%s', (_name, mint) => {
    it('POSITIVE CONTROL: carries a resolvable address through', async () => {
      // Without this, a builder that hard-coded the sentinel would satisfy the
      // assertion below perfectly.
      const req = reqWith({ 'cf-connecting-ip': '203.0.113.7' });
      expect(await ipFrom(mint, req)).toBe('203.0.113.7');
    });

    it('carries the address the shared derivation reports, not another one', async () => {
      // The discriminating request: one carrying a competing address alongside
      // the edge-stamped one. This is the fixture on which the derivations
      // disagree, so it is the only one that can tell which was used.
      const req = reqWith({ 'cf-connecting-ip': '203.0.113.7', 'x-client-ip': '198.51.100.4' });
      const ip = await ipFrom(mint, req);
      expect(ip).toBe('203.0.113.7');
      // ...and as a property, so it holds however the derivation is spelled.
      expect(ip).toBe(resolveClientIp(req));
    });

    it('🔴 yields the FALSY sentinel when nothing resolves — never the shared label', async () => {
      const ip = await ipFrom(mint, reqWith({}));
      expect(ip).toBe('');
      // Stated separately and explicitly. `toBe('')` alone would already fail
      // for the label, but this names the mutant so a future reader knows which
      // failure they are looking at: the reward pipeline folds `''` away before
      // it can reach a buzz idempotency key, and does not fold the label.
      expect(
        ip,
        'the shared unresolvable label must not reach ctx.ip — downstream code folds the ' +
          'falsy sentinel away before it can reach a buzz idempotency key or an outbound ' +
          'captcha remote-address field, and does not fold this label'
      ).not.toBe(UNRESOLVED_CLIENT_IP);
      expect(ip).toBeFalsy();
    });

    it('yields the falsy sentinel when the address present is not a usable one', async () => {
      // A second route to the unresolvable branch: a value that is present but
      // fails validation, with nothing else to fall back to.
      const ip = await ipFrom(mint, reqWith({ 'cf-connecting-ip': 'fe80::1%eth0' }));
      expect(ip).toBe('');
      expect(ip).not.toBe(UNRESOLVED_CLIENT_IP);
    });
  });

  it('the three mints agree with each other on every fixture', () => {
    // The seam property. Three builders that each look locally correct can
    // still disagree, and a caller hitting two entry points would then be
    // attributed two different ways for one request.
    const fixtures = [
      reqWith({ 'cf-connecting-ip': '203.0.113.7' }),
      reqWith({ 'cf-connecting-ip': '203.0.113.7', 'x-client-ip': '198.51.100.4' }),
      reqWith({ 'x-client-ip': '198.51.100.4' }),
      reqWith({}, '10.42.0.9'),
      reqWith({}),
    ];
    return Promise.all(
      fixtures.map(async (req) => {
        const values = await Promise.all(MINTS.map(([, mint]) => ipFrom(mint, req)));
        expect(new Set(values).size, `mints disagree: ${JSON.stringify(values)}`).toBe(1);
      })
    );
  });
});
