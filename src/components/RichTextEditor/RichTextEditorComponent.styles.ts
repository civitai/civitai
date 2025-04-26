import { CSSObject } from '@mantine/styles';
import { containerQuery } from '~/utils/mantine-css-helpers';

export const styles: Record<string, CSSObject> = {
  mention: {
    color: 'var(--mantine-color-blue-4)',
  },
  instagramEmbed: {
    aspectRatio: '9/16',
    maxHeight: 1060,
    maxWidth: '50%',
    overflow: 'hidden',

    [containerQuery.smallerThan('sm')]: {
      maxWidth: '100%',
    },
  },
  strawPollEmbed: {
    aspectRatio: '4/3',
    maxHeight: 480,
    // Ignoring because we want to use !important, if not then it complaints about it
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pointerEvents: 'auto !important' as any,
  },
  bubbleTooltip: {
    backgroundColor: 'var(--mantine-color-dark-6)',
  },
};
