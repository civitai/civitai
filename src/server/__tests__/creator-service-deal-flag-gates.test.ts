import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

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

  it('defines `gated` as the creatorServices flag', () => {
    expect(router).toContain(
      "const gated = guardedProcedure.use(isFlagProtected('creatorServices'));"
    );
  });
});
