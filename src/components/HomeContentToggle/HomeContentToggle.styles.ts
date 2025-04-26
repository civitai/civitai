import { CSSObject } from '@mantine/styles';

export const styles: Record<string, CSSObject> = {
  tabHighlight: {
    backgroundColor: 'var(--mantine-color-yellow-3)',
    opacity: 0.1,
    backgroundImage: `linear-gradient(90deg, var(--mantine-color-yellow-4), var(--mantine-color-yellow-4), var(--mantine-color-yellow-4))`,
    backgroundSize: '50px',
    backgroundPosition: '-300% 50%',
    backgroundRepeat: 'no-repeat',
    color: 'var(--mantine-color-yellow-3)',
    animation: 'button-highlight 5s linear infinite',
    willChange: 'background-position',
  },
  moreButton: {
    padding: '8px 10px 8px 16px',
    fontSize: 16,
    fontWeight: 500,
    display: 'none',

    '&[data-active="true"]': {
      background: 'var(--mantine-color-dark-4)',
      color: 'var(--mantine-color-white)',
    },

    '@container (min-width: 992px) and (max-width: 1440px)': {
      display: 'block',
    },
  },
  groupedOptions: {
    display: 'block',

    '@container (min-width: 992px) and (max-width: 1440px)': {
      display: 'none',
    },
  },
};
