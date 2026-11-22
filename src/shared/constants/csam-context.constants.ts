/** The most of one captured item's text a CyberTip carries. */
export const CSAM_CONTEXT_TEXT_MAX_CHARS = 50_000;

/**
 * What one CyberTip carries of a report's chat message, model, article, service offering and profile
 * text, folds included. Chosen by Civitai: NCMEC's own size limit is unverified.
 */
export const CSAM_CONTEXT_ITEM_SEND_BUDGET = 1_000_000;

/** Items of those types one filing may select: the send budget's worth of capped items. */
export const CSAM_CONTEXT_ITEM_SELECT_LIMIT =
  CSAM_CONTEXT_ITEM_SEND_BUDGET / CSAM_CONTEXT_TEXT_MAX_CHARS;

/** Where a moderator takes text a CSAM report can't carry. A policy decision, said the same way everywhere. */
export const CSAM_PRIVATE_ROUTE = 'tell [WHO: pending] privately';

export const CSAM_CONTEXT_NO_IMAGES_REFUSAL = `Text can be attached only to a report with images. File it without the text, then ${CSAM_PRIVATE_ROUTE}.`;
