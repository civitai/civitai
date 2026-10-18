import type { ComponentType } from 'react';
import { InventoryBoxes } from '~/components/Inventory/InventoryBoxes';
import {
  InventoryAvatarDecorations,
  InventoryBackgrounds,
  InventoryBadges,
  InventoryCardGlows,
  InventoryFrames,
  InventoryNameplates,
  InventoryStickers,
} from '~/components/Inventory/InventoryCosmetics';
import { InventoryHats } from '~/components/Inventory/InventoryHats';
import type { InventoryTypeKey } from '~/components/Inventory/inventory-types';

export const INVENTORY_PAGES: Record<InventoryTypeKey, ComponentType> = {
  boxes: InventoryBoxes,
  hats: InventoryHats,
  badges: InventoryBadges,
  'avatar-decorations': InventoryAvatarDecorations,
  nameplates: InventoryNameplates,
  backgrounds: InventoryBackgrounds,
  'card-glows': InventoryCardGlows,
  frames: InventoryFrames,
  stickers: InventoryStickers,
};
