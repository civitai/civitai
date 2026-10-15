import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { DEAL_GATED_ACTIONS } from '~/shared/utils/creator-service-deal-view';

/**
 * Which deal procedures sit behind `creatorServices`, pinned by text because the router's
 * middleware is one declaration per procedure. Entries are gated; exits are not, so turning the
 * flag off never traps held Buzz or an open deal. Accepting a delivery is an exit (the auto-complete
 * job does it ungated anyway); requesting a revision needs a seller upload, and uploads are gated.
 */

const router = readFileSync(
  join(process.cwd(), 'src/server/routers/creator-service-deal.router.ts'),
  'utf8'
).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

// One chunk per top-level key of the router object, however its value is built or its key is
// quoted, so a procedure written in an unexpected form still gets a chunk of its own.
const procedures = Object.fromEntries(
  router
    .slice(router.indexOf('router({'))
    .split(/^ {2}(?=['"]?\w+['"]?\s*:)/m)
    .slice(1)
    .map((chunk) => [chunk.slice(0, chunk.indexOf(':')).replace(/['"\s]/g, ''), chunk])
);

const GATED = ['request', 'accept', 'requestRevision'];
const UNGATED = [
  'listMine',
  'get',
  'withdraw',
  'decline',
  'acceptDelivery',
  'cancelLate',
  'requestCancellation',
  'respondCancellation',
  'openDispute',
];

describe('creator service deal flag gates', () => {
  it('names every procedure exactly once in one list or the other', () => {
    expect(Object.keys(procedures).sort()).toEqual([...GATED, ...UNGATED].sort());
  });

  it.each(GATED)('gates %s behind the flag', (name) => {
    expect(procedures[name]).toMatch(/^\w+: gated\b/);
  });

  // Decision (briony, 2026-10-15): exits stay open with the flag off. Do not gate these.
  it.each(UNGATED)('leaves %s open with the flag off', (name) => {
    expect(procedures[name]).toMatch(/^\w+: protectedProcedure\b/);
    expect(procedures[name]).not.toContain('isFlagProtected');
    expect(procedures[name]).not.toMatch(/\bgated\b/);
  });

  // The deal view drops these from `actions` while the flag is off. A procedure gated here but
  // still offered there is a button that answers 403. `request` makes a deal, so no deal offers it.
  it('lists the same gated actions as the deal view', () => {
    expect([...DEAL_GATED_ACTIONS].sort()).toEqual(
      GATED.filter((name) => name !== 'request').sort()
    );
  });

  it('defines `gated` as the creatorServices flag', () => {
    expect(router).toContain(
      "const gated = guardedProcedure.use(isFlagProtected('creatorServices'));"
    );
  });
});

// The services take these as optional, so dropping one here would still compile and still pass
// every service test.
describe('creator service deal router inputs', () => {
  it.each(['decline', 'requestCancellation', 'openDispute'])(
    'passes the reason code through on %s',
    (name) => {
      expect(procedures[name]).toContain('reasonCode: input.reasonCode,');
    }
  );

  it.each(['get', 'listMine'])('tells %s whether the flag is on', (name) => {
    expect(procedures[name]).toContain('servicesEnabled: !!ctx.features?.creatorServices,');
  });

  // The domain's levels and the buyer's consent come from the request, never the input.
  it.each(['request', 'listMine'])('gives %s the levels the domain may serve', (name) => {
    expect(procedures[name]).toContain('servableLevels: domainServableLevels(ctx),');
  });

  it("gives request the buyer's own browsing level as consent", () => {
    expect(procedures.request).toContain('consentLevels: getRequestBrowsingLevel(ctx),');
  });
});
