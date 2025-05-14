import { useComputedColorScheme } from '@mantine/core';
import {
  IconThumbDown,
  IconThumbDownFilled,
  IconThumbUp,
  IconThumbUpFilled,
  IconProps,
} from '@tabler/icons-react';

export function ThumbsUpIcon({ filled, ...iconProps }: Props) {
  const colorScheme = useComputedColorScheme();

  return filled ? (
    <IconThumbUpFilled
      {...iconProps}
      color={colorScheme === 'dark' ? undefined : 'var(--mantine-color-white)'}
    />
  ) : (
    <IconThumbUp {...iconProps} />
  );
}

export function ThumbsDownIcon({ filled, ...iconProps }: Props) {
  const colorScheme = useComputedColorScheme();

  return filled ? (
    <IconThumbDownFilled
      {...iconProps}
      color={colorScheme === 'dark' ? undefined : 'var(--mantine-color-white)'}
    />
  ) : (
    <IconThumbDown {...iconProps} />
  );
}

type Props = IconProps & { filled?: boolean };
