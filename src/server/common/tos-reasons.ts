import { ViolationType } from './enums';

export const TOS_REASONS = [
  {
    label: 'Depicting Real People',
    value: 'Depicting real people is not allowed.',
    violationType: ViolationType.RealPerson,
  },
  {
    label: 'Depicting Real People in mature context',
    value: 'Depicting real people in mature context is not allowed.',
    violationType: ViolationType.RealPersonNsfw,
  },
  {
    label: 'Realistic minor',
    value: 'Realistic images of minors is not allowed.',
    violationType: ViolationType.RealisticMinor,
  },
  {
    label: 'Realistic Minor displayed in mature context',
    value: 'Realistic Minors displayed in mature context is not allowed.',
    violationType: ViolationType.RealisticMinorNsfw,
  },
  {
    label: 'Animated Minor displayed in mature context',
    value: 'Animated Minors displayed in mature context is not allowed.',
    violationType: ViolationType.AnimatedMinorNsfw,
  },
  {
    label: 'NSFW potential minor in a school environment',
    value: 'NSFW potential minors in a school environment is not allowed',
    violationType: ViolationType.SchoolNsfw,
  },
  {
    label: 'Bestiality',
    value: 'Bestiality is not allowed.',
    violationType: ViolationType.Bestiality,
  },
  {
    label: 'Rape/Forced Sex',
    value: 'Depicting rape and domestic abuse is not allowed.',
    violationType: ViolationType.SexualViolence,
  },
  {
    label: 'Mind altered NSFW',
    value: 'Mind altered NSFW is not allowed',
    violationType: ViolationType.MindAlteredNsfw,
  },
  {
    label: 'Scat/Fecal matter',
    value: 'Fecal matter, gaseous emission, object or lifeform being ejected from an anus is not allowed',
    violationType: ViolationType.FecalMatter,
  },
  {
    label: 'Graphic Violence/Gore',
    value: 'Graphic Violence and/or gore is not allowed',
    violationType: ViolationType.Gore,
  },
  {
    label: 'Diapers',
    value: 'Diapers are not allowed',
    violationType: ViolationType.Diaper,
  },
  {
    label: 'Anorexia',
    value: 'Anorexia is not allowed',
    violationType: ViolationType.Anorexia,
  },
  {
    label: 'Prohibited bodily fluids',
    value: 'Certain bodily fluids are not allowed',
    violationType: ViolationType.BodilyFluids,
  },
  {
    label: 'Incest',
    value: 'Incest is not allowed',
    violationType: ViolationType.Incest,
  },
  {
    label: 'Hate Speech/Extreme political',
    value: 'Hate Speech/Extreme political content is not allowed',
    violationType: ViolationType.Hate,
  },
  {
    label: 'Non AI content',
    value: 'CivitAI is for posting AI-generated images or videos',
    violationType: ViolationType.NonAi,
  },
  {
    label: 'Spam',
    value: 'Spam',
    violationType: ViolationType.Spam,
  },
  {
    label: 'Other',
    value: '',
    violationType: ViolationType.Other,
  },
] as const;

export type TosReason = (typeof TOS_REASONS)[number];

const needsReviewToViolationType: Record<string, string> = {
  minor: ViolationType.RealisticMinor,
  poi: ViolationType.RealPerson,
  csam: ViolationType.RealisticMinorNsfw,
  tag: ViolationType.Other,
  newUser: ViolationType.Other,
  blocked: ViolationType.Other,
  appeal: ViolationType.Other,
  bestiality: ViolationType.Bestiality,
};

const reportViolationToType: Record<string, string> = {
  'Depiction of real-person likeness': ViolationType.RealPerson,
  'Graphic violence': ViolationType.Gore,
  'False impersonation': ViolationType.Other,
  'Deceptive content': ViolationType.Other,
  'Sale of illegal substances': ViolationType.Other,
  'Child abuse and exploitation': ViolationType.RealisticMinorNsfw,
  'Photorealistic depiction of a minor': ViolationType.RealisticMinor,
  'Prohibited concepts': ViolationType.Other,
};

export function mapToViolationType(
  needsReview: string | null | undefined,
  reportDetails?: { violation?: string; comment?: string; reason?: string }
): string {
  if (reportDetails?.violation && reportViolationToType[reportDetails.violation]) {
    return reportViolationToType[reportDetails.violation];
  }

  if (needsReview && needsReviewToViolationType[needsReview]) {
    return needsReviewToViolationType[needsReview];
  }

  return ViolationType.Other;
}
