import * as z from 'zod';

/** One strip in the nav announcement slot, as the server resolved it for this viewer. */
export type NavBanner = {
  // Stable per source, e.g. `event:birthday2026`. The dismiss cookie stores it.
  id: string;
  title: string;
  // Drawn after the title in a highlight colour.
  accent?: string;
  // Hidden on phones.
  text?: string;
  href: string;
  // Desktop only; on phones the whole strip is the link.
  cta?: string;
  // CDN image id, anchored right behind the copy.
  image?: string;
  // Fills the strip where the image does not reach. Match the image's left edge.
  background?: string;
  dismissible: boolean;
  priority: number;
};

export const NAV_BANNERS_DISMISSED_COOKIE = 'nav-banners-dismissed';
export const NAV_BANNERS_DISMISSED_MAX = 20;

const dismissedSchema = z.array(z.string().max(100)).max(100);

/**
 * The dismissed banner ids in the cookie. `_app` parses it on the server and hands it down, so the
 * server render and the first client paint filter the same entries. Anything malformed reads as
 * nothing dismissed.
 */
export function parseNavBannersDismissed(raw: string | undefined | null): string[] {
  if (!raw) return [];
  try {
    const parsed = dismissedSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.slice(-NAV_BANNERS_DISMISSED_MAX) : [];
  } catch {
    return [];
  }
}

/** Adds an id, keeping the newest `NAV_BANNERS_DISMISSED_MAX` so the cookie stays small. */
export function addNavBannerDismissed(current: string[], id: string): string[] {
  return [...current.filter((x) => x !== id), id].slice(-NAV_BANNERS_DISMISSED_MAX);
}
