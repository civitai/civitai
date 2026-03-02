import type { SessionUser } from 'next-auth';
import { isFlipt, FLIPT_FEATURE_FLAGS } from '~/server/flipt/client';
import { buildFliptContext } from '~/server/services/feature-flags.service';
import type { Vendor } from '~/utils/gift-cards/vendors';
import { kinguinVendor } from '~/utils/gift-cards/vendors/kinguin';
import { buybuzzVendor } from '~/utils/gift-cards/vendors/buybuzz';
import { waifuWayVendor } from '~/utils/gift-cards/vendors/waifu-way';
import { lewtDropVendor } from '~/utils/gift-cards/vendors/lewt-drop';
import { royalCdKeysVendor } from '~/utils/gift-cards/vendors/royal-cd-keys';
import { cryptoVendor } from '~/utils/gift-cards/vendors/crypto';

/**
 * Vendor configuration with optional Flipt flag for dynamic enablement.
 * Vendors with a fliptFlag will have their enabled state determined by Flipt.
 * Vendors without a fliptFlag use their static `enabled` property.
 */
const vendorConfigs: Array<{
  vendor: Vendor;
  fliptFlag?: FLIPT_FEATURE_FLAGS;
}> = [
  { vendor: cryptoVendor, fliptFlag: FLIPT_FEATURE_FLAGS.GIFT_CARD_VENDOR_CRYPTO },
  { vendor: kinguinVendor },
  { vendor: buybuzzVendor },
  { vendor: waifuWayVendor, fliptFlag: FLIPT_FEATURE_FLAGS.GIFT_CARD_VENDOR_WAIFU_WAY },
  { vendor: lewtDropVendor, fliptFlag: FLIPT_FEATURE_FLAGS.GIFT_CARD_VENDOR_LEWT_DROP },
  { vendor: royalCdKeysVendor, fliptFlag: FLIPT_FEATURE_FLAGS.GIFT_CARD_VENDOR_ROYAL_CD_KEYS },
];

/**
 * Get enabled vendors with Flipt flag evaluation for segmented rollout.
 *
 * @param user - Optional session user for Flipt context (isModerator, tier, etc.)
 * @returns Array of enabled vendors
 */
export async function getEnabledVendorsServer(user?: SessionUser): Promise<Vendor[]> {
  const context = buildFliptContext(user);
  const entityId = user?.id?.toString() ?? 'anonymous';
  const enabledVendors: Vendor[] = [];

  for (const config of vendorConfigs) {
    let isEnabled: boolean;

    if (config.fliptFlag) {
      isEnabled = await isFlipt(config.fliptFlag, entityId, context);
    } else {
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
 * @param user - Optional session user for Flipt context
 * @returns The vendor if found and enabled, undefined otherwise
 */
export async function getVendorByIdServer(
  vendorId: string,
  user?: SessionUser
): Promise<Vendor | undefined> {
  const context = buildFliptContext(user);
  const entityId = user?.id?.toString() ?? 'anonymous';
  const config = vendorConfigs.find((c) => c.vendor.id === vendorId);
  if (!config) return undefined;

  let isEnabled: boolean;

  if (config.fliptFlag) {
    isEnabled = await isFlipt(config.fliptFlag, entityId, context);
  } else {
    isEnabled = config.vendor.enabled;
  }

  return isEnabled ? config.vendor : undefined;
}

/**
 * Get the default vendor (first enabled vendor).
 */
export async function getDefaultVendorServer(user?: SessionUser): Promise<Vendor | undefined> {
  const enabledVendors = await getEnabledVendorsServer(user);
  return enabledVendors[0];
}
