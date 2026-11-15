/** The report choice a moderator makes when confirming a csam hold. Mirrors the main app's `CSAM_REPORT_CHOICES`. */
export const CSAM_REPORTABLE_CHOICES = [
  'enticement',
  'trafficking',
  'identifiable_child',
  'imagery',
] as const;
export const CSAM_REPORT_CHOICES = [...CSAM_REPORTABLE_CHOICES, 'none'] as const;
export type CsamReportChoice = (typeof CSAM_REPORT_CHOICES)[number];

export const isReportableChoice = (choice: string | null | undefined) =>
  (CSAM_REPORTABLE_CHOICES as readonly string[]).includes(choice ?? '');

export const CSAM_REPORT_QUESTION = 'Does this text fall in a reportable category?';

const CSAM_REPORT_CHOICE_COPY: Record<CsamReportChoice, { title: string; body: string }> = {
  enticement: {
    title: '1. Enticement or solicitation of a minor',
    body: 'The author tries to persuade, induce or entice someone they believe is a minor into sexual activity. (18 U.S.C. 2422(b))',
  },
  trafficking: {
    title: '2. Child sex trafficking',
    body: 'The text recruits, offers, advertises or arranges a minor for commercial sexual activity. (18 U.S.C. 1591)',
  },
  identifiable_child: {
    title: '3. A real, identifiable child',
    body: 'The sexual content is about a real child who could be identified (a name, a photo, a school, a handle or similar).',
  },
  imagery: {
    title: '4. Apparent CSAM imagery',
    body: 'The text links to, offers, trades, asks for, or says the author has or made sexual images or video of minors.',
  },
  none: {
    title: 'None of these',
    body: 'Confirm with no report.',
  },
};

/** Only a held PostText is deleted after its retention; other hold types keep their content as before. */
const NONE_RETENTION =
  'The text stays hidden and undeletable for 1 year from today, then it is deleted, unless an appeal, a law-enforcement request or a register hold is open.';

/** The copy for a choice on a hold of this entity type. */
export function reportChoiceCopy(choice: CsamReportChoice, entityType: string) {
  const copy = CSAM_REPORT_CHOICE_COPY[choice];
  if (choice !== 'none' || entityType !== 'PostText') return copy;
  return { ...copy, body: `${copy.body} ${NONE_RETENTION}` };
}

export const CSAM_REPORT_NOT_SURE = "Not sure? Don't pick None. Send it to the Moderation Lead.";
