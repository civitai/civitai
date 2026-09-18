import { describe, expect, it } from 'vitest';
import { modelRouter } from '~/server/routers/model.router';
import {
  MODEL_SALE_IDS_PER_QUERY,
  MODEL_SALE_IDS_PER_REQUEST,
} from '~/server/schema/model-sale.schema';

/**
 * The cap on `model.getActiveSales`'s `ids` and the size its card surfaces chunk to are one contract
 * across two files, and it cannot be stated once: the router validates, the card hook splits.
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
