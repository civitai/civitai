import { Group } from '@mantine/core';
import { IconBolt } from '@tabler/icons-react';
import classes from '~/components/Buzz/buzz.module.scss';

const iconSizesRatio = [1, 1.3, 1.6];

interface BuzzTierIconProps {
  tier: number;
}

export function BuzzTierIcon({ tier }: BuzzTierIconProps) {
  return (
    <Group gap={-4} wrap="nowrap">
      {Array.from({ length: 3 }).map((_, i) => (
        <IconBolt
          key={i}
          className={classes.buzzIcon}
          size={20 * iconSizesRatio[i]}
          color="currentColor"
          fill="currentColor"
          opacity={i < tier ? 1 : 0.2}
        />
      ))}
    </Group>
  );
}
