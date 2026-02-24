import type { Vendor, VendorRegistry } from './types';
import { kinguinVendor } from './kinguin';
import { buybuzzVendor } from './buybuzz';
import { waifuWayVendor } from './waifu-way';
import { lewtDropVendor } from './lewt-drop';
import { cryptoVendor } from './crypto';

const vendorRegistry: VendorRegistry = {
  kinguin: kinguinVendor,
  buybuzz: buybuzzVendor,
  'waifu-way': waifuWayVendor,
  'lewt-drop': lewtDropVendor,
  crypto: cryptoVendor,
};

export function getEnabledVendors(): Vendor[] {
  return Object.values(vendorRegistry).filter((vendor) => vendor.enabled);
}

export function getVendorById(id: string): Vendor | undefined {
  return vendorRegistry[id];
}

export function getDefaultVendor(): Vendor | undefined {
  const enabledVendors = getEnabledVendors();
  return enabledVendors[0];
}

export type {
  Vendor,
  VendorRegistry,
  BuzzCard,
  Membership,
  MembershipDuration,
  VendorProducts,
  VendorPromo,
} from './types';
