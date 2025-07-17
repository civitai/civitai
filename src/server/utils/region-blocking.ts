/**
 * Utility functions for region blocking
 */

import type { IncomingMessage } from 'http';
import type { NextApiRequest } from 'next';
import type { NextRequest } from 'next/server';

export type RegionInfo = {
  countryCode: string | null;
  regionCode?: string | null;
  fullLocationCode: string | null;
};

// Default restricted regions based on ISO country codes
const DEFAULT_RESTRICTED_REGIONS = ['GB', 'UK'];

// Get restricted regions from environment variable or use default
export const RESTRICTED_REGIONS = process.env.RESTRICTED_REGIONS
  ? process.env.RESTRICTED_REGIONS.split(',').map((region) => region.trim().toUpperCase())
  : DEFAULT_RESTRICTED_REGIONS;

/**
 * Check if a country code is in the restricted regions list
 */
export function isRegionBlocked(countryCode: string | null): boolean {
  if (!countryCode) return false;
  return RESTRICTED_REGIONS.includes(countryCode.toUpperCase());
}

/**
 * Check if a country code should allow API access
 * Currently, we block API access for the same regions as web access
 */
export function isAPIAccessBlocked(countryCode: string | null): boolean {
  return isRegionBlocked(countryCode);
}

/**
 * Get region information from request headers
 */
export function getRegion(req: NextRequest | NextApiRequest | IncomingMessage) {
  const countryCode =
    req.headers instanceof Headers
      ? req.headers.get('cf-ipcountry')
      : (req.headers['cf-ipcountry'] as string | null);
  const regionCode =
    req.headers instanceof Headers
      ? req.headers.get('cf-region-code')
      : (req.headers['cf-region-code'] as string | null);

  return {
    countryCode,
    regionCode,
    fullLocationCode: countryCode && regionCode ? `${countryCode}:${regionCode}` : countryCode,
  };
}
