import { Box, HoverCard, Menu, Stack, Text, ThemeIcon } from '@mantine/core';
import {
  IconAlertTriangle,
  IconCheck,
  IconRecycle,
  IconRestore,
  IconTrash,
  IconUser,
} from '@tabler/icons-react';
import React from 'react';
import { imageStore, useImageStore } from '~/store/image.store';
import { trpc } from '~/utils/trpc';
import type { ImageContextMenuProps } from '~/components/Image/ContextMenu/ImageMenuItems';
import { useImageContext } from '~/components/Image/ImageProvider';

export function NeedsReviewBadge({ image }: ImageContextMenuProps) {
  const { isModerator } = useImageContext();
  const { needsReview: initialNeedsReview, ingestion: initialIngestion, id: imageId } = image;
  const { needsReview, ingestion } = useImageStore({
    id: imageId,
    needsReview: initialNeedsReview,
    ingestion: initialIngestion,
  });
  const moderateImagesMutation = trpc.image.moderate.useMutation();
  if (!needsReview && ingestion !== 'Blocked') return null;

  const handleModerate = (action: 'block' | 'unblock') => {
    if (!isModerator) return;
    moderateImagesMutation.mutate({
      ids: [imageId],
      reviewAction: action,
    });
    imageStore.setImage(imageId, { needsReview: null, ingestion: 'Scanned' });
  };

  const Badge = (
    <ThemeIcon size="lg" color={needsReview === 'csam' && isModerator ? 'red' : 'yellow'}>
      {needsReview === 'poi' ? (
        <IconUser strokeWidth={2.5} size={26} />
      ) : (
        <IconAlertTriangle strokeWidth={2.5} size={26} />
      )}
    </ThemeIcon>
  );

  if (needsReview && needsReview !== 'csam' && isModerator) {
    return (
      <Menu position="bottom">
        <Menu.Target>
          <Box
            style={{ cursor: 'pointer' }}
            onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            {Badge}
          </Box>
        </Menu.Target>
        <Menu.Dropdown
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <Menu.Item
            onClick={() => handleModerate('unblock')}
            leftSection={<IconCheck size={14} stroke={1.5} />}
          >
            Approve
          </Menu.Item>
          <Menu.Item
            onClick={() => handleModerate('block')}
            leftSection={<IconTrash size={14} stroke={1.5} />}
          >
            Reject
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    );
  } else if (isModerator && ingestion === 'Blocked') {
    return (
      <Menu position="bottom">
        <Menu.Target>
          <Box
            style={{ cursor: 'pointer' }}
            onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            <ThemeIcon size="lg" color="yellow">
              <IconRecycle strokeWidth={2.5} size={20} />
            </ThemeIcon>
          </Box>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item
            onClick={() => handleModerate('unblock')}
            leftSection={<IconRestore size={14} stroke={1.5} />}
          >
            Restore
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    );
  } else {
    return (
      <HoverCard width={200} withArrow>
        <HoverCard.Target>{Badge}</HoverCard.Target>
        <HoverCard.Dropdown p={8}>
          <Stack gap={0}>
            <Text fw="bold" size="xs">
              Flagged for review
            </Text>
            <Text size="xs">
              {`This image won't be visible to other users until it's reviewed by our moderators.`}
            </Text>
          </Stack>
        </HoverCard.Dropdown>
      </HoverCard>
    );
  }
}
