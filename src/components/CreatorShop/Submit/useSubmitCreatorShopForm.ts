import { useState } from 'react';
import { useDebouncedValue } from '@mantine/hooks';
import { useQueryBuzz } from '~/components/Buzz/useBuzz';
import type { CreatorShopManageItem } from '~/components/CreatorShop/creator-shop.util';
import { useMutateCreatorShop } from '~/components/CreatorShop/creator-shop.util';
import { validateCosmeticImage } from '~/components/CreatorShop/creator-shop.validation';
import {
  FEE_UNAVAILABLE_MESSAGE,
  useCreatorShopFees,
} from '~/components/CreatorShop/useCreatorShopFees';
import {
  buildData,
  editNotice,
  existingArtUrl,
  type PreviewCosmetic,
} from '~/components/CreatorShop/Submit/submit.util';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { constants } from '~/server/common/constants';
import type {
  AutoCheck,
  CosmeticOffsets,
  CreatorCosmeticType,
  UpdateCreatorShopItemInput,
} from '~/server/schema/creator-shop.schema';
import {
  cosmeticPriceFloor,
  STICKER_MIN_BUZZ_PER_USE,
  STICKER_MAX_USES,
  CREATOR_SHOP_CREATOR_SHARE,
  isCreatorCosmeticType,
  stickerPerUseFloor,
} from '~/server/schema/creator-shop.schema';
import {
  STICKER_SLUG_ERROR,
  isValidStickerSlug,
  stickerEconomicsFromCosmeticData,
} from '~/shared/utils/sticker-token';
import { CosmeticShopItemStatus, CosmeticSource, CosmeticType } from '~/shared/utils/prisma/enums';
import { isAnimatedImage } from '~/utils/media-preprocessors/image.preprocessor';
import { showErrorNotification } from '~/utils/notifications';
import { isUploadInFlight } from '~/utils/upload-status';
import { trpc } from '~/utils/trpc';

// Owns the submit/edit form: local field state, the derived readiness/affordability
// flags, artwork drop handling, and the create/update mutations. Keeps the modal
// a thin composition of presentational pieces.
export function useSubmitCreatorShopForm({
  item,
  onClose,
}: {
  item?: CreatorShopManageItem;
  onClose: () => void;
}) {
  const isEdit = !!item;
  const currentUser = useCurrentUser();
  const { submitItem, updateItem } = useMutateCreatorShop();
  const { uploadToCF, files, resetFiles } = useCFImageUpload();

  const [type, setTypeState] = useState<CreatorCosmeticType>(
    item?.cosmetic?.type && isCreatorCosmeticType(item.cosmetic?.type)
      ? item.cosmetic?.type
      : CosmeticType.Badge
  );
  const existingEconomics = stickerEconomicsFromCosmeticData(item?.cosmetic?.data);
  // Empty, never prefilled with a default. A prefilled field cannot express
  // "unset": seeded to the floor it was indistinguishable from a creator who
  // chose the floor, so an unrelated edit either wrote a price they never
  // picked, or — gated on interaction instead — silently failed to write the
  // one they agreed with. Undefined means unchosen, and unchosen blocks submit.
  const [uses, setUses] = useState<number | undefined>(existingEconomics.uses);
  const [pricePerUse, setPricePerUse] = useState<number | undefined>(existingEconomics.pricePerUse);
  const [slug, setSlug] = useState<string>(
    ((item?.cosmetic?.data as { slug?: string } | null)?.slug ?? '') as string
  );
  const [name, setName] = useState(item?.title ?? '');
  const [description, setDescription] = useState(item?.description ?? '');
  const [price, setPrice] = useState<number>(item?.unitAmount ?? cosmeticPriceFloor(type));
  const [quantity, setQuantity] = useState<number | undefined>(
    item?.availableQuantity ?? undefined
  );
  const [buzzType, setBuzzType] = useState<'yellow' | 'green' | 'blue'>('yellow');
  const [imageId, setImageId] = useState<string | null>(existingArtUrl(item));
  const [localUrl, setLocalUrl] = useState<string | null>(null);
  const [checks, setChecks] = useState<AutoCheck[]>([]);
  const [artReplaced, setArtReplaced] = useState(false);
  const [animated, setAnimated] = useState<boolean>(
    !!(item?.cosmetic?.data as { animated?: boolean } | null)?.animated
  );
  const [rightsAffirmed, setRightsAffirmed] = useState(false);
  const itemResale = (item?.meta ?? null) as {
    sellableByOthers?: boolean;
    sellerShare?: number;
  } | null;
  const itemSellableByOthers = !!itemResale?.sellableByOthers;
  const itemSellerShare = itemResale?.sellerShare ?? 0;
  const [sellableByOthers, setSellableByOthers] = useState(itemSellableByOthers);
  const [sellerShare, setSellerShare] = useState(itemSellerShare);
  const resaleChanged =
    sellableByOthers !== itemSellableByOthers ||
    // A share edit under a switched-off toggle is not a change: the server
    // stores 0 either way, so treating it as one would offer a pointless save.
    (sellableByOthers && sellerShare !== itemSellerShare);
  const itemAcceptsBlueBuzz = !!(item?.meta as { acceptsBlueBuzz?: boolean } | null)
    ?.acceptsBlueBuzz;
  const [acceptsBlueBuzz, setAcceptsBlueBuzz] = useState(itemAcceptsBlueBuzz);
  const acceptsBlueBuzzChanged = acceptsBlueBuzz !== itemAcceptsBlueBuzz;
  // Avatar-decoration fit adjustment (per side, -5..5); all-zero = none stored.
  const [offsets, setOffsetsState] = useState<CosmeticOffsets>(
    (item?.cosmetic?.data as { offsets?: CosmeticOffsets } | null)?.offsets ?? {
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    }
  );
  const setOffset = (side: keyof CosmeticOffsets, value: number) =>
    setOffsetsState((prev) => ({ ...prev, [side]: value }));

  // Buyers already own the art once an item is published or sold — lock it.
  const artLocked =
    isEdit && (item?.status === CosmeticShopItemStatus.Published || (item?.purchases ?? 0) > 0);
  const supportsAnimated =
    type === CosmeticType.Badge ||
    type === CosmeticType.ProfileDecoration ||
    type === CosmeticType.ProfileBackground ||
    type === CosmeticType.Sticker;

  // Mirrors the server's authoritative floor so a creator sees it before submit.
  const priceFloor = cosmeticPriceFloor(type);

  const isSticker = type === CosmeticType.Sticker;
  // Mirrors the server's rule verbatim (`isModerator || createdById === userId`,
  // creator-shop.service.ts). Named for what it decides rather than for who the
  // user is: the server has its own `isOriginalCreator` that counts moderators
  // as one, and two predicates sharing that name across the boundary is how the
  // client came to be stricter than the server — hiding fields from the very
  // people who repair stickers the v1 artwork bug damaged.
  //
  // A cross-lister is excluded because the server refuses their economics edits
  // outright; requiring the fields of them would disable their save over a field
  // they may not touch. Published is deliberately NOT part of this: the server
  // allows economics changes after publish, and a sticker predating per-use
  // pricing can only be repaired if someone can still reach the field.
  //
  // "No creator" reads as "not yours", which is what it means on the server:
  // `null === userId` is false there, so a cosmetic without a creator — an
  // official one — is refused. Treating a missing creator as permission would
  // demand a price the save then rejects.
  //
  // It gates the resale terms as well, which the server refuses from a
  // cross-lister on the same rule.
  const canEditOwnerFields =
    !isEdit || !!currentUser?.isModerator || item?.cosmetic?.createdById === currentUser?.id;
  const economicsEditable = isSticker && canEditOwnerFields;
  // Permission and obligation are different questions, and the server only ever
  // answered the first: a moderator MAY change another creator's economics, but
  // nothing says an unrelated edit should force them to invent values for a
  // sticker that isn't theirs — which on a cross-listing would rewrite the
  // original creator's top-up price for every buyer.
  const economicsRequired =
    economicsEditable && (!isEdit || item?.cosmetic?.createdById === currentUser?.id);
  // Consumables must clear a per-use floor as well as the listing floor.
  const usesFloor = isSticker && uses ? uses * STICKER_MIN_BUZZ_PER_USE : 0;
  // An unset economic field is an error the creator can see, not a field that
  // quietly stays unset. Stickers damaged by the v1 artwork-replace bug reach
  // this form with no `uses` at all, and they are exactly the ones that need
  // repairing here.
  const usesError = !isSticker
    ? null
    : uses === undefined
    ? economicsRequired
      ? 'Set how many uses a purchase grants'
      : null
    : // Grandfathered: a listing stored above the cap predates it, and the edit
    // path only sends `uses` when it changes — so refusing it here would block
    // an unrelated price edit over a value the creator isn't touching.
    uses > STICKER_MAX_USES && uses !== existingEconomics.uses
    ? `A purchase can grant at most ${STICKER_MAX_USES} uses`
    : price < usesFloor
    ? `${uses} uses needs at least ${usesFloor} Buzz (${STICKER_MIN_BUZZ_PER_USE} per use)`
    : null;
  // The top-up price a buyer pays when they run dry. Its floor is per-use, not
  // the listing floor — mirrors the server so the creator sees it before submit.
  const perUseFloor = stickerPerUseFloor(type);
  const pricePerUseError = !isSticker
    ? null
    : pricePerUse === undefined
    ? economicsRequired
      ? 'Set what one extra use costs'
      : null
    : pricePerUse < perUseFloor
    ? `A single use must cost at least ${perUseFloor} Buzz`
    : null;
  // Same normalization the server applies, so what's validated here is what's saved.
  const normalizedSlug = slug.trim().toLowerCase();
  // Matches the server rule: the slug is the token owners type, so it's fixed
  // once the sticker is live.
  const slugLocked = isEdit && item?.status === CosmeticShopItemStatus.Published;
  const slugFormatOk = isValidStickerSlug(normalizedSlug);
  const slugError =
    isSticker && normalizedSlug.length > 0 && !slugFormatOk ? STICKER_SLUG_ERROR : null;

  // Convenience only — it saves a creator filling in the whole form for a slug
  // someone else already has. The submit-time check and the partial unique index
  // are what actually decide; a slug can be claimed between this and the submit.
  const [debouncedSlug] = useDebouncedValue(normalizedSlug, 400);
  const slugCheckEnabled = isSticker && !slugLocked && isValidStickerSlug(debouncedSlug);
  const { data: slugCheck, isFetching: slugChecking } = trpc.creatorShop.checkStickerSlug.useQuery(
    { slug: debouncedSlug, excludeCosmeticId: item?.cosmetic?.id },
    { enabled: slugCheckEnabled }
  );
  const slugTaken = slugCheckEnabled && slugCheck?.available === false;
  const slugStatus: 'idle' | 'checking' | 'available' | 'taken' = !slugCheckEnabled
    ? 'idle'
    : slugChecking || debouncedSlug !== normalizedSlug
    ? 'checking'
    : slugTaken
    ? 'taken'
    : 'available';

  const fees = useCreatorShopFees();
  const { data: buzz } = useQueryBuzz(['yellow', 'green', 'blue']);
  const yellowBalance = buzz.accounts.find((a) => a.type === 'yellow')?.balance ?? 0;
  const greenBalance = buzz.accounts.find((a) => a.type === 'green')?.balance ?? 0;
  const blueBalance = buzz.accounts.find((a) => a.type === 'blue')?.balance ?? 0;
  const feeAccountBalance =
    buzzType === 'yellow' ? yellowBalance : buzzType === 'green' ? greenBalance : blueBalance;
  const submissionFee = fees?.submission[type];
  // Only new submissions pay the fee; edits don't. An unresolved fee blocks submit
  // rather than falling back to a default the server may disagree with.
  const canAffordFee =
    isEdit || (submissionFee !== undefined && feeAccountBalance >= submissionFee);

  const maxSize = constants.mediaUpload.maxImageFileSize;
  // Status-derived, not `progress`-derived — see `isUploadInFlight`. The `resetFiles()`
  // in `handleDrop`'s catch below was compensating for the old `progress < 100` spelling
  // latching on after a refused PUT; it is kept because it also lets the creator re-drop,
  // but this predicate no longer depends on it.
  const uploading = isUploadInFlight(files[0]);
  const allChecksPassed = checks.length > 0 && checks.every((c) => c.passed);
  // Existing art (edit, not replaced) is trusted; new art must pass its checks.
  const artOk = !!imageId && (isEdit && !artReplaced ? true : allChecksPassed);

  const clearArt = () => {
    if (localUrl) URL.revokeObjectURL(localUrl);
    setLocalUrl(null);
    setImageId(null);
    setChecks([]);
  };

  const setType = (next: CreatorCosmeticType) => {
    setTypeState(next);
    // Floors are per-type: a price valid for the old type can be below the new
    // one's. Harmless while every type is 500, wrong the moment they diverge.
    setPrice((current) => Math.max(current, cosmeticPriceFloor(next)));
    clearArt();
    setArtReplaced(true);
  };

  const handleDrop = async (dropped: File[]) => {
    const file = dropped[0];
    if (!file) return;
    setArtReplaced(true);
    // Show the selected image immediately — even if it fails the checks below.
    if (localUrl) URL.revokeObjectURL(localUrl);
    setLocalUrl(URL.createObjectURL(file));
    setImageId(null);
    const result = await validateCosmeticImage(file, type, maxSize);
    setChecks(result.checks);
    if (!result.allRequiredPassed) return;
    try {
      const uploaded = await uploadToCF(file, undefined, { allowAnimatedWebP: supportsAnimated });
      setAnimated(supportsAnimated && (await isAnimatedImage(file)));
      setImageId(uploaded.id);
    } catch (error) {
      // Clear the stuck tracked file so `uploading` flips back to false —
      // otherwise the preview spins forever and Replace stays disabled. Keeps
      // localUrl so the creator still sees their pick and can re-drop.
      resetFiles();
      const err = error instanceof Error ? error : new Error('Could not upload your artwork');
      // getDataFromFile already toasts its own preprocess failures (then returns
      // null → this generic throw), so don't double-notify for those.
      if (err.message !== 'Failed to process file before upload')
        showErrorNotification({ title: 'Upload failed', error: err });
    }
  };

  const handleReplace = () => {
    clearArt();
    setArtReplaced(true);
    resetFiles();
  };

  // Mirrors the server rule: a new submission always affirms, and an edit that
  // swaps the artwork re-affirms, since the stored record covers the art it was
  // made against.
  const requiresAffirmation = !isEdit || artReplaced;

  const canSubmit =
    artOk &&
    !!name.trim() &&
    price >= priceFloor &&
    canAffordFee &&
    (!requiresAffirmation || rightsAffirmed) &&
    (!isSticker || (slugFormatOk && !slugTaken && !usesError && !pricePerUseError));

  const isDecoration = type === CosmeticType.ProfileDecoration;
  const hasOffsets = Object.values(offsets).some((v) => v !== 0);
  // null clears a previously stored adjustment; undefined = nothing to store.
  const normalizedOffsets = isDecoration && hasOffsets ? offsets : null;
  const existingOffsets =
    (item?.cosmetic?.data as { offsets?: CosmeticOffsets } | null)?.offsets ?? null;
  const offsetsChanged =
    isDecoration && JSON.stringify(normalizedOffsets) !== JSON.stringify(existingOffsets);

  const handleSubmit = async () => {
    if (!canSubmit || !imageId) {
      showErrorNotification({
        title: 'Not ready',
        error: new Error(
          requiresAffirmation && !rightsAffirmed
            ? 'Confirm you have the rights to sell this artwork'
            : !isEdit && submissionFee === undefined
            ? FEE_UNAVAILABLE_MESSAGE
            : 'Add valid artwork, a title, and a price of at least 500 Buzz'
        ),
      });
      return;
    }
    try {
      if (isEdit && item) {
        // Only send fields that actually changed so a published item re-reviews
        // only on a real edit.
        const payload: UpdateCreatorShopItemInput = { id: item.id };
        if (name.trim() !== item.title) payload.name = name.trim();
        if ((description.trim() || null) !== (item.description ?? null))
          payload.description = description.trim() || null;
        if (price !== item.unitAmount) payload.price = price;
        if ((quantity ?? null) !== (item.availableQuantity ?? null))
          payload.availableQuantity = quantity ?? null;
        // The server re-validates and builds the cosmetic data from imageUrl.
        if (artReplaced) {
          payload.imageUrl = imageId;
          payload.animated = animated;
          payload.rightsAffirmed = true;
        }
        if (offsetsChanged) payload.offsets = normalizedOffsets;
        // Send the slug on any artwork swap too: the server rebuilds `data`
        // from scratch and would otherwise fall back to the stored value.
        if (
          isSticker &&
          (artReplaced ||
            normalizedSlug !== ((item.cosmetic?.data as { slug?: string } | null)?.slug ?? ''))
        )
          payload.slug = normalizedSlug;
        // The economics were editable in this form but never sent, so changing
        // them did nothing. Sent whenever the creator has a value that differs
        // from what's stored — `undefined` is unchosen and blocks submit, so a
        // value here was always chosen. Unlike the slug, the server carries the
        // stored economics through an artwork rebuild on its own, so an artwork
        // swap is not itself a reason to send them.
        if (isSticker && uses !== undefined && uses !== existingEconomics.uses) payload.uses = uses;
        if (isSticker && pricePerUse !== undefined && pricePerUse !== existingEconomics.pricePerUse)
          payload.pricePerUse = pricePerUse;
        if (acceptsBlueBuzzChanged) payload.acceptsBlueBuzz = acceptsBlueBuzz;
        if (resaleChanged) {
          payload.sellableByOthers = sellableByOthers;
          payload.sellerShare = sellableByOthers ? sellerShare : 0;
        }
        await updateItem.mutateAsync(payload);
      } else {
        if (submissionFee === undefined) {
          showErrorNotification({ title: 'Not ready', error: new Error(FEE_UNAVAILABLE_MESSAGE) });
          return;
        }
        await submitItem.mutateAsync({
          cosmeticType: type,
          name: name.trim(),
          description: description.trim() || null,
          imageUrl: imageId,
          animated,
          price,
          availableQuantity: quantity ?? null,
          buzzType,
          sellableByOthers,
          sellerShare: sellableByOthers ? sellerShare : 0,
          acceptsBlueBuzz,
          offsets: normalizedOffsets,
          slug: isSticker ? normalizedSlug : undefined,
          uses: isSticker ? uses : undefined,
          pricePerUse: isSticker ? pricePerUse : undefined,
          rightsAffirmed: true,
          quotedFee: submissionFee,
        });
      }
      resetFiles();
      onClose();
    } catch {
      // surfaced by the mutation hook
    }
  };

  const previewCosmetic = {
    id: item?.cosmetic?.id ?? 0,
    name: name || 'Preview',
    type,
    source: CosmeticSource.Purchase,
    description: description || null,
    data: imageId ? buildData(type, imageId, animated, normalizedOffsets, slug) : {},
  } as unknown as PreviewCosmetic;

  const earn = Math.floor(price * CREATOR_SHOP_CREATOR_SHARE);
  const notice = isEdit ? editNotice(item?.status) : null;
  const pending = isEdit ? updateItem.isPending : submitItem.isPending;

  return {
    isEdit,
    type,
    setType,
    priceFloor,
    isSticker,
    economicsEditable,
    economicsRequired,
    // The two economics fields are now mandatory input on a sticker that never
    // had them, so the discard guard has to know they changed — otherwise
    // Cancel throws away the value the form just insisted on, with no prompt.
    economicsChanged:
      uses !== existingEconomics.uses || pricePerUse !== existingEconomics.pricePerUse,
    uses,
    setUses,
    usesError,
    pricePerUse,
    setPricePerUse,
    pricePerUseError,
    perUseFloor,
    slug,
    setSlug,
    slugError,
    slugLocked,
    slugStatus,
    name,
    setName,
    description,
    setDescription,
    price,
    setPrice,
    quantity,
    setQuantity,
    buzzType,
    setBuzzType,
    animated,
    sellableByOthers,
    setSellableByOthers,
    sellerShare,
    setSellerShare,
    canEditOwnerFields,
    resaleChanged,
    // What existing resellers keep if the creator lowers the share — the whole
    // point of showing them the field on a live item.
    itemSellerShare,
    acceptsBlueBuzz,
    setAcceptsBlueBuzz,
    acceptsBlueBuzzChanged,
    rightsAffirmed,
    setRightsAffirmed,
    requiresAffirmation,
    offsets,
    setOffset,
    offsetsChanged,
    imageId,
    localUrl,
    checks,
    artLocked,
    supportsAnimated,
    maxSize,
    uploading,
    artOk,
    submissionFee,
    canAffordFee,
    canSubmit,
    yellowBalance,
    greenBalance,
    blueBalance,
    feeAccountBalance,
    earn,
    notice,
    pending,
    previewCosmetic,
    handleDrop,
    handleReplace,
    handleSubmit,
  };
}
