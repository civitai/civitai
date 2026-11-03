import { useEffect, useRef, useState } from 'react';
import { IconCheck, IconLock, IconX } from '@tabler/icons-react';
import clsx from 'clsx';
import { useTeamColor } from '~/components/Events/events.utils';
import { HatIcon } from '~/components/HatTurf/HatIcon';
import { useHatTurfCard } from '~/components/HatTurf/HatTurfCardProvider';
import type { HatSpot } from '~/components/HatTurf/HatTurfCardProvider';
import classes from '~/components/HatTurf/HatTurfLayer.module.css';
import { TeamHat } from '~/components/HatTurf/TeamHat';
import { useTurfFeed, useTurfSummary } from '~/components/HatTurf/TurfSummaryProvider';
import { useHatTurfStore } from '~/components/HatTurf/hat-turf.store';
import { useChosenHat } from '~/components/HatTurf/useHatTurf';
import {
  HAT_DEFAULT_SCALE,
  badgeLeader,
  clampSpot,
  hatTone,
  readHatPose,
  turfTopic,
} from '~/components/HatTurf/hat-turf.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { mediaContentRectOf } from '~/components/Sticker/media-content-rect';
import { useSignalTopic } from '~/components/Signals/SignalsProvider';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

type Box = { width: number; height: number; left: number; top: number };

/** An element's offset inside an ancestor, or null when that ancestor is not in its offset chain. */
const offsetWithin = (el: HTMLElement, stop: Element | null) => {
  let x = 0;
  let y = 0;
  let current: HTMLElement | null = el;
  while (current && current !== stop) {
    x += current.offsetLeft;
    y += current.offsetTop;
    current = current.offsetParent as HTMLElement | null;
  }
  return current === stop ? { x, y } : null;
};

/** Mounted only with Hat Turf on, so the signals hub isn't required otherwise. */
function HatTurfLive({ imageId }: { imageId: number }) {
  const feed = useTurfFeed();
  const watch = feed?.watch;
  useEffect(() => watch?.(imageId), [watch, imageId]);
  useSignalTopic(feed ? turfTopic(feed.event, imageId) : undefined);
  return null;
}

const NARROW_PICTURE = 220;
const LOAD_EVENTS = ['load', 'loadedmetadata', 'resize'] as const;
/** How far a dragged hat's centre stays from the card's edge, in px, so its buttons stay reachable. */
const DRAG_MARGIN = 28;

/**
 * Measures the picture like the sticker overlay, so a spot is a fraction of the drawn image, not
 * the letterboxed card, and means the same on image detail.
 */
export function HatTurfLayer({ imageId }: { imageId: number }) {
  // Hooks stay in the inner component so flag-off cards run none.
  return useTurfFeed() ? <HatTurfLayerContent imageId={imageId} /> : null;
}

function HatTurfLayerContent({ imageId }: { imageId: number }) {
  const card = useHatTurfCard();
  const feed = useTurfFeed();
  const summary = useTurfSummary(imageId);
  const user = useCurrentUser();
  const showHats = useHatTurfStore((state) => state.showHats);
  const { cosmeticId } = useChosenHat();
  const teamColor = useTeamColor();
  const utils = trpc.useUtils();
  const place = trpc.hatTurf.place.useMutation();
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Box | null>(null);
  const stickers = feed?.stickers[imageId];
  const active = !!card && (!!card.draft || !!card.placed || !!stickers?.length);

  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    seen.current = new Set((stickers ?? []).map((sticker) => String(sticker.id)));
  }, [stickers]);

  useEffect(() => {
    const node = ref.current;
    const parent = node?.parentElement;
    if (!active || !node || !parent) return;
    let media: HTMLElement | null = null;
    const observer = new ResizeObserver(() => measure());
    observer.observe(node);
    const measure = () => {
      if (!media || media.offsetWidth <= 0 || media.offsetHeight <= 0) return;
      const stop = node.offsetParent;
      const at = offsetWithin(media, stop);
      const self = offsetWithin(node, stop);
      if (!at || !self) return;
      const drawn = mediaContentRectOf(media);
      setBox({
        width: drawn.width,
        height: drawn.height,
        left: at.x - self.x + drawn.left,
        top: at.y - self.y + drawn.top,
      });
    };
    const bind = () => {
      const next = parent.querySelector<HTMLElement>('img, video');
      if (next === media) return;
      if (media) {
        observer.unobserve(media);
        for (const event of LOAD_EVENTS) media.removeEventListener(event, measure);
      }
      media = next;
      if (!media) return;
      observer.observe(media);
      for (const event of LOAD_EVENTS) media.addEventListener(event, measure);
      measure();
    };
    // EdgeMedia can swap the img for a video, or mount the media after this layer.
    const mutations = new MutationObserver(bind);
    mutations.observe(parent, { childList: true, subtree: true });
    bind();
    return () => {
      observer.disconnect();
      mutations.disconnect();
      if (media) for (const event of LOAD_EVENTS) media.removeEventListener(event, measure);
    };
  }, [active]);

  if (!card || !feed) return null;
  const { draft, setDraft, placed, setPlaced } = card;
  const colorOf = (team: string | null | undefined) =>
    (team && teamColor(team)) || 'var(--mantine-color-gray-6)';
  const leader = summary ? badgeLeader(summary) : null;
  const protectedImage = !!summary?.hatted;
  const hatSize = (scale: number) => (box ? Math.max(22, box.width * scale) : 0);
  const mineDrawn = placed
    ? (stickers ?? []).filter((sticker) => sticker.userId !== user?.id)
    : stickers ?? [];
  const drawn = showHats ? mineDrawn.slice(0, box && box.width < NARROW_PICTURE ? 3 : 5) : [];
  const totalShown = summary ? Object.values(summary.shown).reduce((a, b) => a + b, 0) : 0;
  const overflow = showHats ? Math.max(0, totalShown - drawn.length - (placed ? 1 : 0)) : 0;

  const stop = (event: React.SyntheticEvent) => {
    // The card is a link and this sits on top of it.
    event.preventDefault();
    event.stopPropagation();
  };

  const move = (event: React.PointerEvent) => {
    if (!box || !ref.current || !(event.buttons & 1 || event.pointerType === 'touch')) return;
    const rect = ref.current.getBoundingClientRect();
    // On a cropped picture the drawn image is larger than the card: keep the hat on what is visible.
    const px = Math.min(rect.width - DRAG_MARGIN, Math.max(DRAG_MARGIN, event.clientX - rect.left));
    const py = Math.min(rect.height - DRAG_MARGIN, Math.max(DRAG_MARGIN, event.clientY - rect.top));
    setDraft(clampSpot({ x: (px - box.left) / box.width, y: (py - box.top) / box.height }));
  };

  const nudge = (event: React.KeyboardEvent) => {
    const step = 0.03;
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const move = delta[event.key];
    if (!move || !draft) return;
    event.preventDefault();
    setDraft(clampSpot({ x: draft.x + move[0], y: draft.y + move[1] }));
  };

  const save = (spot: HatSpot) => {
    if (!cosmeticId) return;
    place.mutate(
      {
        event: feed.event,
        imageId,
        cosmeticId,
        source: 'feed',
        data: { x: spot.x, y: spot.y, scale: HAT_DEFAULT_SCALE, rotation: 0, flip: false },
      },
      {
        onSuccess: () => {
          setDraft(null);
          setPlaced(spot);
          void utils.hatTurf.getStock.invalidate();
          void utils.hatTurf.getSummaries.invalidate();
          void utils.hatTurf.getStickersForImages.invalidate();
        },
        onError: (error) => showErrorNotification({ title: "Couldn't place the hat", error }),
      }
    );
  };

  const at = (x: number, y: number) => ({ left: `${x * 100}%`, top: `${y * 100}%` });

  return (
    <div ref={ref} className={classes.layer} data-testid="hat-turf-layer" data-sticker-overlay>
      <HatTurfLive imageId={imageId} />
      {box && (
        <div
          className={classes.box}
          style={{ width: box.width, height: box.height, left: box.left, top: box.top }}
        >
          {drawn.map((sticker) => {
            const pose = readHatPose(sticker.data);
            if (!pose) return null;
            const tone = hatTone(sticker.team, leader);
            return (
              <div
                key={String(sticker.id)}
                data-testid="hat-turf-hat"
                data-team={sticker.team}
                data-tone={protectedImage ? 'muted' : tone}
                className={clsx(
                  classes.placed,
                  seen.current && !seen.current.has(String(sticker.id)) && classes.landed,
                  protectedImage ? classes.muted : tone === 'dim' && classes.dim,
                  !protectedImage && tone === 'lead' && classes.lead
                )}
                style={{
                  ...at(pose.x, pose.y),
                  transform: `translate(-50%, -50%) rotate(${pose.rotation}deg) scaleX(${
                    pose.flip ? -1 : 1
                  })`,
                  ['--hat-glow' as string]: colorOf(sticker.team),
                }}
              >
                <TeamHat color={colorOf(sticker.team)} size={hatSize(pose.scale)} />
                {sticker.userId === user?.id && <i className={classes.own} />}
              </div>
            );
          })}
          {showHats && placed && (
            <div
              className={clsx(classes.placed, classes.landed, protectedImage && classes.muted)}
              style={{ ...at(placed.x, placed.y), transform: 'translate(-50%, -50%)' }}
              data-testid="hat-turf-placed"
            >
              <TeamHat color={colorOf(feed.team)} size={hatSize(HAT_DEFAULT_SCALE)} />
            </div>
          )}
          {draft && (
            <>
              <div
                className={classes.draft}
                style={at(draft.x, draft.y)}
                data-testid="hat-turf-draft"
                tabIndex={0}
                role="group"
                aria-label="Hat position. Drag it, or use the arrow keys."
                onKeyDown={nudge}
                onPointerDown={(event) => {
                  stop(event);
                  try {
                    event.currentTarget.setPointerCapture(event.pointerId);
                  } catch {
                    // pointer already ended
                  }
                }}
                onPointerMove={(event) => {
                  stop(event);
                  move(event);
                }}
                onClick={stop}
              >
                <TeamHat color={colorOf(feed.team)} size={hatSize(HAT_DEFAULT_SCALE)} />
              </div>
              <div
                className={classes.actions}
                style={{
                  left: `${draft.x * 100}%`,
                  top: `calc(${draft.y * 100}% + ${hatSize(HAT_DEFAULT_SCALE) / 2 + 10}px)`,
                }}
              >
                <button
                  type="button"
                  className={classes.save}
                  aria-label="Place hat (free, can't be moved afterwards)"
                  disabled={place.isPending || !cosmeticId}
                  onClick={(event) => {
                    stop(event);
                    save(draft);
                  }}
                >
                  <IconCheck size={18} stroke={3} />
                </button>
                <button
                  type="button"
                  className={classes.discard}
                  aria-label="Discard hat"
                  onClick={(event) => {
                    stop(event);
                    setDraft(null);
                  }}
                >
                  <IconX size={14} stroke={3} />
                </button>
              </div>
            </>
          )}
          {overflow > 0 && (
            <div
              className={classes.more}
              data-testid="hat-turf-more"
              title={`${overflow} more hats`}
            >
              <HatIcon size={14} />+{overflow}
            </div>
          )}
          {showHats && protectedImage && leader && (
            <div className={classes.lock} data-testid="hat-turf-lock">
              <IconLock size={11} /> {leader[0].toUpperCase() + leader.slice(1)} would take it
            </div>
          )}
        </div>
      )}
    </div>
  );
}
