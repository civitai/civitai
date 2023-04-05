import { Box, BoxProps, createStyles } from '@mantine/core';
import Image from 'next/image';

export function Logo({ ...props }: LogoProps) {
  const { classes } = useStyles();

  return (
    <Box className={classes.root} {...props}>
      <svg
        className={classes.svg}
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 800 200"
        width="800"
        height="200"
      >
        <defs>
          <style>
            {`.cls-1 { font-family: "Segoe UI", Arial, sans-serif; font-size: 120px; }
            .cls-2 { fill: #333; }
          `}
          </style>
        </defs>
        <text className="cls-1 cls-2" x="10" y="140">
          AImagica
        </text>
        <circle cx="680" cy="100" r="40" fill="#0093D1" />
        <circle cx="760" cy="100" r="40" fill="#F04E23" />
        <path d="M680,100 Q730,50 760,100 Q730,150 680,100" fill="#B3B3B3" />
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
