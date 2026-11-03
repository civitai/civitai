import { useEffect, useRef, useState } from 'react';
import { IconCheck, IconX } from '@tabler/icons-react';
import { useTeamColor } from '~/components/Events/events.utils';
import { TeamHat } from '~/components/HatTurf/TeamHat';
import { useHatTurfCard } from '~/components/HatTurf/HatTurfCardProvider';
import type { HatSpot } from '~/components/HatTurf/HatTurfCardProvider';
import classes from '~/components/HatTurf/HatTurfDraftLayer.module.css';
import { useTurfFeed } from '~/components/HatTurf/TurfSummaryProvider';
import { useChosenHat } from '~/components/HatTurf/useHatTurf';
import { HAT_DEFAULT_SCALE, clampSpot } from '~/components/HatTurf/hat-turf.utils';
import { mediaContentRectOf } from '~/components/Sticker/media-content-rect';
import { offsetWithin } from '~/components/Sticker/CardStickerOverlay';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

type Box = { width: number; height: number; left: number; top: number };

/**
 * Over the card's picture: the hat being dragged into place with its tick and cross, and the
 * viewer's hat once saved. Measures the picture the way the sticker overlay does, so a spot is a
 * fraction of the drawn image (not of a letterboxed card) and means the same on image detail.
 * Draws nothing when there is neither a draft nor a saved hat.
 */
export function HatTurfDraftLayer({ imageId }: { imageId: number }) {
  const card = useHatTurfCard();
  const feed = useTurfFeed();
  const { cosmeticId } = useChosenHat();
  const teamColor = useTeamColor();
  const utils = trpc.useUtils();
  const place = trpc.hatTurf.place.useMutation();
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Box | null>(null);
  const active = !!card && (!!card.draft || !!card.placed);

  useEffect(() => {
    const node = ref.current;
    const media = node?.parentElement?.querySelector<HTMLElement>('img, video');
    if (!active || !node || !media) return;
    const measure = () => {
      if (media.offsetWidth <= 0 || media.offsetHeight <= 0) return;
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
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    observer.observe(media);
    media.addEventListener('load', measure);
    measure();
    return () => {
      observer.disconnect();
      media.removeEventListener('load', measure);
    };
  }, [active]);

  if (!card || !feed) return null;
  const { draft, setDraft, placed, setPlaced } = card;
  const color = (feed.team && teamColor(feed.team)) || 'var(--mantine-color-gray-6)';
  const hatSize = box ? Math.max(24, box.width * HAT_DEFAULT_SCALE) : 0;

  const stop = (event: React.SyntheticEvent) => {
    // The card is a link and this sits on top of it.
    event.preventDefault();
    event.stopPropagation();
  };

  const move = (event: React.PointerEvent) => {
    if (!box || !ref.current || !(event.buttons & 1 || event.pointerType === 'touch')) return;
    const rect = ref.current.getBoundingClientRect();
    setDraft(
      clampSpot({
        x: (event.clientX - rect.left - box.left) / box.width,
        y: (event.clientY - rect.top - box.top) / box.height,
      })
    );
  };

  const save = (spot: HatSpot) => {
    if (!cosmeticId) return;
    place.mutate(
      {
        event: feed.event,
        imageId,
        cosmeticId,
        data: { x: spot.x, y: spot.y, scale: HAT_DEFAULT_SCALE, rotation: 0, flip: false },
      },
      {
        onSuccess: () => {
          setDraft(null);
          setPlaced(spot);
          void utils.hatTurf.getStock.invalidate();
          void utils.hatTurf.getSummaries.invalidate();
        },
        onError: (error) => showErrorNotification({ title: "Couldn't place the hat", error }),
      }
    );
  };

  const at = (spot: HatSpot) => ({ left: `${spot.x * 100}%`, top: `${spot.y * 100}%` });

  return (
    <div ref={ref} className={classes.layer} data-testid="hat-turf-layer">
      {box && (
        <div
          className={classes.box}
          style={{ width: box.width, height: box.height, left: box.left, top: box.top }}
        >
          {placed && (
            <div className={classes.placed} style={at(placed)} data-testid="hat-turf-placed">
              <TeamHat color={color} size={hatSize} />
            </div>
          )}
          {draft && (
            <>
              <div
                className={classes.draft}
                style={at(draft)}
                data-testid="hat-turf-draft"
                onPointerDown={(event) => {
                  stop(event);
                  try {
                    event.currentTarget.setPointerCapture(event.pointerId);
                  } catch {
                    // The pointer already ended; the drag simply doesn't capture.
                  }
                }}
                onPointerMove={(event) => {
                  stop(event);
                  move(event);
                }}
                onClick={stop}
              >
                <TeamHat color={color} size={hatSize} />
              </div>
              <div
                className={classes.actions}
                style={{
                  left: `${draft.x * 100}%`,
                  top: `calc(${draft.y * 100}% + ${hatSize / 2 + 10}px)`,
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
        </div>
      )}
    </div>
  );
}
