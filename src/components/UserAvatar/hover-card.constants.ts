/**
 * The delays every hover card in the app shares, kept apart from the component.
 *
 * A card that only wants the timing should not have to import `UserHoverCard` to
 * get it — that pulls a component module into the importer's graph for an
 * integer, on routes that may never render a creator card. `UserHoverCard`
 * re-exports both names, so existing importers are unaffected.
 */

/**
 * Long enough that a pointer crossing a target on its way somewhere else does
 * not open anything. Hover cards sit on avatars in a feed and on stickers inside
 * one, both of which get swiped past rather than aimed at.
 */
export const HOVER_DELAY_MS = 500;

/** Enough to cross the gap from the target to the dropdown without it closing. */
export const HOVER_CLOSE_DELAY_MS = 150;
