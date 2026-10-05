import { describe, expect, it } from 'vitest';
import { modelRouter } from '~/server/routers/model.router';
import {
  MODEL_SALE_IDS_PER_QUERY,
  MODEL_SALE_IDS_PER_REQUEST,
} from '~/server/schema/model-sale.schema';

/**
 * 🔴 SCOPE, STATED FIRST BECAUSE IT IS NARROWER THAN THE NAME SUGGESTS. This file checks the SERVER
 * side of the cap and nothing else: that the parser `model.getActiveSales` actually runs enforces
 * `MODEL_SALE_IDS_PER_QUERY` in both directions, and that `MODEL_SALE_IDS_PER_REQUEST` — the size a
 * card surface is supposed to split to — does not exceed it.
 *
 * ⚠️ IT CANNOT SEE THE CALL SITE, and must not be read as if it can. Nothing below imports
 * `ModelCardContext`, so replacing `chunkIds(modelIds, MODEL_SALE_IDS_PER_REQUEST)` with a literal
 * leaves every test here green — measured, a chunk of 400 is `4 passed (4)` on this file. The other
 * half of the seam, that the card surface chunks to the constant AT ALL, is pinned behaviourally by
 * `src/components/Cards/__tests__/useModelSaleBadges.test.ts`, which runs every request the hook
 * builds through the real schema (the same 400 is `3 failed | 15 passed (18)` there). That file is
 * in the full unit suite, NOT in `test:lint-rules` — so a `test:lint-rules` run alone does not
 * cover the seam, and this comment is the only thing that says so.
 *
 * 🔴 THIS IS THE SEAM THAT ACTUALLY BROKE. The procedure was rejecting every call from a scrolled
 * feed — an input-validation 400, so the resolver never ran, no 5xx was recorded and the sale badge
 * simply vanished from the grid. Chunking fixed the caller; nothing stopped the router drifting
 * back to a private literal, and a literal lowered below the chunk reproduces the outage exactly.
 *
 * 🔴 ASSERTED AGAINST THE PARSER THE PROCEDURE ACTUALLY RUNS, never against the source text. A
 * spelled version of this guard was written first and was walkable: declaring a local
 * `const getActiveSalesSchema = z.object({ ids: z.number().array().max(50) })` at the top of the
 * router leaves `.input(getActiveSalesSchema)` present and every string check green, while every
 * request from a card surface 400s. Parsing real arrays through the real parser cannot be talked
 * past — a cap wrong in either direction fails, wherever it was spelled.
 */

/** The one parser `model.getActiveSales` validates with. */
function activeSalesParser() {
  const procedures = (
    modelRouter as unknown as {
      _def: {
        procedures: Record<
          string,
          { _def: { inputs: { safeParse: (value: unknown) => { success: boolean } }[] } }
        >;
      };
    }
  )._def.procedures;

  const procedure = procedures.getActiveSales;
  expect(procedure, 'model.getActiveSales no longer exists').toBeTruthy();

  // Exactly one: tRPC INTERSECTS chained `.input()` parsers, so a second one could tighten the cap
  // without touching the first — and reading `inputs[0]` alone would report the old bound.
  const inputs = procedure._def.inputs;
  expect(inputs).toHaveLength(1);
  return inputs[0];
}

const idsOfLength = (length: number) => Array.from({ length }, (_, index) => index + 1);

describe('model.getActiveSales input cap', () => {
  it('accepts a full chunk from a card surface', () => {
    // The regression, stated as behaviour: the client may never build a request the server refuses.
    expect(
      activeSalesParser().safeParse({ ids: idsOfLength(MODEL_SALE_IDS_PER_REQUEST) }).success
    ).toBe(true);
  });

  it('accepts exactly the documented cap', () => {
    expect(
      activeSalesParser().safeParse({ ids: idsOfLength(MODEL_SALE_IDS_PER_QUERY) }).success
    ).toBe(true);
  });

  it('refuses one id past the documented cap', () => {
    // The other direction: the router must not quietly accept more than the constant advertises,
    // or the bound the schema comment argues for is not the bound in force.
    expect(
      activeSalesParser().safeParse({ ids: idsOfLength(MODEL_SALE_IDS_PER_QUERY + 1) }).success
    ).toBe(false);
  });

  it('leaves the client asking for no more than the server accepts', () => {
    expect(MODEL_SALE_IDS_PER_REQUEST).toBeLessThanOrEqual(MODEL_SALE_IDS_PER_QUERY);
  });
});
