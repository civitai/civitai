import { Button, Tooltip } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import clsx from 'clsx';
import { useReactionSettingsContext } from '~/components/Reaction/ReactionSettingsProvider';
import { StickerCountChip } from '~/components/Sticker/StickerCountChip';
import { StickerPlacementTray } from '~/components/Sticker/StickerPlacementTray';
import {
  useImagePlacementSpace,
  useStickerPlacementCounts,
  useStickerPlacements,
} from '~/components/Sticker/placement.util';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useStickerPlacementDraftStore } from '~/store/sticker-placement-draft.store';
import { useStickerRevealStore } from '~/store/sticker-reveal.store';

/**
 * The reaction-bar entry: whether stickers exist here, how many, and the way in
 * to placing one.
 *
 * The reveal is site-wide and sticky rather than per image — pressing it here
 * turns stickers on everywhere until you turn them off, which is why it reads
 * from the store rather than owning state.
 *
 * Styling comes from whatever `ReactionSettingsProvider` this is mounted under,
 * the same way the reaction buttons get theirs, so the row stays consistent
 * without this component knowing anything about the surface it sits on. The hook
 * returns `{}` with no provider, so the base props below are what a surface
 * without one — a feed card, later — would get.
 */
export function StickerPlacementBar({
  imageId,
  className,
}: {
  imageId: number;
  className?: string;
}) {
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  const { buttonStyling } = useReactionSettingsContext();

  const counts = useStickerPlacementCounts([imageId]);
  const count = counts[imageId] ?? 0;
  const { space } = useImagePlacementSpace(imageId);

  // The count is approved-only, so an owner whose first placement is still
  // pending had no entry here at all — and therefore no reveal toggle on the
  // page the notification just sent them to.
  const { byImage } = useStickerPlacements([imageId], !!currentUser);
  const pending = (byImage.get(imageId) ?? []).filter((placement) => placement.isPending).length;

  const openTray = useStickerPlacementDraftStore((state) => state.open);
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

  // Approved plus the viewer's own pending, which is what the toggle reveals.
  const total = count + pending;

  if (!total && !canPlace) return null;

  return (
    <>
      {/* One control, not two: the count and the way to add to it are the same
          subject, and Button.Group squares the touching corners so the divider
          between them is the shared border rather than a drawn line. */}
      <Button.Group className={clsx(className)}>
        {/* At zero the chip is the invitation rather than a reveal toggle:
            there is nothing to reveal, and a control that visibly does nothing
            is worse than the bare plus it replaced. It can only be zero here
            when placing is available, since the early return above covers the
            other case. */}
        <StickerCountChip
          count={total}
          revealed={revealed}
          tooltip={
            total > 0
              ? revealed
                ? 'Hide stickers on all images'
                : 'Show stickers on all images'
              : `Place a sticker · ${space?.price} Buzz`
          }
          onClick={total > 0 ? toggle : () => openTray(imageId)}
          // Revealed reads as `hasReacted`, so the toggle's on state borrows the
          // same tint the row already uses for "you did this" instead of
          // introducing a second visual language for on/off.
          buttonProps={
            total > 0 ? buttonStyling?.('AddReaction', revealed) : buttonStyling?.('BuzzTip')
          }
        />

        {canPlace && (
          <Tooltip label={`Place a sticker · ${space?.price} Buzz`} withArrow>
            <Button
              size="compact-sm"
              radius="xl"
              variant="light"
              color="yellow"
              onClick={() => openTray(imageId)}
              aria-label="Place a sticker"
              // A plus rather than a second sticker glyph: beside a count of
              // stickers it reads as "add one" without a word, which is what
              // keeps the fused control narrow enough to belong in this row.
              {...buttonStyling?.('BuzzTip')}
            >
              <IconPlus size={16} stroke={2.5} />
            </Button>
          </Tooltip>
        )}
      </Button.Group>

      <StickerPlacementTray />
    </>
  );
}
