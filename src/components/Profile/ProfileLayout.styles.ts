import { CSSObject } from '@mantine/styles';
import { containerQuery } from '~/utils/mantine-css-helpers';

export const styles: Record<string, CSSObject> = {
  sidebar: {
    width: 320,
    height: '100%',
    background: 'var(--mantine-color-dark-6)',

    [containerQuery.smallerThan('sm')]: {
      display: 'none',
    },
  },
  root: {
    display: 'flex',
    flex: 1,
    height: '100%',
  },
};
