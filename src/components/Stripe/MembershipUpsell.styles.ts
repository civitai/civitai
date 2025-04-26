import { CSSObject } from '@mantine/styles';

export const styles: Record<string, CSSObject> = {
  card: {
    backgroundColor: 'var(--mantine-color-dark-5)',
    width: '100%',
    height: '100%',
    margin: 0,
    padding: 'var(--mantine-spacing-md)',
    borderRadius: 'var(--mantine-radius-md)',
    display: 'flex',
  },
  title: {
    color: 'var(--mantine-color-white)',
    fontSize: 24,
    fontWeight: 600,
  },
  subtitle: {
    fontSize: 18,
    fontWeight: 500,
  },
  listItem: {
    color: 'var(--mantine-color-dark-0) !important',
    fontSize: 16,

    '.mantine-Text-root': {
      color: 'var(--mantine-color-dark-0) !important',
    },
  },
};
