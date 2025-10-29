import type { Vendor, VendorDiscount } from './vendors/types';

export interface DiscountInfo {
  isActive: boolean;
  percentage: number;
  title?: string;
  description?: string;
}

/**
 * Checks if a discount is currently active based on the date range
 */
export function isDiscountActive(startDate: Date, endDate: Date): boolean {
  const now = new Date();
  return now >= startDate && now <= endDate;
}

/**
 * Gets discount information for a vendor
 */
export function getVendorDiscount(vendor: Vendor): DiscountInfo {
  if (!vendor.discount) {
    return {
      isActive: false,
      percentage: 0,
    };
  }

  const isActive = isDiscountActive(vendor.discount.startDate, vendor.discount.endDate);

  return {
    isActive,
    percentage: vendor.discount.percentage,
    title: vendor.discount.title,
    description: vendor.discount.description,
  };
}
