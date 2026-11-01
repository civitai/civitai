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
    label: 'Illustrated Minor in Mature Context',
    value: ViolationType.AnimatedMinorNsfw,
  },
  {
    label: 'NSFW Minor in School Environment',
    value: ViolationType.SchoolNsfw,
  },
  {
    label: 'Minor with Violence',
    value: ViolationType.MinorViolence,
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

// Labels that would misstate the removal if shown to its owner. A school removal is a stricter
// standard applied to ambiguous-age content, not a finding that the subject is a minor.
// No trailing period: the notification template appends one.
const USER_FACING_REASONS: Partial<Record<ViolationType, string>> = {
  [ViolationType.SchoolNsfw]:
    'School settings are moderated more strictly, and this was removed under that stricter standard',
  [ViolationType.MinorViolence]:
    'Violence against, or implied harm to, characters who appear young is not allowed',
};

/** The wording for a violation shown back to the person it happened to. Falls back to the raw enum
 *  rather than throwing — a notification is not worth losing over an unmapped value. */
export function tosReasonUserMessage(violationType: ViolationType | string): string {
  return (
    USER_FACING_REASONS[violationType as ViolationType] ??
    TOS_REASONS.find((r) => r.value === violationType)?.label ??
    String(violationType)
  );
}
