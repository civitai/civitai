// The fixed reason list for mute, appeal and held-detection rulings, read by the main app's resolve
// endpoints (which validate it) and by the moderator app (which renders it). Stored as the `value`
// slug in `UserRestriction.resolvedReason` / `Appeal.resolvedReason` (plain TEXT columns) and on a
// held detection's `Model.meta.textScanFlags` decision stamp, so a slug change costs no migration.
//
// 🔴 Never rename or drop a `value` that has been written: the column keeps old rows, and this list is
// the only place their meaning is recorded. Retire one by moving it out of the offered list instead.

export type TextScanLabel = 'minor' | 'poi';

export type ResolutionReason = {
  value: string;
  label: string;
  description: string;
  /** The flags this reason can explain; absent means any. */
  labels?: readonly TextScanLabel[];
};

const OTHER: ResolutionReason = {
  value: 'other',
  label: 'Other',
  description: 'None of the above. Say why in the note.',
};

const FLAG_IS_WRONG = [
  {
    value: 'not-a-minor',
    label: 'Not a minor',
    description: 'The subjects are adults; age terms were misread.',
    labels: ['minor'],
  },
  {
    value: 'not-a-real-person',
    label: 'Not a real person',
    description: 'A fictional character or generic likeness, not an identifiable person.',
    labels: ['poi'],
  },
  {
    value: 'terms-misread',
    label: 'Terms misread',
    description:
      'The trained words, tags or description triggered it, but the model does not depict it.',
  },
] as const satisfies readonly ResolutionReason[];

const FLAG_KEPT = [
  {
    value: 'detection-correct',
    label: 'Detection correct',
    description: 'The text does describe a minor or a real person.',
  },
  OTHER,
] as const satisfies readonly ResolutionReason[];

const FLAG_DISMISSED = [...FLAG_IS_WRONG, OTHER] as const satisfies readonly ResolutionReason[];

export const RESOLUTION_REASONS = {
  restriction: {
    Overturned: [
      {
        value: 'remix-source',
        label: 'Prompt came from a remix',
        description: "The flagged terms came from the remixed image's prompt, not from the user.",
      },
      {
        value: 'minor-term-misread',
        label: 'Minor-age terms misread',
        description:
          'A minor-category term triggered it, but read in full the prompt does not involve a minor.',
      },
      {
        value: 'word-match',
        label: 'Keyword hit only',
        description: 'A term matched, but the prompt is not prohibited when read in full.',
      },
      {
        value: 'art-context',
        label: 'Legitimate context',
        description: 'Artistic, fictional or historical framing; the subjects are clearly allowed.',
      },
      {
        value: 'isolated',
        label: 'Isolated, low severity',
        description: 'One borderline prompt with no pattern; a mute is out of proportion.',
      },
      OTHER,
    ],
    Upheld: [
      {
        value: 'clear-intent',
        label: 'Clear intent',
        description: 'The prompts deliberately aim at prohibited content.',
      },
      {
        value: 'repeat-evasion',
        label: 'Repeated or evading',
        description: 'Repeated attempts, or rewording to get past the filter.',
      },
      {
        value: 'prior-history',
        label: 'Prior history',
        description: 'Earlier restrictions or strikes for the same thing.',
      },
      OTHER,
    ],
  },
  appeal: {
    Approved: [
      {
        value: 'misclassified',
        label: 'Wrong call',
        description: 'The content does not match the removal reason.',
      },
      {
        value: 'rating-only',
        label: 'Rating issue, not removal',
        description: 'Fine at a different browsing level; it needed a re-rate, not a removal.',
      },
      {
        value: 'context-provided',
        label: 'User supplied context',
        description: 'Proof of age, ownership or source resolves the concern.',
      },
      OTHER,
    ],
    Rejected: [
      {
        value: 'violation-confirmed',
        label: 'Violation confirmed',
        description: 'The removal reason stands on review.',
      },
      {
        value: 'different-violation',
        label: 'Different violation',
        description: 'The removal stands, under a different rule than first cited.',
      },
      OTHER,
    ],
  },
  // Model flag appeals and bounty real-person appeals. Approved lifts the flag, Rejected keeps it.
  flagAppeal: {
    Approved: [
      ...FLAG_IS_WRONG,
      {
        value: 'context-provided',
        label: 'User supplied context',
        description: 'Proof of age, consent or source resolves the concern.',
      },
      OTHER,
    ],
    Rejected: [
      {
        value: 'flag-confirmed',
        label: 'Flag confirmed',
        description: 'The flag stands on review.',
      },
      OTHER,
    ],
  },
  heldDetection: {
    Kept: FLAG_KEPT,
    Dismissed: FLAG_DISMISSED,
  },
  // A moderator's call on a standing text-scan flag outside an appeal; same judgment as a held
  // detection, so the lists are shared.
  flagReview: {
    Kept: FLAG_KEPT,
    Lifted: FLAG_DISMISSED,
  },
} as const satisfies Record<string, Record<string, readonly ResolutionReason[]>>;

export type ResolutionSubject = keyof typeof RESOLUTION_REASONS;
export type ResolutionVerdict<S extends ResolutionSubject> = keyof (typeof RESOLUTION_REASONS)[S] &
  string;

// Matches the ban form's internal note, which doubles as the ruling note when a ban upholds.
export const RESOLUTION_NOTE_MAX_LENGTH = 2000;

const reasonsOf = (subject: ResolutionSubject, verdict: string): readonly ResolutionReason[] =>
  (RESOLUTION_REASONS[subject] as Record<string, readonly ResolutionReason[]>)[verdict] ?? [];

const appliesTo = (reason: ResolutionReason, labels: readonly TextScanLabel[] | undefined) =>
  !labels || !reason.labels || reason.labels.some((label) => labels.includes(label));

/** The reasons for this verdict; with `labels`, only those that can explain one of those flags. */
export function resolutionReasonsFor<S extends ResolutionSubject>(
  subject: S,
  verdict: ResolutionVerdict<S>,
  labels?: readonly TextScanLabel[]
): readonly ResolutionReason[] {
  return reasonsOf(subject, verdict).filter((r) => appliesTo(r, labels));
}

export function resolutionReasonLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  for (const verdicts of Object.values(RESOLUTION_REASONS))
    for (const reasons of Object.values(verdicts) as (readonly ResolutionReason[])[])
      for (const r of reasons) if (r.value === value) return r.label;
  return value;
}

export function reasonRequiresNote(reason: string | null | undefined): boolean {
  return reason === OTHER.value;
}

/**
 * Why a reason/note pair cannot be recorded for this verdict, or null when it can. A reason is
 * required, must belong to the verdict (an uphold reason on an overturn is a mislabel, not a
 * label) and, given `labels`, to one of the flags ruled on; `other` carries no meaning without its
 * note.
 */
export function resolutionReasonError<S extends ResolutionSubject>(
  subject: S,
  verdict: ResolutionVerdict<S>,
  reason: string | null | undefined,
  note: string | null | undefined,
  labels?: readonly TextScanLabel[]
): string | null {
  if (!reason) return 'Pick a reason for this ruling.';
  const known = reasonsOf(subject, verdict).find((r) => r.value === reason);
  if (!known) return `"${reason}" is not a reason for ${verdict}.`;
  if (!appliesTo(known, labels)) return `"${known.label}" does not apply to this flag.`;
  if (reasonRequiresNote(reason) && !note?.trim()) return 'Add a note when the reason is Other.';
  if (note && note.length > RESOLUTION_NOTE_MAX_LENGTH)
    return `The note is longer than ${RESOLUTION_NOTE_MAX_LENGTH} characters.`;
  return null;
}
