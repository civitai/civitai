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

/** A report with no image can't be sent, while filing it still removes the account: never say "file". */
export const CSAM_CONTEXT_NO_IMAGES_REFUSAL = `Nothing was filed. An image report needs at least one image that still exists. Select only the images you are reporting; don't add one just to file. If there is no image to report, or it no longer exists, don't file here: ${CSAM_PRIVATE_ROUTE} now. It may still need to be reported.`;

/** Opens an edited chat message's text when the record can't show the sender made every edit. */
export const CHAT_EDITORS_UNCONFIRMED_OPENING =
  "Text on the reported user's chat message as of capture. It was edited, and Civitai can't confirm who made every edit.";

/** The picker's help. With no image selected it never says "file now". */
export const csamOutsideFieldsHelp = (hasImages: boolean) =>
  hasImages
    ? `Facts outside these fields are not captured and are not sent. If one is the reason for this report, file now, then ${CSAM_PRIVATE_ROUTE}.`
    : `Facts outside these fields are not captured and are not sent. If there is no image to report, don't file here: ${CSAM_PRIVATE_ROUTE} now. It may still need to be reported.`;

/** Under the model picker. Ownership on record can miss an earlier owner. */
export const CSAM_MODEL_EARLIER_OWNER_HELP = `If you know this model, or the model it was split from, had an earlier owner, leave it unticked and ${CSAM_PRIVATE_ROUTE}.`;

export const csamNotAttachedNotice = (items: string[]) =>
  `Not attached: ${items.join(
    ', '
  )}. The report was filed without them. If one is the reason for this report, ${CSAM_PRIVATE_ROUTE}.`;
