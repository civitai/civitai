import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { upsertCosmeticShopItemInput } from '~/server/schema/cosmetic-shop.schema';

/**
 * 🔒 A pack row on the moderator cosmetic-store list opens the PACK editor.
 *
 * A pack is a `CosmeticShopItem` with `cosmeticId` null, and the generic product
 * form requires one — so sending a pack to `/products/[id]/edit` gives a
 * moderator a form that fails on every save, losing what they typed. That is why
 * pack rows had no Edit control at all (ClickUp 868m67vx3, Ellie 2026-09-17).
 *
 * 🔴 IF YOU ARE HERE TO DELETE THIS: the two-way split is deliberate. The pack
 * editor is the only thing that can edit a pack's CONTENTS, and the product form
 * is the only thing that can edit `availableFrom`/`availableTo`/`archived`.
 * Collapsing them back to one control is a product decision — take it
 * deliberately, and make the surviving form handle a null `cosmeticId` first.
 *
 * Source-gate rather than a render: the defect is which component a click
 * routes to, which is what a source read sees and what a mocked render of a
 * dialog store would sail past.
 *
 * NOT covered here, deliberately: whether a moderator is AUTHORIZED to save the
 * pack. That is server-side, in `updateCreatorShopPack`, and is not a property
 * of this page.
 */
const repoRoot = path.resolve(__dirname, '../../../../..');
const pageSource = fs.readFileSync(
  path.join(repoRoot, 'src/pages/moderator/cosmetic-store/products/index.tsx'),
  'utf-8'
);
const utilSource = fs.readFileSync(
  path.join(repoRoot, 'src/components/CreatorShop/creator-shop.util.ts'),
  'utf-8'
);

describe('the moderator cosmetic-store pack edit route', () => {
  it('opens the pack editor for a pack row', () => {
    expect(
      pageSource,
      'A pack row must open CreatorShopPackModal. Without it packs have no edit path ' +
        'on this page at all, which is the bug this guards.'
    ).toMatch(/component:\s*CreatorShopPackModal/);
  });

  it('keeps the product form on the cosmetic-backed branch only', () => {
    // Anchored to the BRANCH, not to the file: `shopItem.cosmetic && <edit link>`
    // — the shape this replaced — also contains both spellings, so a bare
    // `toContain` would pass against the state where packs get no control.
    expect(
      pageSource,
      'The /products/[id]/edit link must sit on the `shopItem.cosmetic ?` true-branch. ' +
        'On a pack it opens a form that cannot save.'
    ).toMatch(
      /shopItem\.cosmetic \?[\s\S]{0,200}?href=\{`\/moderator\/cosmetic-store\/products\/\$\{shopItem\.id\}\/edit`\}/
    );
  });

  it('is needed because the product form cannot represent a pack', () => {
    // Asked of the server's own schema rather than asserted in prose: if
    // `cosmeticId` ever becomes optional, the product form could carry a pack and
    // this whole split is reconsiderable — so it should fail HERE, not silently
    // keep two editors alive.
    expect(upsertCosmeticShopItemInput.shape.cosmeticId.safeParse(1).success).toBe(true);
    expect(
      upsertCosmeticShopItemInput.shape.cosmeticId.safeParse(undefined).success,
      'upsertCosmeticShopItemInput.cosmeticId now accepts undefined, so the product form ' +
        'may be able to handle a pack. Re-decide the split above before relying on it.'
    ).toBe(false);
  });

  it('refreshes the moderator list after a pack is saved', () => {
    // Scoped to updatePack's own handler: the page reads getShopItemsPaged, which
    // this mutation did not invalidate when only the creator manage page could
    // reach it. Without this the moderator saves and the row still shows the old
    // title and price.
    const updatePackBlock =
      utilSource.match(/const updatePack = [\s\S]*?onError: onError\('Failed to update pack'\)/)?.[0] ??
      '';
    expect(
      updatePackBlock,
      'updatePack must invalidate cosmeticShop.getShopItemsPaged — the moderator ' +
        'cosmetic-store list is now one of its callers.'
    ).toContain('cosmeticShop.getShopItemsPaged.invalidate()');
  });
});
