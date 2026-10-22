import type { FlagClearHoldLeg } from '$lib/server/csam-flag-clear';

/** What a moderator reads for each reason a user's CSAM flags cannot be cleared in bulk. A full
 *  Record, so a new leg does not compile until it has a label. */
export const HOLD_LEG_LABELS: Record<FlagClearHoldLeg, string> = {
  csamReport: 'Named on a CSAM report',
  csamReportSecondary: 'Secondary user on a CSAM report',
  ban: 'Ban hold',
  reportedImage: 'Image listed on a CSAM report',
  evidenceHold: 'Evidence hold',
};

export const holdLegLabels = (legs: readonly FlagClearHoldLeg[]) =>
  legs.map((leg) => HOLD_LEG_LABELS[leg]).join(', ');
