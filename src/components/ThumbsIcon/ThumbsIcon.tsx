import { useComputedColorScheme } from '@mantine/core';
import type { IconProps } from '@tabler/icons-react';
import {
  IconThumbDown,
  IconThumbDownFilled,
  IconThumbUp,
  IconThumbUpFilled,
} from '@tabler/icons-react';

export function ThumbsUpIcon({ filled, ...iconProps }: Props) {
  const colorScheme = useComputedColorScheme('dark');

  return filled ? (
    <IconThumbUpFilled
      color={colorScheme === 'dark' ? undefined : 'var(--mantine-color-white)'}
      {...iconProps}
    />
  ) : (
    <IconThumbUp {...iconProps} />
  );
}

export function ThumbsDownIcon({ filled, ...iconProps }: Props) {
  const colorScheme = useComputedColorScheme('dark');

  return filled ? (
    <IconThumbDownFilled
      color={colorScheme === 'dark' ? undefined : 'var(--mantine-color-white)'}
      {...iconProps}
    />
  ) : (
    <IconThumbDown {...iconProps} />
  );
}

type Props = IconProps & { filled?: boolean };
