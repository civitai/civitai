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
  // Optional so a page rendered before this field existed still reads the answer.
  promo?: EventPromo;
};

export const EVENT_PROMO_ICONS = ['confetti', 'trophy', 'sparkles'] as const;
export type EventPromoIcon = (typeof EVENT_PROMO_ICONS)[number];

export type EditorCardPromo = { title: string; body: string; draftNote?: string; image?: string };

/**
 * An event's entry points beyond its strip. Never filtered by the strip's dismissal: it is how a
 * viewer who closed the strip gets back to the event.
 */
export type EventPromo = {
  event: string;
  menuLabel: string;
  menuIcon: EventPromoIcon;
  // Only for events with a team roster page.
  teamHref?: string;
  postEditor?: EditorCardPromo;
  articleEditor?: EditorCardPromo;
  modelEditor?: EditorCardPromo;
  homeBlock?: { eyebrow?: string; title: string; body?: string; cta?: string };
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
