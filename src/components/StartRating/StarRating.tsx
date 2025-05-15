import { Group } from '@mantine/core';
import classes from './StarRating.module.scss';

export function StarRating({ value, count = 5, size = 20, fractions = 10 }: Props) {
  return (
    <Group gap={2} align="center" h={size} wrap="nowrap">
      {Array.from({ length: Math.floor(count) }).map((_, index) => {
        const rounded = Math.floor(value);
        const isFilled = index < rounded;
        const delta = !isFilled && index === rounded ? value - rounded : 0;
        const step = 100 / fractions;
        const adjustedDelta = Math.floor((delta * 100) / step) * step;

        return (
          <progress
            key={index}
            className={classes.gauge}
            value={isFilled ? 100 : adjustedDelta}
            max="100"
            style={{ width: size, height: size }}
          />
        );
      })}
    </Group>
  );
}

type Props = { value: number; count?: number; size?: number; fractions?: number };
