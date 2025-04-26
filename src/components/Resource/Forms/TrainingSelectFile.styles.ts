import { CSSObject } from '@mantine/styles';
import { containerQuery } from '~/utils/mantine-css-helpers';

export const styles: Record<string, CSSObject> = {
  epochRow: {
    [containerQuery.smallerThan('sm')]: {
      flexDirection: 'column',
      gap: 'var(--mantine-spacing-md)',
    },
    flexWrap: 'nowrap',
  },
  selectedRow: {
    border: '2px solid var(--mantine-color-green-5)',
    opacity: 0.7,
  },
  paperRow: {
    cursor: 'pointer',
    '&:hover': {
      backgroundColor: 'var(--mantine-color-blue-2)',
      opacity: 0.1,
    },
  },
};
