import type { CsamQueueHoldReason } from '$lib/server/image-review.service';

/** What a moderator reads for each reason a user's CSAM flags cannot be cleared in bulk. A full
 *  Record, so a new leg does not compile until it has a label. */
export const HOLD_LEG_LABELS: Record<CsamQueueHoldReason, string> = {
  csamReport: 'Named on a CSAM report',
  csamReportSecondary: 'Secondary user on a CSAM report',
  ban: 'Ban hold',
  reportedImage: 'Image listed on a CSAM report',
  evidenceHold: 'Evidence hold',
  evidenceHoldUnknown: 'Evidence-hold status unknown',
};

export const holdLegLabels = (legs: readonly CsamQueueHoldReason[]) =>
  legs.map((leg) => HOLD_LEG_LABELS[leg]).join(', ');
