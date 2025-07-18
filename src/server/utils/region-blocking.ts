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

export type RegionBlockConfig = {
  region: string;
  effectiveDate: string; // ISO date string
};

// Default restricted regions based on ISO country codes
const DEFAULT_RESTRICTED_REGIONS = ['GB', 'UK'];

// Get restricted regions from environment variable or use default
export const RESTRICTED_REGIONS = process.env.RESTRICTED_REGIONS
  ? process.env.RESTRICTED_REGIONS.split(',').map((region) => region.trim().toUpperCase())
  : DEFAULT_RESTRICTED_REGIONS;

// Region block configurations with effective dates
// Format: "REGION:YYYY-MM-DD,REGION:YYYY-MM-DD" or "COUNTRY:STATE:YYYY-MM-DD"
// Example: "GB:2025-07-24,FR:2025-08-01,US:CA:2025-07-24"
const DEFAULT_REGION_BLOCK_CONFIG: RegionBlockConfig[] = [
  { region: 'GB', effectiveDate: '2025-07-24' },
  { region: 'UK', effectiveDate: '2025-07-24' },
];

export const REGION_BLOCK_CONFIG: RegionBlockConfig[] = process.env.REGION_BLOCK_CONFIG
  ? process.env.REGION_BLOCK_CONFIG.split(',').map((config) => {
      const trimmedConfig = config.trim();
      // Handle US state format: US:CA:2025-07-24
      // Find the last colon which should separate the date
      const lastColonIndex = trimmedConfig.lastIndexOf(':');
      if (lastColonIndex === -1) {
        throw new Error(`Invalid region block config format: ${trimmedConfig}`);
      }

      const region = trimmedConfig.substring(0, lastColonIndex).toUpperCase();
      const effectiveDate = trimmedConfig.substring(lastColonIndex + 1);

      return { region, effectiveDate };
    })
  : DEFAULT_REGION_BLOCK_CONFIG;

/**
 * Check if a region is currently blocked based on effective date
 */
export function isRegionBlocked(region: RegionInfo, currentDate: Date = new Date()): boolean {
  const { countryCode, fullLocationCode = '' } = region;
  if (!countryCode || !fullLocationCode) return false;

  const regionToCheck =
    countryCode === 'US' ? fullLocationCode.toUpperCase() : countryCode.toUpperCase();

  // Find matching region block config
  const blockConfig = REGION_BLOCK_CONFIG.find((config) => config.region === regionToCheck);

  if (!blockConfig) return false;

  // Check if the effective date has passed
  const effectiveDate = new Date(blockConfig.effectiveDate + 'T23:59:59.999Z'); // End of day UTC
  return currentDate >= effectiveDate;
}

/**
 * Check if a region will be blocked in the future
 */
export function isRegionPendingBlock(region: RegionInfo, currentDate: Date = new Date()): boolean {
  const { countryCode, fullLocationCode = '' } = region;
  if (!countryCode || !fullLocationCode) return false;

  const regionToCheck =
    countryCode === 'US' ? fullLocationCode.toUpperCase() : countryCode.toUpperCase();

  // Find matching region block config
  const blockConfig = REGION_BLOCK_CONFIG.find((config) => config.region === regionToCheck);

  if (!blockConfig) return false;

  // Check if the effective date is in the future
  const effectiveDate = new Date(blockConfig.effectiveDate + 'T23:59:59.999Z'); // End of day UTC
  return currentDate < effectiveDate;
}

/**
 * Get the effective date for a region block
 */
export function getRegionBlockDate(region: RegionInfo): Date | null {
  const { countryCode, fullLocationCode = '' } = region;
  if (!countryCode || !fullLocationCode) return null;

  const regionToCheck =
    countryCode === 'US' ? fullLocationCode.toUpperCase() : countryCode.toUpperCase();

  // Find matching region block config
  const blockConfig = REGION_BLOCK_CONFIG.find((config) => config.region === regionToCheck);

  if (!blockConfig) return null;

  return new Date(blockConfig.effectiveDate + 'T23:59:59.999Z'); // End of day UTC
}

/**
 * Get days remaining until a region will be blocked
 */
export function getDaysUntilRegionBlock(
  region: RegionInfo,
  currentDate: Date = new Date()
): number | null {
  const blockDate = getRegionBlockDate(region);
  if (!blockDate) return null;

  const timeDiff = blockDate.getTime() - currentDate.getTime();
  const daysDiff = Math.ceil(timeDiff / (1000 * 3600 * 24));

  return daysDiff > 0 ? daysDiff : null;
}

/**
 * Check if a country code should allow API access
 * Currently, we block API access for the same regions as web access
 */
export function isAPIAccessBlocked(region: RegionInfo): boolean {
  return isRegionBlocked(region);
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
