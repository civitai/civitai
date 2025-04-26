import React from 'react';
import { Box, Group } from '@mantine/core';
import { IconStar } from '@tabler/icons-react';
import styles from './StarRating.module.scss';
import clsx from 'clsx';

type StarRatingProps = {
  value: number;
  onChange?: (value: number) => void;
  size?: number;
  max?: number;
  readOnly?: boolean;
};

export function StarRating({
  value,
  onChange,
  size = 20,
  max = 5,
  readOnly = false,
}: StarRatingProps) {
  return (
    <Group spacing={4}>
      {Array.from({ length: max }).map((_, index) => (
        <Box
          key={index}
          className={clsx(styles.star, {
            [styles.starFilled]: index < value,
            [styles.starEmpty]: index >= value,
          })}
          onClick={() => !readOnly && onChange?.(index + 1)}
          style={{ cursor: readOnly ? 'default' : 'pointer' }}
        >
          <IconStar size={size} fill="currentColor" />
        </Box>
      ))}
    </Group>
  );
}
