import { Button, Menu, Popover, ScrollArea, Skeleton, Text, Tooltip } from '@mantine/core';
import type { ButtonProps } from '@mantine/core';
import {
  IconArrowBackUp,
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconPlayerPlay,
  IconPlayerStop,
  IconScript,
  IconSettings,
} from '@tabler/icons-react';
import clsx from 'clsx';
import { useEffect, useMemo, useRef, useState } from 'react';
import { EdgeImage } from '~/components/EdgeMedia/EdgeImage';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { orderPlacements, placementRevealDelays } from '~/components/Sticker/placement-order';
import { StickerPlacementHoverCard } from '~/components/Sticker/StickerPlacementHoverCard';
import type { PlacedSticker } from '~/components/Sticker/placement.util';
import { useStickerPlacements } from '~/components/Sticker/placement.util';
import { useStickerCosmetics } from '~/components/Sticker/sticker.util';
import styles from '~/components/Sticker/placement-reveal.module.scss';
import { useStickerHistoryStore } from '~/store/sticker-history.store';
import {
  REPLAY_SPEED,
  REVEAL_SPEEDS,
  revealSpeedLabel,
  useStickerRevealSpeedStore,
} from '~/store/sticker-reveal-speed.store';
import { daysFromNow } from '~/utils/date-helpers';

/**
 * The sticker history: who built this image, in what order, and a replay of it.
 *
 * A popover off the reaction bar rather than a panel in the sidebar (Justin,
 * 2026-08-12). The sidebar is collapsible and often collapsed, and the replay
 * only makes sense while you can see the image it is playing over — a control
 * that scrolls away from the thing it drives is a control you lose.
 */
export function StickerHistoryButton({
  imageId,
  buttonProps,
}: {
  imageId: number;
  buttonProps?: Partial<ButtonProps>;
}) {
  const [opened, setOpened] = useState(false);
  const close = useStickerHistoryStore((state) => state.close);

  // Only the approved ones and the viewer's own pending, same as the overlay —
  // this reads the same query, so the list cannot show a sticker the image does
  // not draw.
  const { byImage, isLoading, isError } = useStickerPlacements([imageId], opened);
  const placements = useMemo(() => orderPlacements(byImage.get(imageId) ?? []), [byImage, imageId]);

  // Closing ends the replay. Leaving a step set would hold the image at a point
  // in its history with nothing on screen explaining why stickers are missing.
  useEffect(() => {
    if (!opened) close();
  }, [opened, close]);

  // The bar is mounted once and handed a new `imageId` as the carousel moves —
  // it does not remount — so without this, arrowing to the next image leaves the
  // popover open, the store pointing at the previous image, and any running
  // replay writing that image's steps from timers that closed over its id. The
  // previous slide stays mounted beside the new one, so it sits there clipped to
  // a step nobody can see the controls for.
  useEffect(() => {
    setOpened(false);
    close();
  }, [imageId, close]);

  // The same unmount, on the way out of the page or a slide change. The store
  // is global and outlives this component.
  useEffect(() => () => close(), [close]);

  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      width={320}
      position="top"
      shadow="md"
      withArrow
      withinPortal
    >
      {/* The button is the target directly. A `Tooltip` in between takes the
          ref and the click handler Popover hands its target and forwards
          neither, so the popover never opens — `title` carries the label
          instead. */}
      <Popover.Target>
        <Button
          size="compact-sm"
          radius="xl"
          variant="light"
          color="gray"
          aria-label="Sticker history"
          title="Sticker history"
          onClick={() => setOpened((o) => !o)}
          {...buttonProps}
        >
          <IconScript size={16} stroke={2} />
        </Button>
      </Popover.Target>

      <Popover.Dropdown p={0}>
        <StickerHistoryList
          imageId={imageId}
          placements={placements}
          isLoading={isLoading}
          isError={isError}
        />
      </Popover.Dropdown>
    </Popover>
  );
}

function StickerHistoryList({
  imageId,
  placements,
  isLoading,
  isError,
}: {
  imageId: number;
  placements: PlacedSticker[];
  isLoading: boolean;
  isError: boolean;
}) {
  const step = useStickerHistoryStore((state) => (state.imageId === imageId ? state.step : null));
  const setStep = useStickerHistoryStore((state) => state.setStep);
  const close = useStickerHistoryStore((state) => state.close);
  const beginRun = useStickerHistoryStore((state) => state.beginRun);
  const advanceRun = useStickerHistoryStore((state) => state.advanceRun);

  const cosmeticIds = useMemo(
    () => placements.map((placement) => placement.data.cosmeticId),
    [placements]
  );
  const { sticker: artwork } = useStickerCosmetics(cosmeticIds);

  const speed = useStickerRevealSpeedStore((state) => state.speed);
  const setSpeed = useStickerRevealSpeedStore((state) => state.setSpeed);

  const delays = useMemo(
    () => placementRevealDelays(placements, { speed: speed * REPLAY_SPEED }),
    [placements, speed]
  );

  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [playing, setPlaying] = useState(false);
  const run = useRef<number | null>(null);

  const stop = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    run.current = null;
    setPlaying(false);
  };

  // Timers outlive the component otherwise. Clearing them here is tidiness, not
  // the guarantee — the popover fades for 150ms before this unmounts, so a timer
  // can still fire after the replay was called off, and what makes that harmless
  // is the run stamp the store checks rather than this cleanup.
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  // Dismissing the popover and changing slide both end the replay through the
  // store, which bumps `runId`. Dropping the timers on the spot stops them
  // queueing behind a run nobody is watching.
  //
  // The reveal toggle is deliberately NOT one of them: a replay keeps running
  // and stays drawn with the reveal off, because the overlay draws whenever a
  // step is set — someone stepping through a history has already asked to see
  // it.
  const runId = useStickerHistoryStore((state) => state.runId);
  useEffect(() => {
    if (run.current !== null && run.current !== runId) stop();
    // `stop` is re-made every render and only reads refs; depending on it would
    // re-run this on every render instead of on a run change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  const play = () => {
    stop();
    if (placements.length < 2) return;
    setPlaying(true);
    const current = beginRun(imageId);
    run.current = current;
    timers.current = delays.slice(1).map((delay, index) =>
      setTimeout(() => {
        // The last one ends the replay rather than leaving the image pinned to
        // its final frame, which is the same picture but with the controls
        // still saying a replay is running.
        const last = index + 1 === placements.length - 1;
        advanceRun(current, imageId, last ? null : index + 1);
        if (last) {
          run.current = null;
          setPlaying(false);
        }
      }, delay)
    );
  };

  // How long until the next sticker lands, for the bar under the header. Zero
  // whenever there is no next one to wait for.
  const stepProgressMs =
    step != null && step + 1 < delays.length ? delays[step + 1] - delays[step] : 0;

  const at = step ?? placements.length - 1;
  const stepTo = (next: number) => {
    stop();
    setStep(imageId, Math.max(0, Math.min(placements.length - 1, next)));
  };

  // Empty and not-yet-known are different answers to the same question, and this
  // panel is the one place they are easy to confuse: a signed-out viewer with
  // the reveal off has nothing primed in the cache, so the empty state would be
  // the first thing they read — the same sentence a genuinely bare image shows.
  if (isLoading)
    return (
      <div className="p-3">
        <Skeleton height={64} radius="md" />
      </div>
    );

  // A failed fetch is also an empty list, and it must not be reported as an
  // image nobody has stickered — the reader would take that as an answer.
  if (isError)
    return (
      <Text size="xs" c="dimmed" className="p-3">
        Couldn&apos;t load the sticker history.
      </Text>
    );

  if (!placements.length)
    return (
      <Text size="xs" c="dimmed" className="p-3">
        No stickers on this image yet.
      </Text>
    );

  return (
    <div className="flex flex-col">
      {/* Everything lives in this row, and every control in it is always
          present — disabled rather than absent. The status and the way back to
          the full image used to be a footer that appeared only while stepping,
          which grew the panel under the cursor: the pointer ended up over a
          sticker in the list, that opened its creator card, and the card was
          then in the way of the thing being read. A panel that never changes
          height cannot do that. */}
      <div className="flex items-center justify-between gap-2 border-b border-gray-3 px-3 py-2 dark:border-dark-4">
        <div className="flex min-w-0 items-baseline gap-2">
          <Text size="xs" fw={600}>
            Sticker history
          </Text>
          {/* Tabular figures and a fixed slot: a count that changes width as it
              counts is the same layout shift in miniature. */}
          <Text size="xs" c="dimmed" className="shrink-0 tabular-nums">
            {step == null ? placements.length : `${step + 1} of ${placements.length}`}
          </Text>
        </div>
        <div className="flex items-center gap-1">
          {/* NOT in a portal. Mantine's popover closes on any click outside its
              own DOM, and a portalled menu is outside it — so choosing a speed
              dismissed the whole panel. Kept inside, the click lands within the
              popover and the menu is absolutely positioned, so it still cannot
              move anything. */}
          <Menu shadow="md" position="bottom-end" withinPortal={false}>
            <Menu.Target>
              <LegacyActionIcon size="sm" variant="subtle" color="gray" aria-label="Reveal speed">
                <IconSettings size={14} />
              </LegacyActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>Reveal speed</Menu.Label>
              {REVEAL_SPEEDS.map((option) => (
                <Menu.Item
                  key={option}
                  onClick={() => setSpeed(option)}
                  leftSection={
                    <IconCheck size={14} className={clsx(option !== speed && 'invisible')} />
                  }
                >
                  {revealSpeedLabel(option)}
                </Menu.Item>
              ))}
            </Menu.Dropdown>
          </Menu>
          <Tooltip label={playing ? 'Stop' : 'Replay'} withArrow>
            <LegacyActionIcon
              size="sm"
              variant="subtle"
              color="gray"
              aria-label={playing ? 'Stop replay' : 'Replay the sticker history'}
              onClick={playing ? () => stop() : play}
              // One sticker has no build to watch, and a replay of it is a
              // button that flickers.
              disabled={placements.length < 2}
            >
              {playing ? <IconPlayerStop size={14} /> : <IconPlayerPlay size={14} />}
            </LegacyActionIcon>
          </Tooltip>
          <Tooltip label="Previous sticker" withArrow>
            <LegacyActionIcon
              size="sm"
              variant="subtle"
              color="gray"
              aria-label="Previous sticker"
              onClick={() => stepTo(at - 1)}
              disabled={at <= 0}
            >
              <IconChevronLeft size={14} />
            </LegacyActionIcon>
          </Tooltip>
          <Tooltip label="Next sticker" withArrow>
            <LegacyActionIcon
              size="sm"
              variant="subtle"
              color="gray"
              aria-label="Next sticker"
              onClick={() =>
                // Past the end is not a step, it is the end of the replay: back
                // to the image as it stands, which is what closing the panel
                // would have shown anyway.
                at >= placements.length - 1 ? setStep(imageId, null) : stepTo(at + 1)
              }
            >
              <IconChevronRight size={14} />
            </LegacyActionIcon>
          </Tooltip>
          <Tooltip label="Show all stickers" withArrow>
            <LegacyActionIcon
              size="sm"
              variant="subtle"
              color="gray"
              aria-label="Show all stickers"
              onClick={() => {
                stop();
                close();
              }}
              // Disabled rather than hidden: it holds its place in the row so
              // nothing moves when a replay starts or ends, and a disabled
              // control reads as "nothing to undo" where a missing one reads as
              // the panel having changed shape.
              disabled={step == null}
            >
              <IconArrowBackUp size={14} />
            </LegacyActionIcon>
          </Tooltip>
        </div>
      </div>

      {/* Always in the layout, so starting a replay cannot change the panel's
          height — the same rule as the controls above it. Empty unless a wait
          is actually in progress. */}
      <div className="h-0.5 w-full bg-transparent">
        {playing && stepProgressMs > 0 && (
          <div
            key={step}
            className={clsx('h-full bg-blue-5', styles.stepProgress)}
            style={{ animationDuration: `${stepProgressMs}ms` }}
          />
        )}
      </div>

      <ScrollArea.Autosize mah={280}>
        <ol className="m-0 flex list-none flex-col gap-px p-0">
          {placements.map((placement, index) => {
            const art = artwork.get(placement.data.cosmeticId);
            // Stepping dims what has not been placed yet, so the list and the
            // image agree about where in the build you are.
            const shown = step == null || index <= step;

            return (
              <li key={placement.id}>
                {/* The same hover card the sticker itself has: who placed it,
                    when, and their creator card. One component, so the answer
                    cannot differ depending on which one you hovered. */}
                <StickerPlacementHoverCard
                  placementId={placement.id}
                  imageId={placement.imageId}
                  placerId={placement.placerId}
                  hasComment={placement.hasComment}
                  pending={placement.isPending}
                >
                  <button
                    type="button"
                    onClick={() => stepTo(index)}
                    className={clsx(
                      'flex w-full items-center gap-2 border-0 bg-transparent px-3 py-1.5 text-left',
                      'cursor-pointer hover:bg-gray-1 dark:hover:bg-dark-6',
                      !shown && 'opacity-40',
                      step != null && index === step && 'bg-gray-1 dark:bg-dark-6'
                    )}
                  >
                    <Text size="xs" c="dimmed" className="w-4 shrink-0 tabular-nums">
                      {index + 1}
                    </Text>
                    {art ? (
                      <EdgeImage
                        src={art.url}
                        alt={`:${art.slug}:`}
                        options={{ width: 64, anim: art.animated, optimized: true }}
                        className="size-8 shrink-0 object-contain"
                      />
                    ) : (
                      <div className="size-8 shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <Text size="xs" fw={500} className="truncate">
                        {art?.name ?? 'Sticker'}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {daysFromNow(new Date(placement.placedAt))}
                        {placement.isPending && ' · awaiting review'}
                      </Text>
                    </div>
                  </button>
                </StickerPlacementHoverCard>
              </li>
            );
          })}
        </ol>
      </ScrollArea.Autosize>
    </div>
  );
}
