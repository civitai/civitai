/** The `code` on the auto-label route's 503 when auto-label is unavailable: it marks our own refusal, so a client can tell it
 *  from an upstream 503 that may have come after work was done. */
export const AUTO_LABEL_UNAVAILABLE_CODE = 'auto_label_unavailable';

/** A submit that was refused before any orchestrator workflow could exist, so nothing was charged and
 *  its per-image cap slot is returned. Anything else that fails a submit stays counted. */
export class AutoLabelRefusedError extends Error {}
