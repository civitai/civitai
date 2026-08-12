import { Text } from '@mantine/core';
import { IconX } from '@tabler/icons-react';
import clsx from 'clsx';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { EdgeImage } from '~/components/EdgeMedia/EdgeImage';
import type { Gesture } from '~/components/Sticker/draft-gesture';
import { KNOB_OFFSET, rotate } from '~/components/Sticker/draft-gesture';
import {
  candidateDistance,
  flippedButtonOffset,
  placeButtonBoxes,
  shouldFlipPlaceButton,
} from '~/components/Sticker/place-button-position';
import { useCreateStickerPlacement } from '~/components/Sticker/placement.util';
import type { ResolvedSticker } from '~/components/Sticker/sticker.util';
import type { StickerTreatment } from '~/components/Sticker/treatments/sticker-treatments';
import { PLACEMENT_SPEND_TYPES } from '~/shared/constants/placement.constants';
import type { StickerDraft } from '~/store/sticker-placement-draft.store';
import {
  pointerToSurfaceFraction,
  useStickerPlacementDraftStore,
} from '~/store/sticker-placement-draft.store';

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

/**
 * One sticker being positioned, drawn in the image's own media box.
 *
 * Every draft carries its own controls, so any of them can be adjusted or bought
 * without being selected first — placing is one click, not two.
 *
 * ⚠️ The buy buttons do not avoid each other. Each one knows about the tray and
 * the clipping viewport and nothing else, so two stickers close together get
 * overlapping buttons. Teaching them to avoid each other is the obvious fix and
 * the wrong one: A flips to clear B, which moves B's obstacle, which flips B,
 * and the pair never settles. Selection raises z-order so the one last touched
 * is on top and reachable; beyond that, moving the stickers apart is the fix.
 */
export function DraftSticker({
  draft,
  art,
  selected,
  dressed,
  price,
  ownerShare,
  onGesture,
}: {
  draft: StickerDraft;
  art: ResolvedSticker;
  /** Only decides what is on top. Every draft carries its own controls. */
  selected: boolean;
  dressed: StickerTreatment;
  price: number;
  ownerShare: number | undefined;
  onGesture: (gesture: Gesture) => void;
}) {
  const select = useStickerPlacementDraftStore((state) => state.select);
  const cancelDraft = useStickerPlacementDraftStore((state) => state.cancelDraft);
  const place = useCreateStickerPlacement(draft.id);

  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLDivElement>(null);

  // Both the tray and the carousel's clipped viewport can swallow the button, so
  // it moves above the sticker when that is the better of the two positions.
  const [{ flipped, flippedOffset }, setPosition] = useState({ flipped: false, flippedOffset: 0 });
  const trayElement = useStickerPlacementDraftStore((state) => state.tray);

  // `measure` is what the ResizeObserver and the window listener are bound to,
  // so it has to keep its identity across a drag — otherwise re-binding them is
  // back on the pointermove path, which is the whole problem. It reads the two
  // values it needs through a ref instead of closing over them.
  const frame = useRef({ flipped, rotation: draft.rotation });
  frame.current = { flipped, rotation: draft.rotation };

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
  // deps cannot see it.
  //
  // The button is watched for the third reason: `buttonHeight` feeds the
  // distance between the two positions, and the payout caption under it arrives
  // with a query rather than with the first paint. The decision would otherwise
  // be made against a one-line button and never revisited until the next drag.
  // Safe to observe: a flip moves the button, it does not resize it, so this
  // cannot feed itself.
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
    // No `selected` here: it decides z-order and nothing this measures. The
    // component only exists while its draft does, so the element is committed
    // before this first runs.
  }, [remeasure, trayElement]);

  // The cheap half, and the only one a gesture reaches: rect and offset reads,
  // no style recalc. Which ancestor clips is a property of the tree, not of the
  // sticker's own transform, so none of these deps can change it.
  useLayoutEffect(() => {
    measure();
  }, [measure, draft.x, draft.y, draft.scale, draft.rotation, flipped]);

  const begin =
    (mode: Gesture['mode'], corner?: { sx: number; sy: number }) => (event: React.PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();

      // Pressing an unselected sticker both selects it and starts the drag, so
      // reaching one of several takes one gesture rather than two.
      select(draft.id);

      const point = pointerToSurfaceFraction(event.clientX, event.clientY);
      const element = rootRef.current;
      if (!point || !element) return;

      if (mode === 'move') {
        // Keep the sticker where it was relative to the grab, instead of
        // snapping its centre to the cursor.
        onGesture({
          draftId: draft.id,
          mode: 'move',
          offsetX: draft.x - point.x,
          offsetY: draft.y - point.y,
        });
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

        onGesture({
          draftId: draft.id,
          mode: 'resize',
          anchorX: draft.x * bounds.width + anchor.x,
          anchorY: draft.y * bounds.height + anchor.y,
          sx: corner.sx,
          sy: corner.sy,
          aspect,
        });
      } else {
        onGesture({ draftId: draft.id, mode: 'rotate' });
      }
    };

  const artworkImage = (
    <EdgeImage
      src={art.url}
      alt={`:${art.slug}:`}
      options={{ width: 512, anim: art.animated, optimized: true }}
      style={{
        width: '100%',
        height: 'auto',
        display: 'block',
        pointerEvents: 'none',
        ...dressed.imageStyle?.detail,
      }}
      draggable={false}
    />
  );

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
        // The one thing selection still decides. Two drafts close together have
        // overlapping buy buttons, and the one just touched should be the one
        // the next click reaches.
        zIndex: selected ? 1 : undefined,
      }}
      onPointerDown={begin('move')}
    >
      {/* The wrapper's own transform makes it a stacking context, so a negative
          z-index here stays behind the sticker without reaching behind the
          artwork the sticker sits on. */}
      {dressed.behind && (
        <span
          aria-hidden
          className={dressed.behind.className}
          style={{ zIndex: -1, ...dressed.behind.style }}
        />
      )}

      {/* Dressed exactly as it will be once bought. A draft drawn bare is a
          preview of something else: the treatment changes the silhouette — a
          die-cut edge and a plate both grow the sticker's apparent bounds — so
          positioning against the undressed version means moving it again after
          paying. */}
      {dressed.animationClassName ? (
        <div className={dressed.animationClassName}>{artworkImage}</div>
      ) : (
        artworkImage
      )}

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

      {/* Offset diagonally out past the corner handle rather than replacing it —
          all four corners resize, and losing one to a destructive action on the
          only corner a right-hander reaches first is worse than the crowding.
          Dark rather than the handles' blue: it is the one control here that
          throws work away. */}
      <button
        type="button"
        aria-label="Remove this sticker"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => cancelDraft(draft.id)}
        className="absolute -right-7 -top-7 flex size-5 cursor-pointer items-center justify-center rounded-full border-2 border-white bg-dark-7 text-white"
      >
        <IconX size={10} stroke={3} />
      </button>

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
          buzzAmount={price}
          // Yellow and Green only, matching what the escrow will actually
          // draw. The mutation refuses Blue regardless; this keeps the button
          // from promising a payment that would then be refused.
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
        {payoutCopy(ownerShare) && (
          <Text
            size="xs"
            fw={500}
            c="yellow.4"
            className="rounded-full bg-black/80 px-2 py-0.5 leading-tight"
          >
            {payoutCopy(ownerShare)}
          </Text>
        )}
      </div>
    </div>
  );
}
