import { Badge, BadgeProps, Stack, Text } from '@mantine/core';

import { IconEyeOff } from '@tabler/icons';
import React from 'react';
import { useMediaContext } from '~/components/Media/mediaContext';
import { MediaPlaceholder } from '~/components/Media/MediaPlaceholder';
import { MediaTarget } from '~/components/Media/MediaTarget';

export function MediaNsfwToggle({
  placeholder,
  ...badgeProps
}: { placeholder: React.ReactElement } & Omit<BadgeProps, 'children'>) {
  const { nsfw, showNsfw } = useMediaContext();

  const badge = (
    <Badge
      component="div"
      color="red"
      variant="filled"
      size="sm"
      sx={(theme) => ({
        cursor: 'pointer',
        userSelect: 'none',
        position: 'absolute',
        top: theme.spacing.xs,
        left: theme.spacing.md,
        zIndex: 10,
      })}
      {...badgeProps}
    >
      {!showNsfw ? 'Show' : 'Hide'}
    </Badge>
  );

  if (!nsfw) return null;
  return (
    <>
      <MediaPlaceholder>
        {placeholder}
        <Stack
          align="center"
          spacing={0}
          sx={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%,-50%)',
          }}
        >
          <IconEyeOff size={20} color="white" />
          <Text color="white">Sensitive Content</Text>
          <Text size="xs" color="white" align="center">
            This is marked as NSFW
          </Text>
        </Stack>
      </MediaPlaceholder>
      <MediaTarget>{badge}</MediaTarget>
    </>
  );
}
