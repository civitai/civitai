import { useMantineTheme } from '@mantine/core';
import { IconThumbDown, IconThumbUp, TablerIconsProps } from '@tabler/icons-react';

export function ThumbsUpIcon({ filled, ...iconProps }: Props) {
  const theme = useMantineTheme();

  return filled ? (
    <IconThumbUp
      {...iconProps}
      stroke={1}
      fill="currentColor"
      color={theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.white}
    />
  ) : (
    <IconThumbUp {...iconProps} />
  );
}

export function ThumbsDownIcon({ filled, ...iconProps }: Props) {
  const theme = useMantineTheme();

  return filled ? (
    <IconThumbDown
      {...iconProps}
      stroke={1}
      fill="currentColor"
      color={theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.white}
    />
  ) : (
    <IconThumbDown {...iconProps} />
  );
}

type Props = TablerIconsProps & { filled?: boolean };
