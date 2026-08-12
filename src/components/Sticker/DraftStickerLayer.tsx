import { Text } from '@mantine/core';
import clsx from 'clsx';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { EdgeImage } from '~/components/EdgeMedia/EdgeImage';
import {
  candidateDistance,
  flippedButtonOffset,
  placeButtonBoxes,
  shouldFlipPlaceButton,
} from '~/components/Sticker/place-button-position';
import {
  useCreateStickerPlacement,
  useImagePlacementSpace,
} from '~/components/Sticker/placement.util';
import { useOwnedSticker } from '~/components/Sticker/sticker.util';
import { PLACEMENT_SPEND_TYPES } from '~/shared/constants/placement.constants';
import type { StickerInteraction } from '~/store/sticker-placement-draft.store';
import {
  pointerToSurfaceFraction,
  useStickerPlacementDraftStore,
} from '~/store/sticker-placement-draft.store';
import { STICKER_PLACEMENT_MIN_SCALE, stickerMaxScale } from '~/shared/utils/sticker-placement';

/**
 * Where the placer's Buzz goes, from the resolved share rather than a constant.
 *
 * The shares are operator-tunable at runtime, so a string compiled against
 * today's split is a claim about money that can stop being true with no deploy
 * and nothing failing. Undefined while the space loads: saying nothing is the
 * only honest thing to say before the number arrives.
 */
const payoutCopy = (ownerShare: number | undefined) => {
  if (ownerShare == null) return null;
  if (ownerShare >= 1) return 'All of it goes to the creator';
  return `${Math.round(ownerShare * 100)}% goes to the creator`;
};

/** Where the rotate knob sits above the sticker, as a fraction of its height. */
const KNOB_OFFSET = 0.22;

/** Enough for the label and the currency badge at the smallest allowed sticker. */
const BUY_BUTTON_MIN_WIDTH = 132;

/** `mt-2`, in pixels, and the clearance the flipped side is built from. */
const BUY_BUTTON_GAP = 8;

/**
 * The nearest ancestor that clips — the carousel's viewport on the image detail
 * page, whose bottom edge is the bottom of the media box.
 *
 * Returns the element rather than its box: which ancestor clips is a property of
 * the tree and changes only when the tree does, but where it *is* changes on
 * every scroll. Caching the node and reading its rect per measure keeps the rect
 * live while keeping this walk — a `getComputedStyle` per ancestor, each forcing
 * a style recalc — off the pointermove path.
 */
function nearestClipElement(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.overflowX !== 'visible' || style.overflowY !== 'visible') return node;
  }
  return null;
}

const CORNERS = [
  { sx: -1, sy: -1, className: '-left-1.5 -top-1.5 cursor-nwse-resize' },
  { sx: 1, sy: -1, className: '-right-1.5 -top-1.5 cursor-nesw-resize' },
  { sx: -1, sy: 1, className: '-bottom-1.5 -left-1.5 cursor-nesw-resize' },
  { sx: 1, sy: 1, className: '-bottom-1.5 -right-1.5 cursor-nwse-resize' },
];

const rotate = (x: number, y: number, degrees: number) => {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { x: x * cos - y * sin, y: x * sin + y * cos };
};

/**
 * Everything a gesture has to remember from the moment it started.
 *
 * Captured on pointer-down rather than recomputed per move, because both are
 * relative to where the grab happened: a move keeps the sticker under the point
 * you actually grabbed, and a resize holds the opposite corner still. Recomputing
 * either from the current state feeds the result back into its own input, which
 * is what makes a sticker jump to the cursor or crawl away from its anchor.
 */
type Gesture =
  | { mode: 'move'; offsetX: number; offsetY: number }
  | { mode: 'rotate' }
  | { mode: 'resize'; anchorX: number; anchorY: number; sx: number; sy: number; aspect: number };

/**
 * The sticker being positioned, drawn in the image's own media box and dragged
 * directly — no modal, no second copy of the image.
 *
 * Drag the body to move, a corner to resize, the knob above it to rotate, and
 * buy it with the button beneath it. The button lives inside the same transformed
 * element, so it travels and rotates with the sticker rather than sitting in a
 * panel across the screen from the thing it is buying.
 */
export function DraftStickerLayer() {
  const draft = useStickerPlacementDraftStore((state) => state.draft);
  const move = useStickerPlacementDraftStore((state) => state.move);
  const setInteraction = useStickerPlacementDraftStore((state) => state.setInteraction);
  const { sticker } = useOwnedSticker();
  const { space } = useImagePlacementSpace(draft?.imageId);
  const place = useCreateStickerPlacement();
  // The creator's ceiling, so a resize handle stops where the mutation would
  // refuse. The refusal is still on the server — this only means nobody has to
  // discover it by being told no after a drag.
  const maxScale = stickerMaxScale(space?.settings);

  const rootRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  // Held in a ref because the pointer listener is bound once; re-binding it when
  // the space loads would drop the moves in flight at that moment.
  const maxScaleRef = useRef(maxScale);
  maxScaleRef.current = maxScale;

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      // Read through getState rather than subscribing: this listener runs on
      // every pointer move, and re-binding it whenever the draft changes would
      // drop the moves that land during the swap.
      const active = gesture.current;
      if (!active) return;

      const point = pointerToSurfaceFraction(event.clientX, event.clientY);
      const current = useStickerPlacementDraftStore.getState().draft;
      if (!point || !current) return;

      const { bounds } = point;
      const pointerX = event.clientX - bounds.left;
      const pointerY = event.clientY - bounds.top;

      if (active.mode === 'move') {
        move({ x: point.x + active.offsetX, y: point.y + active.offsetY });
        return;
      }

      if (active.mode === 'rotate') {
        const dx = pointerX - current.x * bounds.width;
        const dy = pointerY - current.y * bounds.height;
        // The knob sits above the sticker, so straight up is zero rather than
        // atan2's zero, which points right.
        move({ rotation: (Math.atan2(dy, dx) * 180) / Math.PI + 90 });
        return;
      }

      // Resize holds the opposite corner still, the way every other editor does.
      // Measured in the sticker's own frame, so dragging a corner of a rotated
      // sticker grows it along its own edge rather than the screen's.
      const local = rotate(pointerX - active.anchorX, pointerY - active.anchorY, -current.rotation);
      const width = Math.min(
        Math.max(Math.abs(local.x), STICKER_PLACEMENT_MIN_SCALE * bounds.width),
        maxScaleRef.current * bounds.width
      );
      // Clamped first, then the centre is derived from the clamped size — the
      // other order lets the anchor drift once a drag hits either bound.
      const centre = rotate(
        (active.sx * width) / 2,
        (active.sy * width) / active.aspect / 2,
        current.rotation
      );

      move({
        scale: width / bounds.width,
        x: (active.anchorX + centre.x) / bounds.width,
        y: (active.anchorY + centre.y) / bounds.height,
      });
    };

    const onUp = () => {
      gesture.current = null;
      setInteraction(null);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [move, setInteraction]);

  // Both the tray and the carousel's clipped viewport can swallow the button, so
  // it moves above the sticker when that is the better of the two positions.
  const [{ flipped, flippedOffset }, setPosition] = useState({ flipped: false, flippedOffset: 0 });
  const buttonRef = useRef<HTMLDivElement>(null);

  const rotation = draft?.rotation ?? 0;
  const trayElement = useStickerPlacementDraftStore((state) => state.tray);
  const art = sticker.find((option) => option.id === draft?.cosmeticId);
  // The element the observer needs does not exist until there is something to
  // draw, and neither `draft` nor the sticker list alone is enough to say so.
  const drawn = !!draft && !!art;

  // `measure` is what the ResizeObserver and the window listener are bound to,
  // so it has to keep its identity across a drag — otherwise re-binding them is
  // back on the pointermove path, which is the whole problem. It reads the two
  // values it needs through a ref instead of closing over them.
  const frame = useRef({ flipped, rotation });
  frame.current = { flipped, rotation };

  const clip = useRef<HTMLElement | null>(null);

  const measure = useCallback(() => {
    const element = rootRef.current;
    const button = buttonRef.current;
    if (!element || !button) return;

    const { flipped, rotation } = frame.current;
    const tray = useStickerPlacementDraftStore.getState().tray;
    const height = element.offsetHeight;
    const offset = flippedButtonOffset({
      stickerHeight: height,
      knobOffset: KNOB_OFFSET,
      gap: BUY_BUTTON_GAP,
    });
    // From the button's own measured rect, both times: the pair that comes out
    // is the same whichever side the button is currently on, which is what stops
    // a flip from removing its own cause and oscillating.
    const { below, above } = placeButtonBoxes({
      current: button.getBoundingClientRect(),
      flipped,
      rotationDeg: rotation,
      distance: candidateDistance({
        stickerHeight: height,
        buttonHeight: button.offsetHeight,
        flippedOffset: offset,
        gap: BUY_BUTTON_GAP,
      }),
    });

    const next = {
      flipped: shouldFlipPlaceButton({
        below,
        above,
        tray: tray?.getBoundingClientRect() ?? null,
        clip: clip.current?.getBoundingClientRect() ?? null,
      }),
      flippedOffset: offset,
    };

    // Every pointer move re-measures, so bail on an unchanged result rather
    // than handing React a new object to re-render for.
    setPosition((current) =>
      current.flipped === next.flipped && current.flippedOffset === next.flippedOffset
        ? current
        : next
    );
  }, []);

  const remeasure = useCallback(() => {
    clip.current = rootRef.current ? nearestClipElement(rootRef.current) : null;
    measure();
  }, [measure]);

  // The tray grows when its price line wraps, when the balances land, and when
  // the top-up panel opens — each of those moves the band under an existing
  // draft, with no pointer event to notice it by.
  //
  // The sticker is watched for a different reason: its image has no intrinsic
  // size until it loads, so the first measure on a cold start runs against a
  // near-zero height. Swapping to a taller sticker is the same problem, and the
  // deps cannot see it — `begin()` resets x, y, scale and rotation to the same
  // defaults, so choosing a different sticker produces an identical dep tuple.
  // Both leave a clearance sized for the wrong sticker, which is the covered
  // rotate knob all over again.
  //
  // The button is watched for the third reason: `buttonHeight` feeds the
  // distance between the two positions, and the payout caption under it arrives
  // with a query rather than with the first paint. The decision would otherwise
  // be made against a one-line button and never revisited until the next drag —
  // which is the case `place-button-position.test.ts` covers arithmetically and
  // nothing was re-running. Safe to observe: a flip moves the button, it does
  // not resize it, so this cannot feed itself.
  //
  // None of this is a function of where the sticker currently is, so it is bound
  // once rather than on the pointermove path.
  useLayoutEffect(() => {
    const element = rootRef.current;
    if (!element) return;

    const observer = new ResizeObserver(remeasure);
    observer.observe(element);
    if (buttonRef.current) observer.observe(buttonRef.current);
    if (trayElement) observer.observe(trayElement);
    window.addEventListener('resize', remeasure);
    remeasure();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', remeasure);
    };
  }, [remeasure, trayElement, drawn]);

  // The cheap half, and the only one a gesture reaches: rect and offset reads,
  // no style recalc. Which ancestor clips is a property of the tree, not of the
  // sticker's own transform, so none of these deps can change it.
  useLayoutEffect(() => {
    measure();
  }, [measure, draft?.x, draft?.y, draft?.scale, rotation, flipped]);

  // Picking a sticker up from the tray starts a move with no offset — the press
  // happened outside the image, so there is no grab point to preserve.
  const trayInteraction = useStickerPlacementDraftStore((state) => state.interaction);
  useEffect(() => {
    if (trayInteraction === 'move' && !gesture.current)
      gesture.current = { mode: 'move', offsetX: 0, offsetY: 0 };
  }, [trayInteraction]);

  if (!draft || !art) return null;

  const begin =
    (mode: StickerInteraction, corner?: { sx: number; sy: number }) =>
    (event: React.PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();

      const point = pointerToSurfaceFraction(event.clientX, event.clientY);
      const element = rootRef.current;
      if (!point || !element) return;

      if (mode === 'move') {
        // Keep the sticker where it was relative to the grab, instead of
        // snapping its centre to the cursor.
        gesture.current = {
          mode: 'move',
          offsetX: draft.x - point.x,
          offsetY: draft.y - point.y,
        };
      } else if (mode === 'resize' && corner) {
        const { bounds } = point;
        const width = draft.scale * bounds.width;
        // Layout size, not the bounding box: `offsetWidth` ignores the CSS
        // rotation, so this is the sticker's own aspect ratio rather than the
        // ratio of the box its rotated form happens to occupy.
        const aspect = element.offsetWidth / element.offsetHeight;
        const anchor = rotate(
          (-corner.sx * width) / 2,
          (-corner.sy * width) / aspect / 2,
          draft.rotation
        );

        gesture.current = {
          mode: 'resize',
          anchorX: draft.x * bounds.width + anchor.x,
          anchorY: draft.y * bounds.height + anchor.y,
          sx: corner.sx,
          sy: corner.sy,
          aspect,
        };
      } else {
        gesture.current = { mode: 'rotate' };
      }

      setInteraction(mode);
    };

  return (
    <div
      ref={rootRef}
      className="pointer-events-auto absolute cursor-move"
      style={{
        left: `${draft.x * 100}%`,
        top: `${draft.y * 100}%`,
        width: `${draft.scale * 100}%`,
        transform: `translate(-50%, -50%) rotate(${draft.rotation}deg)`,
        touchAction: 'none',
      }}
      onPointerDown={begin('move')}
    >
      <EdgeImage
        src={art.url}
        alt={`:${art.slug}:`}
        options={{ width: 512, anim: art.animated, optimized: true }}
        style={{ width: '100%', height: 'auto', display: 'block', pointerEvents: 'none' }}
        draggable={false}
      />

      <span className="pointer-events-none absolute inset-0 border-2 border-dashed border-blue-5" />

      {CORNERS.map((corner) => (
        <span
          key={corner.className}
          onPointerDown={begin('resize', corner)}
          className={`absolute size-3 rounded-full border-2 border-white bg-blue-5 ${corner.className}`}
        />
      ))}

      <span
        onPointerDown={begin('rotate')}
        className="absolute left-1/2 size-4 -translate-x-1/2 cursor-grab rounded-full border-2 border-white bg-blue-5"
        style={{ top: `-${KNOB_OFFSET * 100}%` }}
      />

      <div
        ref={buttonRef}
        // `w-max` and the floor together: an absolutely positioned child is
        // shrink-to-fit against its containing block, which here is the sticker
        // itself — so a small sticker was squeezing the button until its label
        // clipped and its currency badge lost its padding. The button's size
        // must not be a function of the sticker's.
        // `items-center` rather than text alignment: the caption can be wider
        // than the button, and a `w-max` box sized by whichever is longer leaves
        // the other one off-centre.
        className={clsx(
          'absolute left-1/2 flex w-max -translate-x-1/2 cursor-auto flex-col items-center gap-1 whitespace-nowrap',
          flipped ? 'bottom-full' : 'top-full mt-2'
        )}
        style={{
          minWidth: BUY_BUTTON_MIN_WIDTH,
          // Scales with the sticker because the knob it has to clear does.
          ...(flipped ? { marginBottom: flippedOffset } : null),
        }}
        // The button is inside the draggable body, so without this every press
        // on it would also start a move and the click would land mid-drag.
        onPointerDown={(event) => event.stopPropagation()}
      >
        <BuzzTransactionButton
          size="sm"
          style={{ minWidth: BUY_BUTTON_MIN_WIDTH }}
          buzzAmount={space?.price ?? 0}
          // Yellow and Green only, matching what the escrow will actually draw.
          // The mutation refuses Blue regardless; this keeps the button from
          // promising a payment that would then be refused.
          accountTypes={PLACEMENT_SPEND_TYPES}
          label="Place"
          loading={place.isPending}
          onPerformTransaction={() =>
            place.mutate({
              imageId: draft.imageId,
              data: {
                cosmeticId: draft.cosmeticId,
                x: draft.x,
                y: draft.y,
                scale: draft.scale,
                rotation: draft.rotation,
              },
            })
          }
        />
        {/* On its own dark chip rather than over the artwork: this sits on
            whatever the creator uploaded, and yellow on light work is as
            unreadable as dimmed was on dark. */}
        {payoutCopy(space?.ownerShare) && (
          <Text
            size="xs"
            fw={500}
            c="yellow.4"
            className="rounded-full bg-black/80 px-2 py-0.5 leading-tight"
          >
            {payoutCopy(space?.ownerShare)}
          </Text>
        )}
      </div>
    </div>
  );
}
