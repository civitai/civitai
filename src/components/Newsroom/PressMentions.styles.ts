import { CSSObject } from '@mantine/styles';
import { containerQuery } from '~/utils/mantine-css-helpers';

export const styles: Record<string, CSSObject> = {
  articles: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
    gap: 'var(--mantine-spacing-md)',
  },

  card: {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between',
    height: '100%',
    padding: 'var(--mantine-spacing-md)',
    transition: 'all 200ms ease',
    '&:hover': {
      borderColor: 'var(--mantine-color-blue-7)',
    },
  },

  title: {
    fontSize: 'var(--mantine-font-size-lg)',
    flex: 1,
    marginTop: 'var(--mantine-spacing-sm)',
    marginBottom: 'var(--mantine-spacing-md)',
    [containerQuery.largerThan('md')]: {
      fontSize: 'var(--mantine-font-size-xl)',
    },
  },

  publishDate: {
    fontSize: 'var(--mantine-font-size-md)',
    color: 'var(--mantine-color-dark-2)',
  },

  source: {
    color: 'var(--mantine-color-blue-3)',
    fontSize: 'var(--mantine-font-size-md)',
  },
};
