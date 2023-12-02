import { Box, BoxProps, createStyles } from '@mantine/core';
import { NextLink } from '@mantine/next';
import { wiggle } from '~/libs/animations';
export const SupportButton = ({ ...props }: Props) => {
  const { classes } = useStyles();

  return (
    <Box component={NextLink} href="/pricing" className={classes.root} {...props}>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={classes.svg}
      >
        <path
          className={classes.pulser}
          d="M19.5 12.572 12 20l-7.5-7.428A5 5 0 1 1 12 6.006a5 5 0 1 1 7.5 6.572"
        />
        <path
          className={classes.heart}
          d="M19.5 12.572 12 20l-7.5-7.428A5 5 0 1 1 12 6.006a5 5 0 1 1 7.5 6.572"
        />
      </svg>
    </Box>
  );
};

type Props = {
  size?: 'sm' | 'md' | 'lg' | 'xl';
} & BoxProps;

const useStyles = createStyles((theme) => ({
  root: {
    height: 30,
    cursor: 'pointer',
  },
  svg: {
    height: 30,
    transform: 'translateZ(0)',
    // animation: `${pulseSize} 1s ease-in-out infinite`,

    [`&:hover`]: {
      animation: `${wiggle()} 750ms ease-in-out infinite`,
    },
  },

  heart: {
    stroke: '#ff6666',
    strokeWidth: 2,
    transformOrigin: 'center',
    transform: 'scale(1)',
  },

  pulser: {
    transformOrigin: 'center',
    transform: 'scale(1) translateZ(0)',
    // animation: `${pulse} 1s ease-in-out infinite`,
  },
}));
