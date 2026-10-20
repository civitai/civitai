import type { ResolutionVerdict } from '@civitai/shared/resolution-reasons';
import type { ButtonVariant } from '@civitai/ui/components/ui/button/index.js';

export type RulingChoice<V extends string> = {
  verdict: V;
  label: string;
  confirmLabel: string;
  /** Shown on the confirm button while the ruling is in flight. */
  pendingLabel: string;
  variant: ButtonVariant;
};

export const RESTRICTION_RULING_CHOICES: readonly RulingChoice<ResolutionVerdict<'restriction'>>[] =
  [
    {
      verdict: 'Overturned',
      label: 'Remove mute',
      confirmLabel: 'Confirm remove mute',
      pendingLabel: 'Removing…',
      variant: 'default',
    },
    {
      verdict: 'Upheld',
      label: 'Uphold mute',
      confirmLabel: 'Confirm uphold',
      pendingLabel: 'Upholding…',
      variant: 'destructive',
    },
  ];

export const appealRulingChoices = (
  count?: number
): readonly RulingChoice<ResolutionVerdict<'appeal'>>[] => {
  const n = count ? ` ${count}` : '';
  return [
    {
      verdict: 'Approved',
      label: `Approve${n}`,
      confirmLabel: `Confirm approve${n}`,
      pendingLabel: 'Approving…',
      variant: 'default',
    },
    {
      verdict: 'Rejected',
      label: `Reject${n}`,
      confirmLabel: `Confirm reject${n}`,
      pendingLabel: 'Rejecting…',
      variant: 'destructive',
    },
  ];
};

export const FLAG_APPEAL_RULING_CHOICES: readonly RulingChoice<ResolutionVerdict<'flagAppeal'>>[] =
  [
    {
      verdict: 'Rejected',
      label: 'Keep flagged',
      confirmLabel: 'Confirm: keep flagged',
      pendingLabel: 'Keeping flag…',
      variant: 'default',
    },
    {
      verdict: 'Approved',
      label: 'Unflag',
      confirmLabel: 'Confirm: unflag',
      pendingLabel: 'Unflagging…',
      variant: 'destructive',
    },
  ];

export const HELD_DETECTION_RULING_CHOICES: readonly RulingChoice<
  ResolutionVerdict<'heldDetection'>
>[] = [
  {
    verdict: 'Kept',
    label: 'Flag',
    confirmLabel: 'Confirm: flag',
    pendingLabel: 'Flagging…',
    variant: 'default',
  },
  {
    verdict: 'Dismissed',
    label: "Don't flag",
    confirmLabel: "Confirm: don't flag",
    pendingLabel: 'Clearing…',
    variant: 'destructive',
  },
];

export const FLAG_REVIEW_RULING_CHOICES: readonly RulingChoice<ResolutionVerdict<'flagReview'>>[] =
  [
    {
      verdict: 'Kept',
      label: 'Keep flag',
      confirmLabel: 'Confirm: keep flag',
      pendingLabel: 'Keeping flag…',
      variant: 'default',
    },
    {
      verdict: 'Lifted',
      label: 'Lift flag',
      confirmLabel: 'Confirm: lift flag',
      pendingLabel: 'Lifting…',
      variant: 'destructive',
    },
  ];
