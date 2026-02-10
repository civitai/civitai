import { ViolationType } from './enums';

export const TOS_REASONS = [
  {
    label: 'Depicting Real People',
    value: ViolationType.RealPerson,
  },
  {
    label: 'Depicting Real People in Mature Context',
    value: ViolationType.RealPersonNsfw,
  },
  {
    label: 'Realistic Minor',
    value: ViolationType.RealisticMinor,
  },
  {
    label: 'Realistic Minor in Mature Context',
    value: ViolationType.RealisticMinorNsfw,
  },
  {
    label: 'Animated Minor in Mature Context',
    value: ViolationType.AnimatedMinorNsfw,
  },
  {
    label: 'NSFW Minor in School Environment',
    value: ViolationType.SchoolNsfw,
  },
  {
    label: 'Bestiality',
    value: ViolationType.Bestiality,
  },
  {
    label: 'Sex Violence',
    value: ViolationType.SexualViolence,
  },
  {
    label: 'Mind-Altered NSFW',
    value: ViolationType.MindAlteredNsfw,
  },
  {
    label: 'Scat/Fecal Matter',
    value: ViolationType.FecalMatter,
  },
  {
    label: 'Graphic Violence/Gore',
    value: ViolationType.Gore,
  },
  {
    label: 'Diapers',
    value: ViolationType.Diaper,
  },
  {
    label: 'Anorexia',
    value: ViolationType.Anorexia,
  },
  {
    label: 'Prohibited Bodily Fluids',
    value: ViolationType.BodilyFluids,
  },
  {
    label: 'Incest',
    value: ViolationType.Incest,
  },
  {
    label: 'Hate Speech/Extreme Political',
    value: ViolationType.Hate,
  },
  {
    label: 'Non-AI Content',
    value: ViolationType.NonAi,
  },
  {
    label: 'Spam',
    value: ViolationType.Spam,
  },
  {
    label: 'Other',
    value: ViolationType.Other,
  },
] as const;

export type TosReason = (typeof TOS_REASONS)[number];

const needsReviewToViolationType: Record<string, ViolationType> = {
  minor: ViolationType.RealisticMinor,
  poi: ViolationType.RealPerson,
  csam: ViolationType.RealisticMinorNsfw,
  tag: ViolationType.Other,
  newUser: ViolationType.Other,
  blocked: ViolationType.Other,
  appeal: ViolationType.Other,
  bestiality: ViolationType.Bestiality,
};

const reportViolationToType: Record<string, ViolationType> = {
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
): ViolationType {
  if (reportDetails?.violation && reportViolationToType[reportDetails.violation]) {
    return reportViolationToType[reportDetails.violation];
  }

  if (needsReview && needsReviewToViolationType[needsReview]) {
    return needsReviewToViolationType[needsReview];
  }

  return ViolationType.Other;
}
