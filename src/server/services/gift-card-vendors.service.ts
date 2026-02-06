import { isFlipt, FLIPT_FEATURE_FLAGS } from '~/server/flipt/client';
import type { Vendor } from '~/utils/gift-cards/vendors';
import { kinguinVendor } from '~/utils/gift-cards/vendors/kinguin';
import { buybuzzVendor } from '~/utils/gift-cards/vendors/buybuzz';
import { waifuWayVendor } from '~/utils/gift-cards/vendors/waifu-way';
import { lewtDropVendor } from '~/utils/gift-cards/vendors/lewt-drop';

/**
 * Vendor configuration with optional Flipt flag for dynamic enablement.
 * Vendors with a fliptFlag will have their enabled state determined by Flipt.
 * Vendors without a fliptFlag use their static `enabled` property.
 */
const vendorConfigs: Array<{
  vendor: Vendor;
  fliptFlag?: FLIPT_FEATURE_FLAGS;
}> = [
  { vendor: kinguinVendor },
  { vendor: buybuzzVendor },
  { vendor: waifuWayVendor, fliptFlag: FLIPT_FEATURE_FLAGS.GIFT_CARD_VENDOR_WAIFU_WAY },
  { vendor: lewtDropVendor, fliptFlag: FLIPT_FEATURE_FLAGS.GIFT_CARD_VENDOR_LEWT_DROP },
];

/**
 * Get enabled vendors with Flipt flag evaluation for segmented rollout.
 *
 * @param userId - Optional user ID for per-user segmentation
 * @param context - Optional context for Flipt evaluation (e.g., user attributes)
 * @returns Array of enabled vendors
 */
export async function getEnabledVendorsServer(
  userId?: number,
  context: Record<string, string> = {}
): Promise<Vendor[]> {
  const enabledVendors: Vendor[] = [];

  for (const config of vendorConfigs) {
    let isEnabled: boolean;

    if (config.fliptFlag) {
      // Vendor uses Flipt flag for enablement
      isEnabled = await isFlipt(config.fliptFlag, userId?.toString() ?? 'anonymous', context);
    } else {
      // Vendor uses static enabled property
      isEnabled = config.vendor.enabled;
    }

    if (isEnabled) {
      enabledVendors.push(config.vendor);
    }
  }

  return enabledVendors;
}

/**
 * Get a vendor by ID, checking Flipt if applicable.
 *
 * @param vendorId - The vendor ID to look up
 * @param userId - Optional user ID for per-user segmentation
 * @param context - Optional context for Flipt evaluation
 * @returns The vendor if found and enabled, undefined otherwise
 */
export async function getVendorByIdServer(
  vendorId: string,
  userId?: number,
  context: Record<string, string> = {}
): Promise<Vendor | undefined> {
  const config = vendorConfigs.find((c) => c.vendor.id === vendorId);
  if (!config) return undefined;

  let isEnabled: boolean;

  if (config.fliptFlag) {
    isEnabled = await isFlipt(config.fliptFlag, userId?.toString() ?? 'anonymous', context);
  } else {
    isEnabled = config.vendor.enabled;
  }

  return isEnabled ? config.vendor : undefined;
}

/**
 * Get the default vendor (first enabled vendor).
 */
export async function getDefaultVendorServer(
  userId?: number,
  context: Record<string, string> = {}
): Promise<Vendor | undefined> {
  const enabledVendors = await getEnabledVendorsServer(userId, context);
  return enabledVendors[0];
}
