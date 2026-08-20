import { Button, Text, Tooltip } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import clsx from 'clsx';
import { useReactionSettingsContext } from '~/components/Reaction/ReactionSettingsProvider';
import { StickerCountChip, useStickerInviteStyle } from '~/components/Sticker/StickerCountChip';
import { StickerHistoryButton } from '~/components/Sticker/StickerHistoryPanel';
import { StickerPlacementTray } from '~/components/Sticker/StickerPlacementTray';
import { barFreeLabel, barTooltip } from '~/components/Sticker/free-offer';
import {
  useFreePlacementAllowance,
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
  const inviteStyle = useStickerInviteStyle();

  const {
    counts,
    isLoading: countsLoading,
    isError: countsError,
  } = useStickerPlacementCounts([imageId]);
  const count = counts[imageId] ?? 0;
  const { space } = useImagePlacementSpace(imageId);

  // The count is approved-only, so an owner whose first placement is still
  // pending had no entry here at all — and therefore no reveal toggle on the
  // page the notification just sent them to.
  const { byImage, isLoading: placementsLoading } = useStickerPlacements([imageId], !!currentUser);
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

  /**
   * The viewer's own half of the answer.
   *
   * One query for the whole page rather than one per card: the allowance belongs
   * to the person, so every bar on a page shares one cache key and one request.
   * That is what makes it affordable to check, and checking is the point — the
   * label below used to be the creator's capacity alone, which promised free
   * placements to people who had already spent theirs.
   *
   * ⚠️ Today this bar has ONE callsite, the image detail view; feed cards mount
   * `StickerPlacementCardBadge`, which cannot place. So the present cost is one
   * request per detail view. The per-card reasoning is for the future this
   * component was written toward, and it is what keeps that future cheap — but
   * do not read "per feed card" here as a description of what ships now.
   *
   * Gated on `canPlace`, which already requires a signed-in viewer — the
   * procedure is protected, so asking without one is a 401 per page it renders
   * on. One condition rather than two so the guard is testable: `!!currentUser`
   * alongside it can never be the reason this is false, so a test claiming to
   * pin it would be asserting something it cannot fail on.
   */
  const { allowance } = useFreePlacementAllowance(canPlace);

  // `null` until BOTH facts are known, and absent rather than paid while the
  // allowance is loading — a label that appears a beat late is quieter than a
  // price that turns into "free" on every card in the feed.
  const freeLabel = canPlace ? barFreeLabel(space ?? undefined, allowance?.remaining) : null;

  // The invitation needs a zero that is KNOWN to be zero. `total` is fed by two
  // separate queries and a failure of either reads as empty, so an image with
  // stickers would otherwise show the invitation — and a press there opens a
  // purchase tray instead of revealing what is already on it. Both queries must
  // have arrived, and the counts one must not have failed.
  const settled = !countsLoading && !placementsLoading && !countsError;
  const inviting = !total && canPlace && settled;

  if (!total && !canPlace) return null;

  return (
    <>
      {/* One control, not two: the count and the way to add to it are the same
          subject, and Button.Group squares the touching corners so the divider
          between them is the shared border rather than a drawn line. */}
      <Button.Group className={clsx(className)}>
        {total > 0 && (
          <StickerCountChip
            count={total}
            revealed={revealed}
            showLabel
            tooltip={revealed ? 'Hide stickers on all images' : 'Show stickers on all images'}
            onClick={toggle}
            // Revealed reads as `hasReacted`, so the toggle's on state borrows
            // the same tint the row already uses for "you did this" instead of
            // introducing a second visual language for on/off.
            buttonProps={buttonStyling?.('AddReaction', revealed)}
          />
        )}

        {/* At zero the chip is the invitation, not a reveal toggle: there is
            nothing to reveal, and a control that visibly does nothing is worse
            than the bare plus it replaced. */}
        {inviting && (
          <StickerCountChip
            count={0}
            revealed={revealed}
            // The same sentence the plus beside it gets. They open the same
            // tray with the same action, so a hand-written price line here
            // would let the two disagree the moment the plus started saying
            // "free, or N Buzz" — which is exactly what this change made it do.
            tooltip={barTooltip({
              price: space?.price ?? 0,
              space: space ?? undefined,
              allowanceRemaining: allowance?.remaining,
              resetsAt: allowance?.resetsAt,
            })}
            // Distinct from the plus beside it, which is also "Place a sticker".
            // They share a Button.Group and an action, so identical names read
            // to a screen reader as the same control announced twice.
            ariaLabel="No stickers yet — place the first one"
            onClick={() => openTray(imageId)}
            buttonProps={buttonStyling?.('BuzzTip')}
          />
        )}

        {/* Only where there is a history to read. At zero the group is an
            invitation to place the first one, and a history button beside it
            opens onto nothing. */}
        {total > 0 && (
          <StickerHistoryButton imageId={imageId} buttonProps={buttonStyling?.('AddReaction')} />
        )}

        {canPlace && (
          <Tooltip
            /**
             * 🔴 The price, always — plus the reason free is unavailable, when
             * it is.
             *
             * `freeSlotsRemaining` alone is the CREATOR's capacity and says
             * nothing about this viewer, which is how the old label promised
             * free to somebody who had spent their day and then charged them a
             * number they were never shown. Both facts are now in hand, so the
             * tooltip can say which of the two ran out instead of leaving the
             * reader to find out by pressing.
             *
             * ⚠️ `freeSlotsRemaining === 0` covers two different facts and only
             * `freeSlots` tells them apart: the resolver short-circuits the
             * reservation count when there is no capacity, so zero is both "this
             * creator takes no free placements" — nothing to say — and "their
             * slots are all currently held", which is worth saying because a
             * decline gives one back. `barTooltip` branches on both.
             *
             * The one rule left un-checked here is "already free-placed on THIS
             * image", which needs a per-image query — affordable on the detail
             * view where this bar lives today, not on the feed it is written
             * toward. The tray checks it before anything is committed, so the
             * residual is an over-offer the tray corrects, never a wrong charge.
             */
            label={barTooltip({
              price: space?.price ?? 0,
              space: space ?? undefined,
              allowanceRemaining: allowance?.remaining,
              resetsAt: allowance?.resetsAt,
            })}
            withArrow
            multiline
            w={260}
          >
            <Button
              size="compact-sm"
              radius="xl"
              variant="light"
              color="yellow"
              onClick={() => openTray(imageId)}
              aria-label={freeLabel ? `Place a sticker · ${freeLabel}` : 'Place a sticker'}
              // A plus rather than a second sticker glyph: beside a count of
              // stickers it reads as "add one" without a word, which is what
              // keeps the fused control narrow enough to belong in this row.
              {...buttonStyling?.('BuzzTip')}
              // Last, and merged over whatever the row's styling set: at zero
              // the plus is half the invitation, so it has to carry the same
              // tint the chip does or the pair reads as two unrelated controls.
              //
              // A free slot borrows the same tint for the same reason it exists:
              // it is the row's own "there is something for you here" language,
              // and inventing a second one for the free tier would make the two
              // states compete rather than agree.
              style={{
                ...buttonStyling?.('BuzzTip')?.style,
                ...(inviting || freeLabel ? inviteStyle : null),
              }}
            >
              <IconPlus size={16} stroke={2.5} />
              {/* Only where the viewer can actually take it. The old label
                  counted the creator's slots and said nothing about the reader,
                  so a spent allowance still read as "1 of 1 free" on every image
                  in the feed. A state worth knowing but not offering — a full
                  space, a spent day — is now said in the tooltip instead, where
                  it can give the reason and the price together. */}
              {freeLabel && (
                <Text size="xs" fw={600} className="ml-1">
                  {freeLabel}
                </Text>
              )}
            </Button>
          </Tooltip>
        )}
      </Button.Group>

      {/* Told which image this bar is for, so a session left open on another
          slide cannot keep the panel on screen bound to an image nobody is
          looking at. */}
      <StickerPlacementTray imageId={imageId} />
    </>
  );
}
