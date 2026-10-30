/** What a supplemental report adds to a user's earlier CyberTips, frozen when it is filed. */
export type CsamSupplementalDetails = {
  priorCsamReportId: number;
  /** NCMEC report ids of every sent report on the user, as `priorCTReports`. */
  priorReportNumbers: number[];
  /** The user's images pending review that this report leaves out. */
  unreviewedImageIds: number[];
};

const CONFIRMED = 'A Civitai reviewer confirmed the attached image(s).';

export function supplementalReportText(unreviewed: number) {
  if (unreviewed === 0) return CONFIRMED;
  if (unreviewed === 1)
    return `${CONFIRMED} The account has 1 further image that was flagged for review and not individually reviewed. It is preserved and available in response to legal process.`;
  return `${CONFIRMED} The account has ${unreviewed} further images that were flagged for review and not individually reviewed. They are preserved and available in response to legal process.`;
}
