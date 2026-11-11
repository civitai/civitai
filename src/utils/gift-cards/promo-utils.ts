import type { VendorPromo } from './vendors/types';

export function isPromoActive(promo: VendorPromo | undefined): boolean {
  if (!promo) return false;

  const now = new Date();
  const startDate = new Date(promo.startDate);
  const endDate = new Date(promo.endDate);

  return now >= startDate && now <= endDate;
}

function getPromoKey(promo: VendorPromo): string {
  // Use code if available, otherwise use a hash of the message
  return promo.code || promo.message.slice(0, 20).replace(/\s+/g, '_');
}

function getPromoDismissalKey(vendorId: string, promo: VendorPromo): string {
  return `promo_dismissed_${vendorId}_${getPromoKey(promo)}`;
}

export function isPromoDismissed(vendorId: string, promo: VendorPromo): boolean {
  if (typeof window === 'undefined') return false;

  const key = getPromoDismissalKey(vendorId, promo);
  const dismissedUntil = localStorage.getItem(key);

  if (!dismissedUntil) return false;

  const dismissedDate = new Date(dismissedUntil);
  const now = new Date();

  return now < dismissedDate;
}

export function dismissPromo(vendorId: string, promo: VendorPromo): void {
  if (typeof window === 'undefined') return;

  const key = getPromoDismissalKey(vendorId, promo);
  const endDate = new Date(promo.endDate);

  localStorage.setItem(key, endDate.toISOString());
}
