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
const modalSource = fs.readFileSync(
  path.join(repoRoot, 'src/components/CreatorShop/Pack/CreatorShopPackModal.tsx'),
  'utf-8'
);
const utilSource = fs.readFileSync(
  path.join(repoRoot, 'src/components/CreatorShop/creator-shop.util.ts'),
  'utf-8'
);

/**
 * Splits the row's edit conditional into its two arms.
 *
 * Membership, not proximity. A window-and-distance regex cannot tell
 * `{shopItem.cosmetic ? …}` from `{!shopItem.cosmetic ? …}` — the second
 * CONTAINS the first as a substring — so it stays green against the inversion
 * that hands packs the product form and cosmetics the pack editor, which is this
 * PR's bug with the arms swapped. Measured before this was rewritten: the
 * inverted source passed.
 */
const editArms = () => {
  const open = pageSource.indexOf('{shopItem.cosmetic ? (');
  const split = pageSource.indexOf(') : (', open);
  const close = pageSource.indexOf('<LegacyActionIcon onClick={() => handleDeleteItem', split);
  // Empty arms when a marker is missing, never a slice from -1: a garbage slice
  // can still contain the string a later case looks for, which would pass the
  // arm assertions for a source this function did not actually understand.
  const found = open !== -1 && split !== -1 && close !== -1;
  return {
    found,
    cosmeticArm: found ? pageSource.slice(open, split) : '',
    packArm: found ? pageSource.slice(split, close) : '',
  };
};

const EDIT_HREF = 'href={`/moderator/cosmetic-store/products/${shopItem.id}/edit`}';

describe('the moderator cosmetic-store pack edit route', () => {
  it('splits the edit control on `shopItem.cosmetic` at all', () => {
    // The other cases slice against these three markers, so a refactor that moves
    // them has to fail HERE — loudly — rather than handing every later `expect`
    // an empty string to pass against.
    expect(
      editArms().found,
      'Could not find `{shopItem.cosmetic ? (` … `) : (` … the delete icon in ' +
        'products/index.tsx. The assertions below slice on those markers, so fix ' +
        'this before trusting them.'
    ).toBe(true);
  });

  it('opens the pack editor on the pack arm, and only there', () => {
    const { cosmeticArm, packArm } = editArms();
    expect(
      packArm,
      'The false arm of `shopItem.cosmetic` must open CreatorShopPackModal. Without ' +
        'it packs have no edit path on this page at all, which is the bug this guards.'
    ).toContain('component: CreatorShopPackModal');
    // The half that kills the inversion. A positive-only pair passes with the
    // arms swapped, because both spellings are still somewhere in the file.
    expect(
      cosmeticArm,
      'CreatorShopPackModal is on the `shopItem.cosmetic` TRUE arm, so a cosmetic-backed ' +
        'product opens the pack editor. The branch is inverted.'
    ).not.toContain('CreatorShopPackModal');
  });

  it('keeps the product form on the cosmetic-backed arm, and only there', () => {
    const { cosmeticArm, packArm } = editArms();
    expect(
      cosmeticArm,
      'The /products/[id]/edit link must sit on the `shopItem.cosmetic` true arm.'
    ).toContain(EDIT_HREF);
    expect(
      packArm,
      'A pack row links to /products/[id]/edit, which requires a cosmeticId and fails ' +
        'on every save. That is the defect this PR removed.'
    ).not.toContain(EDIT_HREF);
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
      utilSource.match(
        /const updatePack = [\s\S]*?onError: onError\('Failed to update pack'\)/
      )?.[0] ?? '';
    expect(
      updatePackBlock,
      'updatePack must invalidate cosmeticShop.getShopItemsPaged — the moderator ' +
        'cosmetic-store list is now one of its callers.'
    ).toContain('cosmeticShop.getShopItemsPaged.invalidate()');

    // Its two twins. Both storefronts render packs, and a price or contents edit
    // drops the pack to PendingReview, so both were advertising a listing that is
    // no longer on sale. Deleting either reddened nothing before this line.
    expect(updatePackBlock).toContain('creatorShop.getShop.invalidate()');
    expect(updatePackBlock).toContain('creatorShop.getCommunityCosmetics.invalidate()');
  });

  it('sends the money fields only when they changed', () => {
    // 🔴 THE DECISION. `price` and `memberCosmeticIds` sent unconditionally
    // re-snapshot every member's `floorAmount` — the basis their creator is PAID
    // on — rewrite `packMemberCount` past the guard that refuses a pack whose
    // member has gone, and unlist the pack, on an edit that touched only the
    // title. The server is written for these to be OMITTED when unchanged; the
    // schema comment on `memberCosmeticIds` says so. Restoring the unconditional
    // spread moves a third party's money on a typo fix.
    expect(
      modalSource,
      'CreatorShopPackModal must send `price` only when it differs from the saved pack.'
    ).toContain('...(price !== existing?.unitAmount ? { price } : {})');
    expect(
      modalSource,
      'CreatorShopPackModal must send `memberCosmeticIds` only when the contents changed.'
    ).toContain('...(contentsChanged ? { memberCosmeticIds } : {})');
  });

  it('saves what the server returned, never the caller row', () => {
    // The query client runs at `staleTime: Infinity` (src/utils/trpc.ts), so a row
    // the moderator list fetched an hour ago never refreshes. Seeding the price
    // from it and saving wrote a stale amount back over the creator's own change.
    const hydration = modalSource.match(/setHydrated\(true\);[\s\S]*?setSelected\(/)?.[0] ?? '';
    expect(
      hydration,
      'The hydration effect must reconcile the price against `getPack`, not leave the ' +
        "caller's seed in place."
    ).toContain('setPrice(existing.unitAmount)');
    expect(
      modalSource,
      'Save must stay disabled until `getPack` has hydrated, or it can commit the seed.'
    ).toMatch(/const canSubmit =[\s\S]{0,200}?\(!isEdit \|\| hydrated\)/);
  });
});
