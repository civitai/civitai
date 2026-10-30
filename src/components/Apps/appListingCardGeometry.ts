/**
 * The geometry of an App Store listing card, in one place so the real card
 * (`AppListingCard`) and its loading skeleton (`AppListingCardSkeleton`) cannot
 * disagree about a number.
 *
 * 🔴 The skeleton must reserve EXACTLY the geometry the card occupies, or the grid
 * reflows when the query resolves. Both files READ these constants; neither spells
 * a value. `__tests__/appListingCardView.test.ts` enumerates this module's exports
 * and requires the card to read every one, so an unread constant cannot linger.
 *
 * Card A: the icon straddles the cover's bottom edge,
 * the title and the Open button are centred on the ICON's centre, and a footer row
 * (reviews/plays left, creator right) sits under a divider.
 */

/**
 * Cover ratio. A RATIO rather than a fixed height: it scales with the grid column
 * while still deriving the box height from the known column width BEFORE any image
 * bytes arrive, which is what keeps the card CLS-free.
 */
export const LISTING_CARD_COVER_ASPECT_RATIO = '16 / 9';

/** The publisher icon's edge length. */
export const LISTING_CARD_ICON_SIZE_PX = 56;

/** How far the icon is pulled up over the cover's bottom edge. */
export const LISTING_CARD_ICON_OVERLAP_PX = 14;

/**
 * The icon's vertical centre, measured from the top of the header row (the row
 * starts at the cover's bottom edge). The title and the CTA are centred on THIS, not
 * on the row, so they line up with the icon whatever their own height is.
 */
export const LISTING_CARD_HEADER_CENTER_PX =
  LISTING_CARD_ICON_SIZE_PX / 2 - LISTING_CARD_ICON_OVERLAP_PX;

/** The title's font size (Mantine `xl`). The anchor around it inherits 16px, so margins must not use `em`. */
export const LISTING_CARD_TITLE_FONT_PX = 20;

/**
 * The title's line-height, a unitless multiple of its own font size. The title is ONE
 * line (ellipsized, full name in a tooltip when it clips), so its height is this times
 * the title's font size and nothing reserves a second line.
 */
export const LISTING_CARD_TITLE_LINE_HEIGHT = 1.2;

/** Height of the compact `sm` CTA button (Mantine `compact-sm`). */
export const LISTING_CARD_CTA_HEIGHT_PX = 26;

/** The `⋮` trigger over the cover's top-right corner. */
export const LISTING_CARD_MENU_TRIGGER_PX = 28;

/** Minimum height of the footer row (reviews/plays left, creator right). */
export const LISTING_CARD_FOOTER_HEIGHT_PX = 24;

/** The creator's avatar in the footer. */
export const LISTING_CARD_CREATOR_AVATAR_PX = 20;
