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
