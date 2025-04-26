import { Box, BoxProps } from '@mantine/core';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { IconChristmasTree } from '@tabler/icons-react';
import styles from './EventButton.module.scss';

export const EventButton = ({ className, ...props }: Props) => {
  return (
    <Box
      component={Link}
      href="/events/holiday2023"
      className={`${styles.root} ${className ?? ''}`}
      {...props}
    >
      <IconChristmasTree size={30} strokeWidth={1.5} className={styles.svg} />
    </Box>
  );
};

type Props = {
  size?: 'sm' | 'md' | 'lg' | 'xl';
} & BoxProps;

