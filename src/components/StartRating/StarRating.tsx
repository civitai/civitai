import { Box, Group } from '@mantine/core';
import styles from './StarRating.module.scss';

export function StarRating({ value, count = 5, size = 20, fractions = 10 }: Props) {
  return (
    <Group spacing={2} align="center" h={size} noWrap>
      {Array.from({ length: Math.floor(count) }).map((_, index) => {
        const rounded = Math.floor(value);
        const isFilled = index < rounded;
        const delta = !isFilled && index === rounded ? value - rounded : 0;
        const step = 100 / fractions;
        const adjustedDelta = Math.floor((delta * 100) / step) * step;

        return (
          <Box
            component="progress"
            key={index}
            className={styles.gauge}
            value={isFilled ? 100 : adjustedDelta}
            max="100"
            sx={{ position: 'relative', width: size, height: size, marginTop: -4 }}
          />
        );
      })}
    </Group>
  );
}

type Props = { value: number; count?: number; size?: number; fractions?: number };

