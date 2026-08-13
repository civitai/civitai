import {
  ActionIcon,
  Popover,
  Slider,
  Text,
  Textarea,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { IconDropletHalf2, IconFlipHorizontal, IconMessage, IconTrash } from '@tabler/icons-react';
import clsx from 'clsx';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { EdgeImage } from '~/components/EdgeMedia/EdgeImage';
import type { Gesture, StartGesture } from '~/components/Sticker/draft-gesture';
import { KNOB_OFFSET, rotate } from '~/components/Sticker/draft-gesture';
import {
  candidateDistance,
  flippedButtonOffset,
  panelBandFor,
  panelsFitInsideEdges,
  placeButtonBoxes,
  shouldFlipPlaceButton,
} from '~/components/Sticker/place-button-position';
import { payoutCopy } from '~/components/Sticker/payout-copy';
import { stickerArtworkStyle } from '~/components/Sticker/placement-appearance';
import { useCreateStickerPlacement } from '~/components/Sticker/placement.util';
import type { ResolvedSticker } from '~/components/Sticker/sticker.util';
import type { StickerTreatment } from '~/components/Sticker/treatments/sticker-treatments';
import { PLACEMENT_SPEND_TYPES } from '~/shared/constants/placement.constants';
import {
  STICKER_COMMENT_MAX_LENGTH,
  STICKER_PLACEMENT_MIN_OPACITY,
} from '~/shared/utils/sticker-placement';
import type { StickerDraft } from '~/store/sticker-placement-draft.store';
import {
  pointerToSurfaceFraction,
  useStickerPlacementDraftStore,
} from '~/store/sticker-placement-draft.store';

/** Enough for the label and the currency badge at the smallest allowed sticker. */
const BUY_BUTTON_MIN_WIDTH = 132;

/**
 * Fixed, because the cluster is `w-max` and sized by its widest child — an
 * autosizing field would widen the whole thing as you type, and the cluster's
 * width feeds the overlap test that decides which side the button sits on.
 */
const NOTE_WIDTH = 220;

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
  ownerUsername,
  onGesture,
}: {
  draft: StickerDraft;
  art: ResolvedSticker;
  /** Only decides what is on top. Every draft carries its own controls. */
  selected: boolean;
  dressed: StickerTreatment;
  price: number;
  ownerShare: number | undefined;
  ownerUsername: string | null | undefined;
  onGesture: StartGesture;
}) {
  const payout = payoutCopy(ownerShare, ownerUsername);
  const select = useStickerPlacementDraftStore((state) => state.select);
  const cancelDraft = useStickerPlacementDraftStore((state) => state.cancelDraft);
  const move = useStickerPlacementDraftStore((state) => state.move);
  const place = useCreateStickerPlacement(draft.id);

  // Local to the draft rather than in the store: it is written once, read once
  // at purchase, and putting it in the store would make every keystroke a
  // store write that re-renders the layer mid-arrangement.
  const [note, setNote] = useState('');
  const [writingNote, setWritingNote] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLDivElement>(null);

  // Both the tray and the carousel's clipped viewport can swallow the button, so
  // it moves above the sticker when that is the better of the two positions.
  // `panelsInside` rides along because it is decided from the same measurement:
  // the panels sit against the sticker's edges while there is room for them
  // there, and a narrower draft hands its controls to the buy cluster instead.
  const [{ flipped, flippedOffset, panelsInside }, setPosition] = useState({
    flipped: false,
    flippedOffset: 0,
    // Starts false, which puts the controls in the buy cluster — the layout
    // that is correct at any size. The real value lands from the layout effect
    // before paint, so this is never seen; it is the safe direction to be wrong
    // in if that ever stops being true.
    panelsInside: false,
  });
  const trayElement = useStickerPlacementDraftStore((state) => state.tray);

  // `measure` is what the ResizeObserver and the window listener are bound to,
  // so it has to keep its identity across a drag — otherwise re-binding them is
  // back on the pointermove path, which is the whole problem. It reads the
  // values it needs through a ref instead of closing over them.
  const frame = useRef({ flipped, rotation: draft.rotation, panelsInside });
  frame.current = { flipped, rotation: draft.rotation, panelsInside };

  const clip = useRef<HTMLElement | null>(null);

  const measure = useCallback(() => {
    const element = rootRef.current;
    const button = buttonRef.current;
    if (!element || !button) return;

    const { flipped, rotation, panelsInside } = frame.current;
    const tray = useStickerPlacementDraftStore.getState().tray;
    const height = element.offsetHeight;
    // Layout size, not the bounding box: `offsetWidth` ignores the CSS rotation,
    // and the panels are children of the rotated element — they are laid out
    // against the sticker's own width whatever angle it is at.
    const width = element.offsetWidth;
    const offset = flippedButtonOffset({
      stickerHeight: height,
      knobOffset: KNOB_OFFSET,
      gap: BUY_BUTTON_GAP,
      // The panels are the other thing above the sticker, and the only one that
      // does not scale with it — and on a narrow draft they are not drawn at
      // all, so there is nothing there to clear. Clearing a band that is not
      // there only costs the button a flip it could have taken.
      panelBand: panelBandFor(width, panelsInside),
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
      panelsInside: panelsFitInsideEdges(width, panelsInside),
    };

    // Every pointer move re-measures, so bail on an unchanged result rather
    // than handing React a new object to re-render for.
    setPosition((current) =>
      current.flipped === next.flipped &&
      current.flippedOffset === next.flippedOffset &&
      current.panelsInside === next.panelsInside
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

    // `measure`, not `remeasure`: a resize gesture rewrites `scale` every frame,
    // which resizes the root, which fires this — so refreshing the clip here put
    // the ancestor walk back on the pointermove path for one of the three
    // gestures, which is exactly what the comment above claims it does not do. A
    // size change cannot move the clipping ancestor, so there is nothing to
    // re-derive; mount, a tray change and a window resize still do.
    const observer = new ResizeObserver(measure);
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
    // before this first runs. `measure` and `remeasure` are both permanently
    // stable, so this still binds once.
  }, [measure, remeasure, trayElement]);

  // The cheap half, and the only one a gesture reaches: rect and offset reads,
  // no style recalc. Which ancestor clips is a property of the tree, not of the
  // sticker's own transform, so none of these deps can change it.
  //
  // `panelsInside` is in here because it moves the controls between the panels
  // and the cluster, which changes the cluster's height — an input to the flip
  // decision. The ResizeObserver would catch it a beat later; this measures on
  // the same commit that moved them.
  useLayoutEffect(() => {
    measure();
  }, [measure, draft.x, draft.y, draft.scale, draft.rotation, flipped, panelsInside]);

  const begin =
    (mode: Gesture['mode'], corner?: { sx: number; sy: number }) => (event: React.PointerEvent) => {
      // `preventDefault` also suppresses the compatibility `mousedown` — measured
      // in Chromium, and `stopPropagation` alone does not do it. That is what
      // keeps an open opacity slider alive through a drag, resize or rotate:
      // Mantine's click-outside listens for `mousedown`, so a press on the
      // sticker never reaches it. Removing this would close the popover on every
      // gesture.
      event.preventDefault();
      event.stopPropagation();

      const point = pointerToSurfaceFraction(event.clientX, event.clientY);
      const element = rootRef.current;
      if (!point || !element) return;

      // Selection follows the gesture rather than the press. Pressing an
      // unselected sticker both selects it and starts the drag — one gesture,
      // not two — but a press that is REFUSED because another pointer already
      // holds a drag must not move the selection either, or the highlight and
      // the z-order land on a sticker nobody is dragging.
      //
      // Capturing the pointer is what lets the layer trust the id alone: the up
      // or cancel is then delivered to this element wherever the pointer goes,
      // including outside the window, so a drag cannot be stranded by an event
      // that never arrives. Touch pointers are captured implicitly already; this
      // is what brings mouse and pen up to the same guarantee. It can throw if
      // the pointer is no longer active by the time we get here, which is not a
      // reason to abandon a gesture that is otherwise fine.
      const target = event.currentTarget;
      const take = (gesture: Gesture) => {
        if (!onGesture(gesture)) return;
        select(draft.id);
        try {
          target.setPointerCapture(gesture.pointerId);
        } catch {
          // Pointer already gone; the layer's own up/cancel handling still ends it.
        }
      };

      if (mode === 'move') {
        // Keep the sticker where it was relative to the grab, instead of
        // snapping its centre to the cursor.
        take({
          draftId: draft.id,
          pointerId: event.pointerId,
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

        take({
          draftId: draft.id,
          pointerId: event.pointerId,
          mode: 'resize',
          anchorX: draft.x * bounds.width + anchor.x,
          anchorY: draft.y * bounds.height + anchor.y,
          sx: corner.sx,
          sy: corner.sy,
          aspect,
        });
      } else {
        take({
          draftId: draft.id,
          pointerId: event.pointerId,
          mode: 'rotate',
        });
      }
    };

  // Selects as well as stopping the drag, so the lower of two stacked drafts
  // does not have controls buried under its neighbour — `selected` is the only
  // input to z-order. Gated on there being no live gesture, the same rule
  // `take()` applies: a press that arrives while another finger is dragging must
  // not move the selection, or the sticker being dragged drops behind its
  // neighbour under the finger holding it.
  const pressPanel = (event: React.PointerEvent) => {
    event.stopPropagation();
    if (!useStickerPlacementDraftStore.getState().interaction) select(draft.id);
  };

  const flipControl = (
    <Tooltip label={draft.flip ? 'Unflip' : 'Flip'} withinPortal>
      <ActionIcon
        size="sm"
        radius="xl"
        variant="subtle"
        color={draft.flip ? 'blue' : 'gray'}
        aria-label={draft.flip ? 'Unflip this sticker' : 'Flip this sticker'}
        onClick={() => move(draft.id, { flip: !draft.flip })}
      >
        <IconFlipHorizontal size={14} />
      </ActionIcon>
    </Tooltip>
  );

  // The slider is behind a control rather than always on screen: it is set once,
  // and a slider parked on the artwork would be in the way of every later drag.
  //
  // Open state is held here rather than inside the Popover because the control
  // itself does not survive: the flush panels and the buy cluster are different
  // places in the tree, so a draft resized across the panel threshold unmounts
  // whichever one it was in. Uncontrolled, that closed an open slider mid-drag —
  // a window resize was enough, since the sticker's width is a fraction of the
  // media box. `trapFocus` is the other half: the dropdown is genuinely rebuilt,
  // so focus has to be put back into it rather than merely not taken away.
  //
  // Returning focus on close is ours rather than Mantine's `returnFocus`, which
  // is inert in exactly the case this exists for. `useFocusReturn` captures the
  // element to return to inside a `useDidUpdate`, and that hook skips its first
  // invocation — so a Popover REMOUNTING with `opened` already true never
  // captures anything, and the close then restores to null. A ref here is
  // re-attached to whichever control is currently mounted, so it survives the
  // swap by construction. (`Popover.Target` merges the child's own ref rather
  // than replacing it, so holding one costs nothing.)
  //
  // It lands on Escape and on the control's own click. A close caused by a
  // mousedown elsewhere overwrites it a moment later with whatever was clicked,
  // which is the browser's own default action and the behaviour you want —
  // clicking into the note field must leave focus in the note field.
  //
  // Dropping the `returnFocus` PROP did not unwire Mantine's returnFocus
  // FUNCTION: `Popover.Dropdown` passes it as `onTrigger` to its escape handler
  // unconditionally, and the prop only gates the separate restore-on-close
  // branch. It runs after this one and is a no-op or a repeat today, because the
  // node it captured is this same control. It would start winning if the popover
  // could ever be opened with focus somewhere else.
  const [opacityOpen, setOpacityOpen] = useState(false);
  const opacityTargetRef = useRef<HTMLButtonElement>(null);

  const showOpacity = (open: boolean) => {
    setOpacityOpen(open);
    if (!open) opacityTargetRef.current?.focus({ preventScroll: true });
  };

  const opacityControl = (
    <Popover
      width={210}
      position="top"
      withArrow
      withinPortal
      shadow="md"
      trapFocus
      opened={opacityOpen}
      onChange={showOpacity}
    >
      <Popover.Target>
        <ActionIcon
          ref={opacityTargetRef}
          size="sm"
          radius="xl"
          variant="subtle"
          color={draft.opacity < 1 ? 'blue' : 'gray'}
          aria-label="Set this sticker's opacity"
          onClick={() => showOpacity(!opacityOpen)}
        >
          <IconDropletHalf2 size={14} />
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown p="sm">
        <Text size="xs" c="dimmed" className="mb-2">
          Opacity
        </Text>
        {/* The floor is the slider's own minimum, so the range you can drag
            through is the range the server accepts — the value can never be one
            the purchase would then refuse. The refusal still lives in the
            schema; this only keeps the two from disagreeing in front of the
            person placing it. */}
        <Slider
          min={Math.round(STICKER_PLACEMENT_MIN_OPACITY * 100)}
          max={100}
          step={5}
          value={Math.round(draft.opacity * 100)}
          onChange={(value) => move(draft.id, { opacity: value / 100 })}
          label={(value) => `${value}%`}
          aria-label="Sticker opacity"
        />
      </Popover.Dropdown>
    </Popover>
  );

  const removeControl = (
    <Tooltip label="Remove" withinPortal>
      <ActionIcon
        size="sm"
        radius="xl"
        variant="subtle"
        color="gray"
        aria-label="Remove this sticker"
        onClick={() => cancelDraft(draft.id)}
      >
        <IconTrash size={14} />
      </ActionIcon>
    </Tooltip>
  );

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
        ...stickerArtworkStyle(draft),
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
          style={{ zIndex: -1, ...dressed.behind.style, opacity: draft.opacity }}
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

      {/* Two panels, one per top corner, and the split is the point: removing
          the draft throws work away, and it should not sit a thumb's width from
          the two controls you press while arranging one.

          Each is flush with its own edge and grows inward, so the pair reads as
          bracketing the box. They clear the corner handles — all four resize, so
          none can be spent on a button — and the buy button clears their band
          through `flippedButtonOffset`. Dark rather than the handles' blue:
          these act on the sticker, they are not part of positioning it.

          Only while the sticker is wide enough to hold them. Every other piece
          of chrome up here is a FRACTION of the sticker (the knob at
          `KNOB_OFFSET` of the height, the flipped button derived from it) while
          these are a fixed band, so on a small sticker all three converge: the
          knob ends up under a panel and DELETE lands on opacity, because it
          paints later. Narrow drafts hand their controls to the buy cluster
          instead — the `!panelsInside` row inside `buttonRef` below. */}
      {panelsInside && (
        <>
          <div
            className="absolute -top-9 left-0 flex cursor-auto items-center gap-0.5 rounded-full bg-dark-7 px-1 py-0.5"
            onPointerDown={pressPanel}
          >
            {flipControl}
            {opacityControl}
          </div>

          <div
            // Padding equal on both axes, unlike its two-icon sibling: a single
            // icon in a pill sized `px`/`py` comes out wider than it is tall, so
            // `rounded-full` reads as a lozenge rather than a circle.
            className="absolute -top-9 right-0 flex cursor-auto items-center rounded-full bg-dark-7 p-0.5"
            onPointerDown={pressPanel}
          >
            {removeControl}
          </div>
        </>
      )}

      <div
        ref={buttonRef}
        // Which of the two layouts is live is otherwise only legible from
        // Tailwind position classes, and a test reading those fails for the
        // wrong reason the moment the styling moves.
        data-testid="sticker-buy-cluster"
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
          // Clears whichever obstacle is taller: the knob, which scales with the
          // sticker, or the panel band, which does not. Below ~164px the
          // constant wins, so this does NOT simply scale.
          ...(flipped ? { marginBottom: flippedOffset } : null),
        }}
        // The button is inside the draggable body, so without this every press
        // on it would also start a move and the click would land mid-drag.
        onPointerDown={(event) => event.stopPropagation()}
      >
        {/* Where a narrow draft's controls live, rather than a second position
            for the panels above it.

            Anything anchored to a small sticker's own box is in trouble twice
            over: inside it, the panels reach past each other and the knob;
            outside it, they hang off the sticker and the carousel's viewport
            clips them away near the image edges — which on a phone-width media
            box is most of the frame, because almost every draft there is narrow.
            This cluster is the one piece of chrome that already knows where it
            is on screen: it measures itself against the tray and the clipping
            ancestor and moves to whichever side is visible. Handing it the
            controls means they inherit that, instead of a third set of
            hand-derived offsets to get wrong. */}
        {!panelsInside && (
          <div
            className="flex items-center gap-0.5 rounded-full bg-dark-7 px-1 py-0.5"
            onPointerDown={pressPanel}
          >
            {flipControl}
            {opacityControl}
            {removeControl}
          </div>
        )}

        {/* Optional, and folded away until asked for: a field on every draft
            would sit over the artwork through the whole arrangement, which is
            the one thing this overlay is trying not to do. */}
        {writingNote ? (
          <Textarea
            autoFocus
            size="xs"
            autosize
            minRows={2}
            maxRows={4}
            w={NOTE_WIDTH}
            className="whitespace-normal"
            placeholder="Say something with it (optional)"
            maxLength={STICKER_COMMENT_MAX_LENGTH}
            value={note}
            onChange={(event) => setNote(event.currentTarget.value)}
          />
        ) : (
          <UnstyledButton
            className="flex items-center gap-1 rounded-full bg-black/80 px-2 py-0.5 text-xs text-white"
            onClick={() => setWritingNote(true)}
          >
            <IconMessage size={12} />
            Add a note
          </UnstyledButton>
        )}

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
                flip: draft.flip,
                opacity: draft.opacity,
                // Sent only when there is something to send, so an opened-then-
                // abandoned field is the same as never opening it.
                ...(note.trim() ? { comment: note } : {}),
              },
            })
          }
        />
        {/* On its own dark chip rather than over the artwork: this sits on
            whatever the creator uploaded, and yellow on light work is as
            unreadable as dimmed was on dark.
            Rounded as a box rather than a pill once it is two lines: a
            full-round radius on a two-line chip bows its short sides inward. */}
        {payout && (
          <div
            className={clsx(
              'bg-black/80 px-2 py-0.5 text-center',
              payout.name ? 'rounded-lg' : 'rounded-full'
            )}
          >
            <Text size="xs" fw={500} c="yellow.4" className="leading-tight">
              {payout.lead}
            </Text>
            {/* Capped and truncated, and not only for looks: the wrapper is
                `w-max`, so an unbounded name widens the whole cluster — and the
                cluster's width is half of the overlap test that decides whether
                the button flips above the sticker. A long name would make it
                flip on images where it does not need to. */}
            {payout.name && (
              <Text
                size="xs"
                fw={700}
                c="yellow.4"
                className="max-w-[168px] truncate leading-tight"
                title={payout.name}
              >
                {payout.name}
              </Text>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
