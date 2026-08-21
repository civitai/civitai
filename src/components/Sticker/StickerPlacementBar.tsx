import { Button, CloseButton, Popover, Text } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import clsx from 'clsx';
import { useReactionSettingsContext } from '~/components/Reaction/ReactionSettingsProvider';
import { StickerCountChip, useStickerInviteStyle } from '~/components/Sticker/StickerCountChip';
import { StickerHistoryButton } from '~/components/Sticker/StickerHistoryPanel';
import { StickerPlacementTray } from '~/components/Sticker/StickerPlacementTray';
import { barFreeLabel, freeHintText } from '~/components/Sticker/free-offer';
import {
  useFreePlacementStanding,
  useImagePlacementSpace,
  useStickerPlacementCounts,
  useStickerPlacements,
} from '~/components/Sticker/placement.util';
import { useCallback, useState } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useStickerPlacementDraftStore } from '~/store/sticker-placement-draft.store';
import { useStickerRevealStore } from '~/store/sticker-reveal.store';

/** Where a dismissed free hint is remembered. Per browser, not per session. */
const HINT_DISMISSED_KEY = 'sticker-free-hint-dismissed';

/**
 * The UTC day, as the server means it.
 *
 * Matches `freePlacementDayStart` — the allowance resets at midnight UTC, so a
 * hint dismissed "today" has to mean the same today the allowance does, or it
 * comes back mid-afternoon for anyone west of Greenwich.
 */
const utcDay = () => new Date().toISOString().slice(0, 10);

const readDismissedDay = () => {
  try {
    return localStorage.getItem(HINT_DISMISSED_KEY);
  } catch {
    return null;
  }
};

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
   * The viewer's own half of the answer — all of it, for this image.
   *
   * **The per-image standing rather than the page-wide allowance**, which is a
   * deliberate choice about where this bar lives *today*: one callsite, the
   * image detail view. Feed cards mount `StickerPlacementCardBadge`, which
   * cannot place. So the target-scoped query costs the same single request the
   * untargeted one did, and it answers the third rule as well — "already
   * free-placed on THIS image" — which the untargeted one structurally cannot.
   *
   * 🔴 **When this bar reaches feed cards, this has to change back.** A
   * per-image query renders once per card; the allowance is a property of the
   * person, so the page-wide form (`getFreePlacementAllowance`, still on the
   * service, exposed then as its own procedure) is the affordable one there —
   * at the cost of the chip over-offering on images the viewer has already used.
   * Chosen with Justin, 2026-08-20: complete promise now, cheap promise later.
   *
   * Shares its key with the tray's own standing query, so opening the tray on
   * this image costs nothing extra.
   *
   * Gated on `canPlace`, which already requires a signed-in viewer — the
   * procedure is protected, so asking without one is a 401 per page it renders
   * on. One condition rather than two so the guard is testable: `!!currentUser`
   * alongside it can never be the reason this is false, so a test claiming to
   * pin it would be asserting something it cannot fail on.
   */
  const { standing } = useFreePlacementStanding(imageId, canPlace);

  // `null` until every fact is known, and absent rather than paid while the
  // standing is loading — a label that appears a beat late is quieter than a
  // price that turns into "free".
  const freeLabel = canPlace ? barFreeLabel(space ?? undefined, standing) : null;

  const hint = canPlace ? freeHintText(space ?? undefined, standing) : null;
  const [dismissedDay, setDismissedDay] = useState(readDismissedDay);
  const dismissHint = useCallback(() => {
    const day = utcDay();
    setDismissedDay(day);
    try {
      localStorage.setItem(HINT_DISMISSED_KEY, day);
    } catch {
      // Private mode, or storage full. The hint simply comes back next load —
      // the dismissal is a courtesy, not state anything depends on.
    }
  }, []);

  // Shown only where there is genuinely a free placement to take, and only until
  // it is waved away for the day. Keyed on the UTC day rather than forever
  // because the thing it announces is itself daily: tomorrow's allowance is news
  // again, and a permanent dismissal would mean the feature announces itself
  // exactly once per person, ever.
  const showHint = !!hint && dismissedDay !== utcDay();

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
          /* 🔴 No tooltip. The bar used to explain itself on hover — the price,
             and which scarcity had run out — which meant a phone was told
             nothing at all, in the states where knowing matters most. What is
             left here is the label; the reasons are said in the tray, at the
             point the choice is made, and the one piece of good news gets the
             popover below, which everyone can see and anyone can dismiss. */
          <Popover
            opened={showHint}
            position="top"
            withArrow
            arrowSize={10}
            shadow="md"
            radius="md"
            // Dismissed by its own control only. A click-outside dismissal on a
            // hint anchored to a button people are about to press would count
            // pressing the button as "I have read this".
            trapFocus={false}
            closeOnClickOutside={false}
            closeOnEscape
            onClose={dismissHint}
          >
            <Popover.Target>
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
                // 🔴 Two fixes, one cause: an INLINE background.
                //
                // `Button.Group` squares the corners between its children and
                // leaves the outer ones alone — but this is the group's last
                // child AND `Popover.Target` clones it, so the rounding it
                // should inherit from being last is stated here instead. That
                // is the outside edge of the fused control; square there reads
                // as a rendering fault.
                //
                // And an inline background beats every CSS `:hover` Mantine
                // ships, which is why this row went inert the moment these
                // buttons started carrying the invite tint. A filter has no
                // background of its own to be overridden, so it works over
                // whatever styling the row hands us.
                className="rounded-r-full transition-[filter] duration-150 hover:brightness-110"
              >
                <IconPlus size={16} stroke={2.5} />
                {/* Only where the viewer can actually take it. The old label
                counted the creator's slots and said nothing about the reader,
                so a spent allowance still read as "1 of 1 free" on every image.
                The states worth knowing but not offering — a full space, a
                spent day, one already used here — say nothing at all here and
                are explained in the tray, where the choice is made. */}
                {freeLabel && (
                  <Text size="xs" fw={600} className="ml-1">
                    {freeLabel}
                  </Text>
                )}
              </Button>
            </Popover.Target>
            <Popover.Dropdown
              // The button's own yellow, because it is about that button and
              // nothing else. A neutral card floating over the image reads as a
              // site notice; this reads as the button talking.
              className="border-none bg-yellow-4 px-3 py-2 dark:bg-yellow-6"
            >
              <div className="flex items-center gap-2">
                <Text size="xs" fw={600} c="dark.8">
                  {hint}
                </Text>
                <CloseButton size="xs" c="dark.8" aria-label="Dismiss" onClick={dismissHint} />
              </div>
            </Popover.Dropdown>
          </Popover>
        )}
      </Button.Group>

      {/* Told which image this bar is for, so a session left open on another
          slide cannot keep the panel on screen bound to an image nobody is
          looking at. */}
      <StickerPlacementTray imageId={imageId} />
    </>
  );
}
