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
 * It now also guards the SAVE PATH that editor reaches — which fields the
 * mutation sends, and that they come from the server rather than from the row
 * the modal was opened with. Those are money assertions: the payload decides
 * whether a save re-snapshots what each member's creator is paid.
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
const serviceSource = fs.readFileSync(
  path.join(repoRoot, 'src/server/services/creator-shop-pack.service.ts'),
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

/**
 * The source between two literal markers, or '' when either is missing — never a
 * slice from -1, which can still contain what a caller was looking for and pass
 * for a source this function did not locate.
 */
const blockAfter = (source: string, open: string, close: string) => {
  const start = source.indexOf(open);
  if (start === -1) return '';
  const end = source.indexOf(close, start + open.length);
  return end === -1 ? '' : source.slice(start, end + close.length);
};

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

    // The helper takes the FIRST occurrence. A second ternary on the same
    // variable added above it would silently re-point every assertion below at
    // the wrong conditional, and they would all fail naming the right thing for
    // the wrong reason.
    expect(
      pageSource.split('{shopItem.cosmetic ? (').length - 1,
      'More than one `{shopItem.cosmetic ? (` in this page — editArms() would slice the wrong one.'
    ).toBe(1);
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
    // Scoped to the UPDATE payload. `submitPack.mutateAsync` legitimately sends
    // bare `price,` and `memberCosmeticIds,` a few lines below, so an unscoped
    // negative would pass against the wrong call — the same mis-targeting that
    // made the first control for this file green against a reverted fix.
    const updateBlock = blockAfter(modalSource, 'updatePack.mutateAsync({', '});');
    expect(
      updateBlock,
      'Could not find the updatePack payload — the assertions below pin its contents.'
    ).not.toEqual('');

    expect(
      updateBlock,
      'CreatorShopPackModal must send `price` only when it differs from the saved pack.'
    ).toContain('...(price !== existing?.unitAmount ? { price } : {})');
    expect(
      updateBlock,
      'CreatorShopPackModal must send `memberCosmeticIds` only when the contents changed.'
    ).toContain('...(contentsChanged ? { memberCosmeticIds } : {})');

    // The negatives pin the DECISION rather than the spelling, so extracting the
    // predicate into a named const stays green while a revert to the
    // unconditional payload does not. Whole-line matches, so the conditional
    // spreads above — which mention both names — cannot satisfy them.
    const payloadKeys = updateBlock.split('\n').map((line) => line.trim());
    expect(payloadKeys, 'The update payload sends `price` unconditionally again.').not.toContain(
      'price,'
    );
    expect(
      payloadKeys,
      'The update payload sends `memberCosmeticIds` unconditionally again.'
    ).not.toContain('memberCosmeticIds,');
  });

  it('re-validates membership only when membership was supplied', () => {
    // The other half of omitting `memberCosmeticIds`. The server falls back to the
    // pack's stored member list, which INCLUDES members whose listing has since
    // been archived — so running the incoming-membership asserts over it refuses a
    // title-only edit on exactly the packs `unavailableCount` describes. Measured
    // 2026-09-17: 0 of 40 prod packs are in that state today, which makes this
    // latent, not theoretical — a moderator archiving a member's listing creates it.
    //
    // NOT covered here: that the asserts still fire for a supplied list. This is a
    // source gate because the service has no DB harness; a behavioural test would
    // be strictly better and is not written.
    const update = blockAfter(
      serviceSource,
      'export const updateCreatorShopPack',
      'const nextPrice'
    );
    expect(
      update,
      'updateCreatorShopPack must only re-validate membership the caller actually sent.'
    ).toContain('const membershipSupplied = memberCosmeticIds !== undefined;');
    expect(
      update,
      'A price move is still floor-checked, and that floor can only be summed over ' +
        'members that resolve — so bundlability must stay asserted when the price moves.'
    ).toContain('if (membershipSupplied || price !== undefined) assertMembersBundlable');
    for (const assertion of ['assertMembersResellable', 'assertStickerMembersAllowed']) {
      expect(
        blockAfter(update, 'if (membershipSupplied) {', '}'),
        `${assertion} must sit inside the membershipSupplied branch, or it refuses an ` +
          'edit that never touched the contents.'
      ).toContain(assertion);
    }
  });

  it('treats a removal as a contents change', () => {
    // `contentsChanged` decides whether the contents are sent at all, so a term
    // missing from it silently discards an edit. Dropping the length comparison
    // makes a removal-only edit read as unchanged: the member stays in the pack
    // and the moderator is told it saved.
    const derivation = blockAfter(modalSource, 'const contentsChanged =', ';');
    expect(
      derivation,
      'contentsChanged must compare the LENGTH, or removing a member reads as no change.'
    ).toContain('selected.length !== existing.members.length');
    expect(
      derivation,
      "contentsChanged must compare against the SERVER's members, not the caller row."
    ).toContain('existing.members.find');
  });

  it('saves what the server returned, never the caller row', () => {
    // The query client runs at `staleTime: Infinity` (src/utils/trpc.ts), so a row
    // the moderator list fetched an hour ago never refreshes. Seeding the price
    // from it and saving wrote a stale amount back over the creator's own change.
    const hydration = modalSource.match(/setHydrated\(true\);[\s\S]*?setSelected\(/)?.[0] ?? '';
    // All four, not just the price. `name` and `availableQuantity` are sent
    // UNCONDITIONALLY by the payload, so an unhydrated one writes the caller's
    // hour-old value straight over the creator's own edit.
    for (const [field, call] of [
      ['title', 'setName(existing.title)'],
      ['description', "setDescription(existing.description ?? '')"],
      ['price', 'setPrice(existing.unitAmount)'],
      ['quantity', 'setQuantity(existing.availableQuantity ?? undefined)'],
    ] as const) {
      expect(
        hydration,
        `The hydration effect must reconcile ${field} against \`getPack\`, not leave the ` +
          "caller's seed in place."
      ).toContain(call);
    }
    // The OPERATOR, not just the term. `(!isEdit || hydrated) ||` is a one-character
    // mutation that leaves the term present, passes any regex looking for it, and
    // collapses the gate entirely — Save unlocks on the stale seed.
    const canSubmitBlock = blockAfter(modalSource, 'const canSubmit =', ';');
    expect(
      canSubmitBlock,
      'Save must stay disabled until `getPack` has hydrated, or it can commit the seed. ' +
        'The `&&` is the assertion — a `||` here defeats the gate while keeping the term.'
    ).toContain('(!isEdit || hydrated) &&');
    expect(
      canSubmitBlock,
      'A pack the server refuses outright must not present a submittable form — that is ' +
        'the defect this editor replaced.'
    ).toContain('!uneditableStatus &&');
  });
});
