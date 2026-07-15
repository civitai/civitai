import type { ComponentProps } from 'react';
import { CosmeticPreview } from '~/components/CosmeticShop/CosmeticPreview';
import type { CreatorShopManageItem } from '~/components/CreatorShop/creator-shop.util';
import type { AutoCheck } from '~/server/schema/creator-shop.schema';
import {
  cosmeticDimensionsLabel,
  cosmeticImageRequirements,
} from '~/server/schema/creator-shop.schema';
import { CosmeticShopItemStatus, CosmeticType, MediaType } from '~/shared/utils/prisma/enums';
import { formatBytes } from '~/utils/number-helpers';

export type PreviewCosmetic = ComponentProps<typeof CosmeticPreview>['cosmetic'];

export const buildData = (type: CosmeticType, imageId: string, animated: boolean) => {
  if (type === CosmeticType.Badge || type === CosmeticType.ProfileDecoration)
    return { url: imageId, animated };
  if (type === CosmeticType.ProfileBackground)
    return { url: imageId, type: MediaType.image, animated };
  return { url: imageId };
};

export const existingArtUrl = (item?: CreatorShopManageItem) =>
  (item?.cosmetic.data as { url?: string } | null)?.url ?? null;

export const editNotice = (status?: CosmeticShopItemStatus) => {
  if (status === CosmeticShopItemStatus.Published)
    return 'Changes are re-reviewed before they go live. The item stays published until approved.';
  if (status === CosmeticShopItemStatus.Rejected)
    return 'Saving resubmits this item for review with your changes.';
  if (status === CosmeticShopItemStatus.PendingReview)
    return 'This item is already in review — your changes update the pending submission.';
  return null;
};

// The checks a submission must pass, rendered neutral (as up-front requirements)
// before an image is chosen. Labels mirror `validateCosmeticImage` so the list is
// stable before/after upload.
export function requirementRows(type: CosmeticType, maxSize: number): AutoCheck[] {
  const req = cosmeticImageRequirements(type);
  const rows: AutoCheck[] = [
    { key: 'format', label: 'PNG or WebP', passed: false },
    { key: 'dimensions', label: cosmeticDimensionsLabel(req), passed: false },
  ];
  if (req.requireTransparency)
    rows.push({ key: 'transparency', label: 'Transparent background', passed: false });
  rows.push({ key: 'size', label: `Under ${formatBytes(maxSize)}`, passed: false });
  return rows;
}
