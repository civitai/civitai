/**
 * Utility functions for region blocking and restriction
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

// Region block configurations with effective dates
// Format: "REGION:YYYY-MM-DD,REGION:YYYY-MM-DD" or "COUNTRY:STATE:YYYY-MM-DD"
// Example: "GB:2025-07-24,FR:2025-08-01,US:CA:2025-07-24"
const DEFAULT_REGION_BLOCK_CONFIG: RegionBlockConfig[] = [
  { region: 'GB', effectiveDate: '2025-07-24' },
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

// Region restriction configurations with effective dates
// Format: same as block config - "REGION:YYYY-MM-DD,REGION:YYYY-MM-DD" or "COUNTRY:STATE:YYYY-MM-DD"
// Example: "FR:2025-08-01,DE:2025-09-01,US:NY:2025-07-24"
const DEFAULT_REGION_RESTRICTION_CONFIG: RegionBlockConfig[] = [
  { region: 'FR', effectiveDate: '2025-08-01' },
  { region: 'DE', effectiveDate: '2025-08-01' },
];

export const REGION_RESTRICTION_CONFIG: RegionBlockConfig[] = process.env.REGION_RESTRICTION_CONFIG
  ? process.env.REGION_RESTRICTION_CONFIG.split(',').map((config) => {
      const trimmedConfig = config.trim();
      // Handle US state format: US:NY:2025-07-24
      // Find the last colon which should separate the date
      const lastColonIndex = trimmedConfig.lastIndexOf(':');
      if (lastColonIndex === -1) {
        throw new Error(`Invalid region restriction config format: ${trimmedConfig}`);
      }

      const region = trimmedConfig.substring(0, lastColonIndex).toUpperCase();
      const effectiveDate = trimmedConfig.substring(lastColonIndex + 1);

      return { region, effectiveDate };
    })
  : DEFAULT_REGION_RESTRICTION_CONFIG;

/**
 * Generic helper to check if a region matches a config and meets date criteria
 */
function checkRegionStatus(
  region: RegionInfo,
  config: RegionBlockConfig[],
  dateComparison: 'past' | 'future',
  currentDate: Date = new Date()
): boolean {
  const effectiveDate = getRegionEffectiveDate(region, config);
  if (!effectiveDate) return false;

  if (dateComparison === 'past') {
    return currentDate >= effectiveDate; // Date has passed
  } else {
    return currentDate < effectiveDate; // Date is in the future
  }
}

/**
 * Check if a region is currently blocked based on effective date
 */
export function isRegionBlocked(region: RegionInfo, currentDate: Date = new Date()): boolean {
  return checkRegionStatus(region, REGION_BLOCK_CONFIG, 'past', currentDate);
}

/**
 * Check if a region is currently restricted (limited features) based on effective date
 */
export function isRegionRestricted(region: RegionInfo, currentDate: Date = new Date()): boolean {
  return checkRegionStatus(region, REGION_RESTRICTION_CONFIG, 'past', currentDate);
}

/**
 * Check if a region will be blocked in the future
 */
export function isRegionPendingBlock(region: RegionInfo, currentDate: Date = new Date()): boolean {
  return checkRegionStatus(region, REGION_BLOCK_CONFIG, 'future', currentDate);
}

/**
 * Check if a region will be restricted in the future
 */
export function isRegionPendingRestriction(
  region: RegionInfo,
  currentDate: Date = new Date()
): boolean {
  return checkRegionStatus(region, REGION_RESTRICTION_CONFIG, 'future', currentDate);
}

/**
 * Generic helper to get effective date for a region from a config array
 */
function getRegionEffectiveDate(region: RegionInfo, config: RegionBlockConfig[]): Date | null {
  const { countryCode = '', fullLocationCode = '' } = region || {};
  if (!countryCode || !fullLocationCode) return null;

  const regionToCheck =
    countryCode === 'US' ? fullLocationCode.toUpperCase() : countryCode.toUpperCase();

  // Find matching region config
  const regionConfig = config.find((configItem) => configItem.region === regionToCheck);
  if (!regionConfig) return null;

  return new Date(regionConfig.effectiveDate + 'T23:59:59.999Z'); // End of day UTC
}

/**
 * Get the effective date for a region block
 */
export function getRegionBlockDate(region: RegionInfo): Date | null {
  return getRegionEffectiveDate(region, REGION_BLOCK_CONFIG);
}

/**
 * Get the effective date for a region restriction
 */
export function getRegionRestrictionDate(region: RegionInfo): Date | null {
  return getRegionEffectiveDate(region, REGION_RESTRICTION_CONFIG);
}

/**
 * Generic helper to calculate days remaining until a specific date
 */
function getDaysUntilDate(targetDate: Date | null, currentDate: Date = new Date()): number | null {
  if (!targetDate) return null;

  const timeDiff = targetDate.getTime() - currentDate.getTime();
  const daysDiff = Math.ceil(timeDiff / (1000 * 3600 * 24));

  return daysDiff > 0 ? daysDiff : null;
}

/**
 * Get days remaining until a region will be blocked
 */
export function getDaysUntilRegionBlock(
  region: RegionInfo,
  currentDate: Date = new Date()
): number | null {
  const blockDate = getRegionBlockDate(region);
  return getDaysUntilDate(blockDate, currentDate);
}

/**
 * Get days remaining until a region will be restricted
 */
export function getDaysUntilRegionRestriction(
  region: RegionInfo,
  currentDate: Date = new Date()
): number | null {
  const restrictionDate = getRegionRestrictionDate(region);
  return getDaysUntilDate(restrictionDate, currentDate);
}

/**
 * Check if a country code should allow API access
 * Currently, we block API access for the same regions as web access
 */
export function isAPIAccessBlocked(region: RegionInfo): boolean {
  return isRegionBlocked(region);
}

/**
 * Check if a country code should have restricted API access
 * Currently, we restrict API access for the same regions as web access
 */
export function isAPIAccessRestricted(region: RegionInfo): boolean {
  return isRegionRestricted(region);
}

/**
 * Get region information from request headers
 */
export function getRegion(req: NextRequest | NextApiRequest | IncomingMessage) {
  let countryCode =
    req.headers instanceof Headers
      ? req.headers.get('cf-ipcountry')
      : (req.headers['cf-ipcountry'] as string | null);
  const regionCode =
    req.headers instanceof Headers
      ? req.headers.get('cf-region-code')
      : (req.headers['cf-region-code'] as string | null);
  const isUKHeader =
    req.headers instanceof Headers
      ? req.headers.get('x-isuk')
      : (req.headers['x-isuk'] as string | null);

  // Override countryCode to GB if x-isuk header is present
  if (isUKHeader === 'true' || isUKHeader === '1') {
    countryCode = 'GB';
  }

  return {
    countryCode,
    regionCode,
    fullLocationCode: countryCode && regionCode ? `${countryCode}:${regionCode}` : countryCode,
  };
}
