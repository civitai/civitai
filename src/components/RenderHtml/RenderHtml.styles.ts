import { CSSObject } from '@mantine/styles';
import { containerQuery } from '~/utils/mantine-css-helpers';

export const styles: Record<string, CSSObject> = {
  htmlRenderer: {
    '& p:last-of-type': {
      marginBottom: 0,
    },
    p: {
      wordBreak: 'break-word' as const,
    },
    iframe: {
      border: 'none',
    },
    code: {
      whiteSpace: 'break-spaces' as const,
    },
    'div[data-type="instagram"]': {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      height: 769,

      '& > iframe': {
        width: '50%',
        overflow: 'hidden',
        flexGrow: 1,
      },

      [containerQuery.smallerThan('md')]: {
        height: 649,
      },

      [containerQuery.smallerThan('sm')]: {
        height: 681,

        '& > iframe': {
          width: '100%',
        },
      },
    },
    'div[data-type="strawPoll"]': {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      height: 480,

      '& > iframe': {
        flexGrow: 1,
      },
    },
    'h1, h2, h3': {
      '&:before': {
        display: 'block',
        content: '""',
        marginTop: 'calc(var(--mantine-spacing-xs) * -7)',
        height: 'calc(var(--mantine-spacing-xs) * 7 + var(--mantine-spacing-xs))',
        visibility: 'hidden',
      },
    },
    hr: {
      height: '4px',
      padding: 0,
      margin: '24px 0',
      backgroundColor: 'var(--mantine-color-dark-4)',
      border: 0,
    },
  },
};
