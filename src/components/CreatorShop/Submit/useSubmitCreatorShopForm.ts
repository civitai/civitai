import { useState } from 'react';
import { useQueryBuzz } from '~/components/Buzz/useBuzz';
import type { CreatorShopManageItem } from '~/components/CreatorShop/creator-shop.util';
import { useMutateCreatorShop } from '~/components/CreatorShop/creator-shop.util';
import { validateCosmeticImage } from '~/components/CreatorShop/creator-shop.validation';
import {
  buildData,
  editNotice,
  existingArtUrl,
  type PreviewCosmetic,
} from '~/components/CreatorShop/Submit/submit.util';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import { constants } from '~/server/common/constants';
import type {
  AutoCheck,
  CosmeticOffsets,
  UpdateCreatorShopItemInput,
} from '~/server/schema/creator-shop.schema';
import {
  COSMETIC_PRICE_FLOOR,
  CREATOR_SHOP_CREATOR_SHARE,
  CREATOR_SHOP_SUBMISSION_FEE,
} from '~/server/schema/creator-shop.schema';
import { CosmeticShopItemStatus, CosmeticSource, CosmeticType } from '~/shared/utils/prisma/enums';
import { isAnimatedImage } from '~/utils/media-preprocessors/image.preprocessor';
import { showErrorNotification } from '~/utils/notifications';

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
  const { submitItem, updateItem } = useMutateCreatorShop();
  const { uploadToCF, files, resetFiles } = useCFImageUpload();

  const [type, setTypeState] = useState<CosmeticType>(item?.cosmetic.type ?? CosmeticType.Badge);
  const [name, setName] = useState(item?.title ?? '');
  const [description, setDescription] = useState(item?.description ?? '');
  const [price, setPrice] = useState<number>(item?.unitAmount ?? COSMETIC_PRICE_FLOOR);
  const [quantity, setQuantity] = useState<number | undefined>(
    item?.availableQuantity ?? undefined
  );
  const [buzzType, setBuzzType] = useState<'yellow' | 'green' | 'blue'>('yellow');
  const [imageId, setImageId] = useState<string | null>(existingArtUrl(item));
  const [localUrl, setLocalUrl] = useState<string | null>(null);
  const [checks, setChecks] = useState<AutoCheck[]>([]);
  const [artReplaced, setArtReplaced] = useState(false);
  const [animated, setAnimated] = useState<boolean>(
    !!(item?.cosmetic.data as { animated?: boolean } | null)?.animated
  );
  const [sellableByOthers, setSellableByOthers] = useState(false);
  const [sellerShare, setSellerShare] = useState(0);
  // Avatar-decoration fit adjustment (per side, -5..5); all-zero = none stored.
  const [offsets, setOffsetsState] = useState<CosmeticOffsets>(
    (item?.cosmetic.data as { offsets?: CosmeticOffsets } | null)?.offsets ?? {
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
    type === CosmeticType.ProfileBackground;

  const { data: buzz } = useQueryBuzz(['yellow', 'green', 'blue']);
  const yellowBalance = buzz.accounts.find((a) => a.type === 'yellow')?.balance ?? 0;
  const greenBalance = buzz.accounts.find((a) => a.type === 'green')?.balance ?? 0;
  const blueBalance = buzz.accounts.find((a) => a.type === 'blue')?.balance ?? 0;
  const feeAccountBalance =
    buzzType === 'yellow' ? yellowBalance : buzzType === 'green' ? greenBalance : blueBalance;
  // Only new submissions pay the fee; edits don't.
  const canAffordFee = isEdit || feeAccountBalance >= CREATOR_SHOP_SUBMISSION_FEE;

  const maxSize = constants.mediaUpload.maxImageFileSize;
  const uploading = !!files[0] && files[0].progress < 100;
  const allChecksPassed = checks.length > 0 && checks.every((c) => c.passed);
  // Existing art (edit, not replaced) is trusted; new art must pass its checks.
  const artOk = !!imageId && (isEdit && !artReplaced ? true : allChecksPassed);

  const clearArt = () => {
    if (localUrl) URL.revokeObjectURL(localUrl);
    setLocalUrl(null);
    setImageId(null);
    setChecks([]);
  };

  const setType = (next: CosmeticType) => {
    setTypeState(next);
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

  const canSubmit = artOk && !!name.trim() && price >= COSMETIC_PRICE_FLOOR && canAffordFee;

  const isDecoration = type === CosmeticType.ProfileDecoration;
  const hasOffsets = Object.values(offsets).some((v) => v !== 0);
  // null clears a previously stored adjustment; undefined = nothing to store.
  const normalizedOffsets = isDecoration && hasOffsets ? offsets : null;
  const existingOffsets =
    (item?.cosmetic.data as { offsets?: CosmeticOffsets } | null)?.offsets ?? null;
  const offsetsChanged =
    isDecoration && JSON.stringify(normalizedOffsets) !== JSON.stringify(existingOffsets);

  const handleSubmit = async () => {
    if (!canSubmit || !imageId) {
      showErrorNotification({
        title: 'Not ready',
        error: new Error('Add valid artwork, a title, and a price of at least 500 Buzz'),
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
        }
        if (offsetsChanged) payload.offsets = normalizedOffsets;
        await updateItem.mutateAsync(payload);
      } else {
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
          offsets: normalizedOffsets,
        });
      }
      resetFiles();
      onClose();
    } catch {
      // surfaced by the mutation hook
    }
  };

  const previewCosmetic = {
    id: item?.cosmetic.id ?? 0,
    name: name || 'Preview',
    type,
    source: CosmeticSource.Purchase,
    description: description || null,
    data: imageId ? buildData(type, imageId, animated, normalizedOffsets) : {},
  } as unknown as PreviewCosmetic;

  const earn = Math.floor(price * CREATOR_SHOP_CREATOR_SHARE);
  const notice = isEdit ? editNotice(item?.status) : null;
  const pending = isEdit ? updateItem.isPending : submitItem.isPending;

  return {
    isEdit,
    type,
    setType,
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
