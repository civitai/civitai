import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { MODEL_SALE_IDS_PER_QUERY } from '~/server/schema/model-sale.schema';

/**
 * The cap on `model.getActiveSales`'s `ids` and the size its callers chunk to are one contract
 * across two files, and it cannot be stated once: the router validates, the card hook splits.
 *
 * 🔴 THIS IS THE SEAM THAT ACTUALLY BROKE. The procedure was rejecting every call from a scrolled
 * feed — an input-validation 400, so the resolver never ran, no 5xx was recorded and the sale badge
 * simply vanished from the grid. Chunking fixed the caller; nothing stopped the router drifting
 * back to a private literal, and a literal lowered below the chunk reproduces the outage exactly.
 *
 * A TEXT guard, over a textual property (which symbol the `.input(...)` names) — the one kind a
 * text guard checks well. It does not prove the cap is the right number; it proves the two sides
 * cannot be given different ones. The behavioural half — that every request the hook builds parses
 * against this schema — lives in `src/components/Cards/__tests__/useModelSaleBadges.test.ts`.
 */

const repoRoot = path.resolve(__dirname, '../../../..');
const ROUTER = 'src/server/routers/model.router.ts';

const routerSource = () => readFileSync(path.join(repoRoot, ROUTER), 'utf8');

/** The `getActiveSales:` procedure body, up to the next procedure key at the same indent. */
function getActiveSalesBlock(source: string) {
  const start = source.indexOf('\n  getActiveSales: ');
  expect(start, `${ROUTER} no longer declares a getActiveSales procedure`).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const end = rest.search(/\n {2}[A-Za-z][A-Za-z0-9]*: /);
  return end === -1 ? rest : rest.slice(0, end);
}

describe('model.getActiveSales input cap', () => {
  it('is taken from the shared schema, not restated in the router', () => {
    const block = getActiveSalesBlock(routerSource());

    expect(block).toContain('.input(getActiveSalesSchema)');
  });

  it('is not shadowed by an inline cap in that procedure', () => {
    const block = getActiveSalesBlock(routerSource());

    // The specific regression shape: `.input(z.object({ ids: z.number().array().max(<n>) }))`.
    // Matching `.max(` anywhere in the block would also fire on a legitimate future field, so this
    // pins the one construct that replaces the shared schema.
    expect(block).not.toMatch(/\.input\(\s*z\./);
  });

  it('is a positive bound, so an empty-only schema cannot pass for a cap', () => {
    expect(MODEL_SALE_IDS_PER_QUERY).toBeGreaterThan(0);
  });
});
