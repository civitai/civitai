import type { ComponentType } from 'react';
import { InventoryBoxes } from '~/components/Inventory/InventoryBoxes';
import type { InventoryTypeKey } from '~/components/Inventory/inventory-types';

export const INVENTORY_PAGES: Record<InventoryTypeKey, ComponentType> = {
  boxes: InventoryBoxes,
};
