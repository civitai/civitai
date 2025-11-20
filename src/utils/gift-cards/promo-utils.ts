import type { VendorPromo } from './vendors/types';

export function isPromoActive(promo: VendorPromo | undefined): boolean {
  if (!promo) return false;

  const now = new Date();
  const startDate = new Date(promo.startDate);
  const endDate = new Date(promo.endDate);

  return now >= startDate && now <= endDate;
}

function getPromoDismissalKey(vendorId: string, promoCode: string): string {
  return `promo_dismissed_${vendorId}_${promoCode}`;
}

export function isPromoDismissed(vendorId: string, promoCode: string): boolean {
  if (typeof window === 'undefined') return false;

  const key = getPromoDismissalKey(vendorId, promoCode);
  const dismissedUntil = localStorage.getItem(key);

  if (!dismissedUntil) return false;

  const dismissedDate = new Date(dismissedUntil);
  const now = new Date();

  return now < dismissedDate;
}

export function dismissPromo(vendorId: string, promo: VendorPromo): void {
  if (typeof window === 'undefined') return;

  const key = getPromoDismissalKey(vendorId, promo.code);
  const endDate = new Date(promo.endDate);

  localStorage.setItem(key, endDate.toISOString());
}
