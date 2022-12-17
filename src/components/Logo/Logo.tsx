import { Box, BoxProps, createStyles } from '@mantine/core';

export function Logo({ ...props }: LogoProps) {
  const { classes } = useStyles();

  return (
    <Box className={classes.root} {...props}>
      <svg
        className={classes.svg}
        xmlns="http://www.w3.org/2000/svg"
        x="0"
        y="0"
        version="1.1"
        viewBox="0 0 107 22.7"
      >
        <path className={classes.c} d="M20.8 1.7H3.7L1.5 4.1v15l2.3 2.3h17.1v-5.2H6.7V7h14.1z" />
        <path
          className={classes.ivit}
          d="M76.1 1.7H56.6V7h7.2v14.3H69V7h7l.1-5.3zm-52.9.1v19.5h5.2V1.8h-5.2zm7.6 0v19.5h7.6l8.3-8.3V1.8h-5.2v8.3l-5.4 6V1.8h-5.3zm18.3 0v19.5h5.2V1.8h-5.2z"
        />
        <path
          className={classes.ai}
          d="M100.3 1.8v19.5h5.2V1.8h-5.2zm-4.7 0H80.8l-2.3 2.3v17.2h5.2v-7.1h8.9v7.1h5.2V4.1l-2.2-2.3zm-2.9 7.1h-8.9V7h8.9v1.9z"
        />
        <path className={classes.accent} d="M46.7 16.2v5.1h-5.1" />
      </svg>
    </Box>
  );
}

type LogoProps = {
  size?: 'sm' | 'md' | 'lg' | 'xl';
} & BoxProps;

const useStyles = createStyles((theme) => ({
  root: {
    height: 30,
    [theme.fn.smallerThan('sm')]: {
      overflow: 'hidden',
      width: 70,
    },
  },
  svg: {
    height: 30,
  },
  c: {
    fill: theme.colorScheme === 'dark' ? theme.colors.dark[0] : '#111',
  },

  ivit: {
    fill: theme.colorScheme === 'dark' ? theme.colors.dark[0] : '#111',
    [theme.fn.smallerThan('sm')]: {
      display: 'none',
    },
  },

  ai: {
    fill: theme.colors.blue[8],
    [theme.fn.smallerThan('sm')]: {
      position: 'absolute',
      transform: 'translateX(-50%)',
    },
  },

  accent: {
    fill: theme.colors.blue[8],
    [theme.fn.smallerThan('sm')]: {
      display: 'none',
    },
  },
}));
