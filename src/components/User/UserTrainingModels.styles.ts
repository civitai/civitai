import { CSSObject } from '@mantine/styles';

export const styles: Record<string, CSSObject> = {
  header: {
    position: 'sticky',
    top: 0,
    backgroundColor: 'var(--mantine-color-dark-7)',
    transition: 'box-shadow 150ms ease',
    zIndex: 10,

    '&::after': {
      content: '""',
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      borderBottom: '1px solid var(--mantine-color-dark-3)',
    },
  },

  scrolled: {
    boxShadow: 'var(--mantine-shadow-sm)',
  },
};
