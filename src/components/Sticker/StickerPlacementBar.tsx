import { Button, Group, Text, Tooltip } from '@mantine/core';
import { IconSticker } from '@tabler/icons-react';
import clsx from 'clsx';
import { useState } from 'react';
import { StickerPlacementEditor } from '~/components/Sticker/StickerPlacementEditor';
import {
  useImagePlacementSpace,
  useStickerPlacementCounts,
} from '~/components/Sticker/placement.util';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useStickerRevealStore } from '~/store/sticker-reveal.store';

/**
 * The reaction-bar entry: whether stickers exist here, how many, and the way in
 * to placing one.
 *
 * The reveal is site-wide and sticky rather than per image — pressing it here
 * turns stickers on everywhere until you turn them off, which is why it reads
 * from the store rather than owning state.
 */
export function StickerPlacementBar({
  imageId,
  imageUrl,
  className,
}: {
  imageId: number;
  imageUrl: string;
  className?: string;
}) {
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  const [editing, setEditing] = useState(false);

  const counts = useStickerPlacementCounts([imageId]);
  const count = counts[imageId] ?? 0;
  const { space } = useImagePlacementSpace(imageId);

  const revealed = useStickerRevealStore((state) => state.revealed);
  const toggle = useStickerRevealStore((state) => state.toggle);

  // The creator has not opened this space and nobody has placed anything, so
  // there is nothing to say. Once a placement exists the entry stays, even if
  // the space is later closed — those placements were accepted.
  const canPlace =
    !!features.stickerPlacement &&
    !!space &&
    space.mode !== 'off' &&
    space.price != null &&
    !!currentUser &&
    currentUser.id !== space.ownerId;

  if (!count && !canPlace) return null;

  return (
    <>
      <Group gap={4} className={clsx(className)}>
        {count > 0 && (
          <Tooltip
            label={revealed ? 'Hide stickers on all images' : 'Show stickers on all images'}
            withArrow
          >
            <Button
              size="compact-sm"
              variant={revealed ? 'filled' : 'light'}
              color="gray"
              onClick={toggle}
              leftSection={<IconSticker size={16} />}
            >
              <Text size="xs" fw={600}>
                {count}
              </Text>
            </Button>
          </Tooltip>
        )}

        {canPlace && (
          <Tooltip label={`Place a sticker · ${space?.price} Buzz`} withArrow>
            <Button
              size="compact-sm"
              variant="light"
              color="yellow"
              onClick={() => setEditing(true)}
              leftSection={<IconSticker size={16} />}
            >
              <Text size="xs" fw={600}>
                Place
              </Text>
            </Button>
          </Tooltip>
        )}
      </Group>

      {editing && (
        <StickerPlacementEditor
          imageId={imageId}
          imageUrl={imageUrl}
          price={space?.price ?? 0}
          requiresReview={space?.mode === 'review'}
          onClose={() => setEditing(false)}
        />
      )}
    </>
  );
}
