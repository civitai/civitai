import type { BoxProps } from '@mantine/core';
import { Box } from '@mantine/core';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { IconChristmasTree } from '@tabler/icons-react';
import classes from './EventButton.module.scss';
import clsx from 'clsx';

export const EventButton = ({ className, ...props }: Props) => {
  return (
    <Box
      component={Link}
      href="/events/holiday2023"
      className={clsx(classes.root, className)}
      {...props}
    >
      <IconChristmasTree size={30} strokeWidth={1.5} className={classes.svg} />
    </Box>
  );
};

type Props = {
  size?: 'sm' | 'md' | 'lg' | 'xl';
} & BoxProps;
