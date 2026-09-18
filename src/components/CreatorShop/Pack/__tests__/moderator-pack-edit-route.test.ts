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
 * The source between two literal markers, or '' when the open marker is missing,
 * AMBIGUOUS, or unterminated — never a slice from -1, which can still contain
 * what a caller was looking for and pass for a source this function did not
 * locate.
 *
 * Ambiguity matters in one direction only, and it is a measured false green
 * rather than a theoretical one: a SECOND `updatePack.mutateAsync({` added
 * BELOW the real one leaves `indexOf` on the original, every assertion passes,
 * and the new call's unconditional payload is reviewed by nothing. (Added
 * above, the positives already fail.) Returning '' makes both orderings red.
 */
const blockAfter = (source: string, open: string, close: string) => {
  const start = source.indexOf(open);
  if (start === -1 || source.indexOf(open, start + 1) !== -1) return '';
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

    // `) : (` is the weak marker: it occurs more than once in this file, and
    // `editArms` takes the first one AFTER the open. A nested ternary inside the
    // cosmetic arm would truncate that arm and push the rest into the pack arm —
    // which makes the inversion negative below pass VACUOUSLY, and that is the
    // most load-bearing assertion in the file.
    const { cosmeticArm, packArm } = editArms();
    expect(
      (cosmeticArm + packArm).split(') : (').length - 1,
      'A second `) : (` now sits inside the edit conditional, so the two arms are ' +
        'split at the wrong place and the assertions below are reading the wrong text.'
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
    const updatePackBlock = blockAfter(
      utilSource,
      'const updatePack =',
      "onError: onError('Failed to update pack')"
    );
    // Without this, renaming that toast empties the block and all three assertions
    // below fail claiming the invalidations are missing — the wrong cause, for
    // someone who only changed an error message.
    expect(
      updatePackBlock,
      "Could not locate updatePack's mutation block — its closing marker (the " +
        "'Failed to update pack' toast) may have been renamed."
    ).not.toEqual('');

    expect(
      updatePackBlock,
      'updatePack must invalidate cosmeticShop.getShopItemsPaged — the moderator ' +
        'cosmetic-store list is now one of its callers.'
    ).toContain('cosmeticShop.getShopItemsPaged.invalidate()');

    // Its two twins. Both storefronts render packs, and a price or contents edit
    // drops the pack to PendingReview, so both were advertising a listing that is
    // no longer on sale. Deleting either reddened nothing before this line.
    expect(
      updatePackBlock,
      'The creator storefront renders this pack, and a price or contents edit takes it ' +
        'off sale — without this it keeps showing the old listing.'
    ).toContain('creatorShop.getShop.invalidate()');
    expect(
      updatePackBlock,
      'The site-wide community hub renders packs too, and has the same staleness.'
    ).toContain('creatorShop.getCommunityCosmetics.invalidate()');
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

    // Belt and braces over the positives above, not a looser restatement of them:
    // these match a WHOLE trimmed line, so the conditional spreads — which mention
    // both names — cannot satisfy them, and a revert to a bare key is caught twice.
    // They do NOT survive a refactor the positives would fail; the exact spellings
    // above are the guard, and that brittleness is the price of a source gate.
    const payloadKeys = updateBlock.split('\n').map((line) => line.trim());
    expect(payloadKeys, 'The update payload sends `price` unconditionally again.').not.toContain(
      'price,'
    );
    expect(
      payloadKeys,
      'The update payload sends `memberCosmeticIds` unconditionally again.'
    ).not.toContain('memberCosmeticIds,');

    // Not a money field, same rule: sent unconditionally it makes the server's
    // blue-buzz check run on every title edit, and a member who has since opted
    // out then refuses an edit that never touched blue.
    expect(
      payloadKeys,
      'The update payload sends `acceptsBlueBuzz` unconditionally again.'
    ).not.toContain('acceptsBlueBuzz,');
    // The mirror positive. Without it, DELETING the spread passes: the field is
    // then never sent, `nextAcceptsBlue` always falls back to the stored value,
    // and a moderator can never change a pack's blue setting again — the switch
    // moves, the save succeeds, nothing happens.
    expect(
      updateBlock,
      'CreatorShopPackModal must still SEND `acceptsBlueBuzz` when it differs from the ' +
        'saved pack, or the setting becomes unchangeable.'
    ).toContain('...(blueChanged ? { acceptsBlueBuzz } : {})');
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
      // Past the floor block, not into it: `const nextPrice` moved INSIDE
      // `if (reSnapshot) {` this round, which truncated this slice before the
      // throw the floor assertion below reads.
      'const nextAcceptsBlue'
    );
    // Its close marker moved once already this PR. Without this, every assertion
    // below fails claiming the server stopped scoping its validation, when all
    // that happened is a marker drifted.
    expect(
      update,
      'Could not locate updateCreatorShopPack between its markers — the assertions ' +
        'below read that slice, so fix this before trusting them.'
    ).not.toEqual('');
    expect(
      update,
      'updateCreatorShopPack must only re-validate membership the caller actually sent.'
    ).toContain('const membershipSupplied = memberCosmeticIds !== undefined;');
    expect(
      update,
      'A price move is still floor-checked, and that floor can only be summed over ' +
        'members that resolve — so bundlability must stay asserted when the price moves.'
    ).toContain('if (reSnapshot) assertMembersBundlable');

    // One truth function for "this edit invalidates the stored floors". Written
    // twice, `!== undefined` and truthiness disagree on `[]`, which would run the
    // checks while skipping the write that makes them true.
    expect(
      update,
      '`reSnapshot` must be derived once, from membershipSupplied || repriced.'
    ).toContain('const reSnapshot = membershipSupplied || repriced;');

    // 🔴 Pin what the aliases MEAN, not only that they are used. `const repriced
    // = false` leaves every other spelling in this file intact and silently
    // reverts the whole price half of this change: no floor check, no
    // `floorAmount` re-snapshot, no drop to PendingReview on a reprice. Measured
    // green before this assertion existed.
    expect(
      update,
      '`repriced` must be `price !== undefined` — a price of 0 is still a repricing, ' +
        'and anything narrower silently disables the price path.'
    ).toContain('const repriced = price !== undefined;');

    // `members` is resolved only for the edits that read it, so the predicate has
    // to cover every consumer. Narrowing it hands an EMPTY list to whichever
    // check it drops — and an empty list passes the floor, the blockers and the
    // bundlable comparison silently rather than refusing.
    expect(
      update,
      'The member resolve must stay guarded by everything that reads it: reSnapshot ' +
        'covers the asserts, the floor and the snapshot rows; acceptsBlueBuzz covers ' +
        'the blue blockers.'
    ).toContain('const needsMembers = reSnapshot || acceptsBlueBuzz !== undefined;');
    expect(update, '`membershipSupplied` must be `memberCosmeticIds !== undefined`.').toContain(
      'const membershipSupplied = memberCosmeticIds !== undefined;'
    );

    // 🔴 Both halves of the blue-buzz decision, adjacent so neither can drift from
    // the other. The `?? !!meta.acceptsBlueBuzz` fallback became load-bearing the
    // moment the client stopped sending the field on every edit: `?? false` then
    // flips a blue-accepting pack to blue-declining on a TITLE fix, silently.
    // Measured green before this assertion. And the gate below it is the server
    // half of the same invariant the payload spread implements on the client —
    // unpinned, reverting it makes that spread achieve nothing.
    const blueDecision = blockAfter(
      serviceSource,
      'const nextAcceptsBlue',
      'blueBuzzBlockers(members)'
    );
    expect(blueDecision, 'Could not locate the blue-buzz decision in the service.').not.toEqual('');
    expect(
      blueDecision,
      'The blue-buzz fallback must preserve the stored value. `?? false` flips a ' +
        'blue-accepting pack to blue-declining on a title fix, silently.'
    ).toContain('acceptsBlueBuzz ?? !!meta.acceptsBlueBuzz');
    expect(
      blueDecision,
      'The blue check must stay scoped to an edit that touched membership or the flag — ' +
        'unconditionally it refuses a title fix, and the client-side spread achieves nothing.'
    ).toContain('if (membershipSupplied || acceptsBlueBuzz !== undefined) {');

    // The floor gating itself, which is what delivers "a title-only edit is not
    // refused". Reverting it to unconditional reddened nothing before this.
    expect(
      blockAfter(update, 'if (reSnapshot) {', 'throw throwBadRequestError'),
      'The price floor must be checked only when the price or the contents moved — ' +
        'unconditionally it refuses a title fix over a member that repriced since.'
    ).toContain('packPriceFloor(members)');
    // The operator, for the same reason canSubmit pins its `&&`: `>` leaves every
    // pinned spelling intact and refuses every price ABOVE the floor.
    expect(
      blockAfter(update, 'if (reSnapshot) {', 'throw throwBadRequestError'),
      'The floor comparison must refuse a price BELOW the floor.'
    ).toContain('if (nextPrice < floor)');
    // Named and guarded: the open marker differs from its sibling in
    // createCreatorShopPack by one `await`, so adding one here would empty this
    // slice and blame the PendingReview spread for it.
    const txBlock = blockAfter(
      serviceSource,
      'return dbWrite.$transaction',
      'acceptsBlueBuzz: nextAcceptsBlue'
    );
    expect(
      txBlock,
      "Could not locate updateCreatorShopPack's transaction body — check its markers."
    ).not.toEqual('');
    expect(
      txBlock,
      'The PendingReview spread must reuse `reSnapshot`, not restate its expression.'
    ).toContain('...(reSnapshot ? { status: CosmeticShopItemStatus.PendingReview } : {})');
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
    // The predicate around them, which neither substring pins. Dropping the `!`
    // makes contentsChanged true whenever any member is UNCHANGED — so the
    // contents go on every title edit and every floorAmount is re-snapshotted,
    // which is the decision this file exists to protect. `.some` to `.every`
    // makes a same-length swap read as no change. Both measured green before this.
    expect(
      derivation,
      'contentsChanged must be true when a selected member is ABSENT from the server list.'
    ).toContain(
      'selected.some((m) => !existing.members.find((e) => e.cosmeticId === m.cosmeticId))'
    );
  });

  it('saves what the server returned, never the caller row', () => {
    // The query client runs at `staleTime: Infinity` (src/utils/trpc.ts), so a row
    // the moderator list fetched an hour ago never refreshes. Seeding the price
    // from it and saving wrote a stale amount back over the creator's own change.
    const hydration = blockAfter(modalSource, 'setHydrated(true);', '}, [existing, hydrated');
    expect(
      hydration,
      'Could not locate the hydration effect between setHydrated(true) and its dep array.'
    ).not.toEqual('');
    // Every seed the effect writes, not a subset. `name` and
    // `availableQuantity` are sent unconditionally by the payload, so an
    // unhydrated one writes the caller's hour-old value over the creator's own
    // edit. `acceptsBlueBuzz` is worse than that: the payload compares against
    // this same server value, so an unhydrated seed is both the thing sent and
    // the thing compared, and the difference vanishes.
    for (const [field, call] of [
      ['title', 'setName(existing.title)'],
      ['description', "setDescription(existing.description ?? '')"],
      ['price', 'setPrice(existing.unitAmount)'],
      ['quantity', 'setQuantity(existing.availableQuantity ?? undefined)'],
      ['blue-buzz opt-in', 'setAcceptsBlueBuzz(!!existing.meta.acceptsBlueBuzz)'],
      ['cover', 'setImageId(existing.meta.coverUrl ?? null)'],
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

    // Two halves of one invariant. canSubmit refuses blue-with-blockers, so the
    // switch must stay operable in that state or the only control that clears the
    // refusal is frozen and the pack cannot be saved at all. Pinning either alone
    // lets the other be dropped silently.
    expect(
      canSubmitBlock,
      'canSubmit must still refuse blue-accepting with a blocking member.'
    ).toContain('!(blueChanged && acceptsBlueBuzz && blueBlockers.length)');

    // What `blueChanged` MEANS, not only that it is used. Widen it to `true` and
    // the client refuses a title fix on a pack whose member stopped accepting blue
    // since, making "turn Blue Buzz off" the only route to fixing someone else's
    // typo — this ticket's own bug in miniature.
    expect(
      modalSource,
      '`blueChanged` must compare against the stored value, so the client refuses on ' +
        'exactly the condition the payload and the server use.'
    ).toContain('const blueChanged = acceptsBlueBuzz !== !!existing?.meta.acceptsBlueBuzz;');

    // Archiving OVERWRITES status, so the review verdict is the only thing that
    // separates a rejected pack from an ordinary archived one. Without this term
    // the alert tells a moderator to restore a pack whose restore the server
    // refuses as REJECTED_IS_FINAL — the dead end this derivation exists to
    // remove, and it was pinned by nothing.
    //
    // The derivation MOVED to the server (getPackDetail) rather than being
    // dropped — the endpoint now returns named fields, and the verdict is one
    // of them. Restating the rule from the history client-side, the shape this
    // pinned before, would undo that. If you are deleting this, read
    // `pack-detail-public-fields.test.ts` first: it is the other half.
    //
    // The OPERATOR, as with canSubmit above: an `||` here keeps the term, keeps
    // the guard green, and makes a Published pack with an old rejection in its
    // history uneditable.
    expect(
      modalSource,
      'The rejected-vs-archived split must use the server-derived verdict, not restate ' +
        'the rule — an archived-after-rejection pack is NOT restorable.'
    ).toContain('CosmeticShopItemStatus.Archived && !!existing.lastReviewWasRejection');
    // Optional-chained, because `existing.meta?.history` is the spelling this
    // file's own idiom would reach for and it does not contain `meta.history`.
    expect(
      modalSource,
      'The editor must derive this from what the endpoint returns, not from the review history.'
    ).not.toMatch(/meta\??\.history/);
    expect(
      modalSource,
      'The alert must choose its copy from wasRejected, or the two arms can be swapped back.'
    ).toContain('{wasRejected');

    // Both buttons that mutate the selection, in one count: hydration REPLACES
    // `selected`, so either one live before getPack lands silently discards the
    // moderator's change. Add gained the guard first; Remove is its mirror.
    // Scoped to the Remove button itself. A COUNT is vacuous here: six controls
    // carry this prop, so dropping one still clears any threshold — measured, the
    // count form stayed green against exactly the mutation it was added for.
    expect(
      blockAfter(modalSource, 'leftSection={<IconX size={14} />}', 'onClick='),
      'The Remove button must wait for hydration like Add: hydration REPLACES the selection, so a removal made before getPack lands is silently undone.'
    ).toContain('disabled={awaitingPack}');
    expect(
      modalSource,
      'The Blue Buzz switch must be un-tickable but never un-un-tickable, and must wait ' +
        'for hydration like every other control.'
    ).toContain('disabled={awaitingPack || (blueBlockers.length > 0 && !acceptsBlueBuzz)}');
  });
});
