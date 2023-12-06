import { Box, BoxProps, createStyles } from '@mantine/core';
import { NextLink } from '@mantine/next';
import { IconChristmasTree } from '@tabler/icons-react';
import { wiggle } from '~/libs/animations';
export const EventButton = ({ className, ...props }: Props) => {
  const { classes, cx } = useStyles();

  return (
    <Box
      component={NextLink}
      href="/events/holiday2023"
      className={cx(classes.root, className)}
      {...props}
    >
      <IconChristmasTree size={30} strokeWidth={1.5} className={classes.svg} />
    </Box>
  );
};

type Props = {
  size?: 'sm' | 'md' | 'lg' | 'xl';
} & BoxProps;

const useStyles = createStyles((theme) => ({
  root: {
    height: 36,
    marginLeft: -8,
    cursor: 'pointer',
    position: 'relative',
    zIndex: 3,
  },
  svg: {
    height: 36,
    transform: 'translateZ(0)',
    stroke: theme.colors.green[4],

    [`&:hover`]: {
      animation: `${wiggle()} 750ms ease-in-out infinite`,
    },
  },
}));
