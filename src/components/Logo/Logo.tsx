import { Box, BoxProps, createStyles } from '@mantine/core';

export function Logo({ ...props }: LogoProps) {
  const { classes } = useStyles();

  return (
    <Box className={classes.root} {...props}>
      <svg className={classes.svg} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 107 22.7">
        <g className={classes.text}>
          <path
            className={classes.c}
            d="M20.8,1.7H3.7L1.5,4.1v15l2.3,2.3h17.1v-5.2H6.7V7h14.1V1.7z"
          />
          <path
            className={classes.ivit}
            d="M76.1,1.7H56.6V7h7.2v14.3H69V7h7C76,7,76.1,1.7,76.1,1.7z M23.2,1.8v19.5h5.2V1.8C28.4,1.8,23.2,1.8,23.2,1.8z M30.8,1.8
      v19.5h7.6l8.3-8.3V1.8h-5.2v8.3l-5.4,6V1.8C36.1,1.8,30.8,1.8,30.8,1.8z M49.1,1.8v19.5h5.2V1.8C54.3,1.8,49.1,1.8,49.1,1.8z"
          />
          <path
            className={classes.ai}
            d="M100.3,1.8v19.5h5.2V1.8H100.3z M95.6,1.8H80.8l-2.3,2.3v17.2h5.2v-7.1h8.9v7.1h5.2V4.1C97.8,4.1,95.6,1.8,95.6,1.8z
      M92.7,8.9h-8.9V7h8.9V8.9z"
          />
          <path className={classes.accent} d="M46.7,16.2v5.1h-5.1" />
        </g>
        <g className={classes.badge}>
          <linearGradient
            id="innerGradient"
            gradientUnits="userSpaceOnUse"
            x1="10.156"
            y1="22.45"
            x2="10.156"
            y2="2.4614"
            gradientTransform="matrix(1 0 0 -1 0 24)"
          >
            <stop offset="0" style={{ stopColor: '#081692' }} />
            <stop offset="1" style={{ stopColor: '#1E043C' }} />
          </linearGradient>
          <linearGradient
            id="outerGradient"
            gradientUnits="userSpaceOnUse"
            x1="10.156"
            y1="22.45"
            x2="10.156"
            y2="2.45"
            gradientTransform="matrix(1 0 0 -1 0 24)"
          >
            <stop offset="0" style={{ stopColor: '#1284F7' }} />
            <stop offset="1" style={{ stopColor: '#0A20C9' }} />
          </linearGradient>
          <path
            style={{ fill: 'url(#innerGradient)' }}
            d="M1.5,6.6v10l8.7,5l8.7-5v-10l-8.7-5L1.5,6.6z"
          />
          <path
            style={{ fill: 'url(#outerGradient)' }}
            d="M10.2,4.7l5.9,3.4V15l-5.9,3.4L4.2,15V8.1
		L10.2,4.7 M10.2,1.6l-8.7,5v10l8.7,5l8.7-5v-10C18.8,6.6,10.2,1.6,10.2,1.6z"
          />
          <path
            style={{ fill: '#fff' }}
            d="M11.8,12.4l-1.7,1l-1.7-1v-1.9l1.7-1l1.7,1h2.1V9.3l-3.8-2.2L6.4,9.3v4.3l3.8,2.2l3.8-2.2v-1.2H11.8z"
          />
        </g>
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
      height: 45,
      width: 45,
    },
  },
  svg: {
    height: 30,
    [theme.fn.smallerThan('sm')]: {
      height: 45,
    },
  },
  c: {
    fill: theme.colorScheme === 'dark' ? theme.colors.dark[0] : '#111',
  },

  ivit: {
    fill: theme.colorScheme === 'dark' ? theme.colors.dark[0] : '#111',
  },

  ai: {
    fill: theme.colors.blue[8],
  },

  accent: {
    fill: theme.colors.blue[8],
  },

  text: {
    [theme.fn.smallerThan('sm')]: {
      display: 'none',
    },
  },

  badge: {
    [theme.fn.largerThan('sm')]: {
      display: 'none',
    },
  },
}));
