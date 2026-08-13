export const imageGenerationDrawerZIndex = 301;

/** Joyride's overlay. Anything a tour step expects the user to click must clear it. */
export const tourOverlayZIndex = 100000;

/**
 * The remix menu opens from cards that sit inside routed dialogs, which stack at
 * `300 + index` (DialogProvider), so Mantine's popover default of 300 only wins
 * on mount order. This clears a few levels of dialog stacking outright.
 */
export const remixMenuZIndex = 310;
