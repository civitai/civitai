import type { ResolutionVerdict } from '@civitai/shared/resolution-reasons';
import type { ButtonVariant } from '@civitai/ui/components/ui/button/index.js';

export type RulingChoice<V extends string> = {
  verdict: V;
  label: string;
  confirmLabel: string;
  variant: ButtonVariant;
};

export const RESTRICTION_RULING_CHOICES: readonly RulingChoice<ResolutionVerdict<'restriction'>>[] =
  [
    {
      verdict: 'Overturned',
      label: 'Remove mute',
      confirmLabel: 'Confirm remove mute',
      variant: 'default',
    },
    {
      verdict: 'Upheld',
      label: 'Uphold mute',
      confirmLabel: 'Confirm uphold',
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
      variant: 'default',
    },
    {
      verdict: 'Rejected',
      label: `Reject${n}`,
      confirmLabel: `Confirm reject${n}`,
      variant: 'destructive',
    },
  ];
};
