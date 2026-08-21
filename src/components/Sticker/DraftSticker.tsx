import {
  ActionIcon,
  Button,
  Popover,
  SegmentedControl,
  Slider,
  Text,
  Textarea,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import {
  IconAlertTriangleFilled,
  IconCopy,
  IconDropletHalf2,
  IconFlipVertical,
  IconMessage,
  IconTrash,
} from '@tabler/icons-react';
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
import { useMutateCosmeticShop } from '~/components/CosmeticShop/cosmetic-shop.util';
import {
  FREE_REVIEW_CAVEAT,
  freeOptionLabel,
  isPlacingFree,
} from '~/components/Sticker/free-offer';
import { payoutCopy, stickerPurchaseCopy } from '~/components/Sticker/payout-copy';
import { stickerArtworkStyle } from '~/components/Sticker/placement-appearance';
import { useCreateStickerPlacement } from '~/components/Sticker/placement.util';
import { useBuyStickerUses } from '~/components/Sticker/sticker.util';
import type { ResolvedSticker } from '~/components/Sticker/sticker.util';
import type { StickerTreatment } from '~/components/Sticker/treatments/sticker-treatments';
import { useAvailableBuzz } from '~/components/Buzz/useAvailableBuzz';
import {
  STICKER_COMMENT_MAX_LENGTH,
  STICKER_PLACEMENT_MIN_OPACITY,
} from '~/shared/utils/sticker-placement';
import { numberWithCommas } from '~/utils/number-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
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
  freeOffer,
  ownerShare,
  ownerUsername,
  onGesture,
  onDuplicate,
}: {
  draft: StickerDraft;
  art: ResolvedSticker;
  /** Only decides what is on top. Every draft carries its own controls. */
  selected: boolean;
  dressed: StickerTreatment;
  price: number;
  /**
   * The free option, when this creator has a slot open and the placer still has
   * their day. `null` means paid is the only offer — including while the
   * standing query is still in flight.
   */
  freeOffer: { instant: boolean } | null;
  ownerShare: number | undefined;
  ownerUsername: string | null | undefined;
  onGesture: StartGesture;
  /**
   * Makes a second draft of this sticker. Supplied by the host rather than
   * called on the store from here, because whether the copy needs to be bought
   * depends on the viewer's remaining uses — which the layer can see and this
   * component cannot.
   */
  onDuplicate?: (id: string) => string | null;
}) {
  const markPurchased = useStickerPlacementDraftStore((state) => state.markPurchased);
  const { purchaseShopItem, purchasingShopItem } = useMutateCosmeticShop();
  const queryUtils = trpc.useUtils();
  // 🔴 ONE KEY PER STICKER PER SESSION, HELD IN THE STORE — not one per draft.
  // A pack grants the sticker itself and `markPurchased` then frees every draft
  // of it, so two copies showing two buy buttons are ONE buying intent. Minted
  // per draft, pressing both within a second was two keys and two charges for
  // something you only get once; duplicating put those two buttons a click
  // apart. The per-use path below is unaffected: each use genuinely is another
  // purchase.
  const packPurchaseKey = useStickerPlacementDraftStore((state) => state.packPurchaseKey);
  const clearPackPurchaseKey = useStickerPlacementDraftStore((state) => state.clearPackPurchaseKey);
  const buyUses = useBuyStickerUses();

  const buySticker = async () => {
    const pack = draft.purchase?.pack;
    if (!pack) return;

    try {
      await purchaseShopItem({
        shopItemId: pack.shopItemId,
        viaShopUserId: pack.viaShopUserId,
        payWith: pack.acceptsBlue ? 'blue-first' : undefined,
        // One key per sticker per session: a double-click, a retry, a second tab
        // — or the second copy's own buy button — are one intent, charged once.
        idempotencyKey: packPurchaseKey(draft.cosmeticId),
        // The number this button is showing. A listing re-priced while the panel
        // sat open must refuse rather than charge something else.
        expectedUnitAmount: pack.unitAmount,
      });
      // A pack grants the sticker itself, so every draft of it becomes
      // placeable — but the balance behind them has to be refetched, or the
      // tray keeps calling this sticker spent and offering to sell it again.
      await queryUtils.cosmetic.getStickerBalances.invalidate();
      markPurchased(draft.cosmeticId);
      showSuccessNotification({
        title: 'Sticker purchased',
        message: 'Place it whenever you like — it stays where you put it.',
      });
    } catch (error) {
      // The attempt is over, so the next press is a new intent rather than a
      // retry of this one. Holding the key would have a server that records
      // failed keys refuse every later attempt this session.
      clearPackPurchaseKey(draft.cosmeticId);
      showErrorNotification({
        title: 'Could not buy that sticker',
        error: error instanceof Error ? error : new Error('Purchase failed'),
      });
    }
  };

  // Only the one use this draft will spend. Buying a stack you may not place is
  // the shop's business, not this button's — the sticker is already arranged and
  // the next press after this one is Place.
  const buyOneUse = async () => {
    const perUse = draft.purchase?.perUse;
    if (perUse == null) return;

    try {
      await buyUses.mutateAsync({
        cosmeticId: draft.cosmeticId,
        quantity: 1,
        // What the button charged for. The server refuses if the creator has
        // moved the price since this rendered.
        expectedPricePerUse: perUse,
        payWith: 'default',
      });
      // This draft only. One use funds one placement, so lifting the gate from
      // every draft of the sticker would show a Place button on stickers that
      // cannot be placed — the server refuses them at `assertHasUse`, after the
      // button has already claimed they were paid for.
      markPurchased(draft.cosmeticId, draft.id);
    } catch (error) {
      showErrorNotification({
        title: 'Could not buy a use',
        error: error instanceof Error ? error : new Error('Purchase failed'),
      });
    }
  };

  const select = useStickerPlacementDraftStore((state) => state.select);
  const cancelDraft = useStickerPlacementDraftStore((state) => state.cancelDraft);
  const move = useStickerPlacementDraftStore((state) => state.move);

  // `null` until somebody presses the control, which is what lets the default
  // track an offer that arrives with a query rather than freezing whatever was
  // known on the first render. See `isPlacingFree`.
  const [payChoice, setPayChoice] = useState<'free' | 'paid' | null>(null);
  const placingFree = isPlacingFree(payChoice, freeOffer);
  const payMode = placingFree ? 'free' : 'paid';

  // Settling on paid after a refused claim, rather than leaving the control on
  // an offer that is gone. Passed down rather than handled here because the
  // mutation is the only thing that knows the claim was refused.
  const place = useCreateStickerPlacement(draft.id, () => setPayChoice('paid'));
  const spendTypes = useAvailableBuzz();

  // While the sticker is unbought the chip names who that payment goes to — the
  // sticker's maker — not who the later placement pays. Two payments, two
  // recipients, and only one of them is being made right now.
  //
  // Nothing at all on a free placement: there are no proceeds to split, so a
  // share of them is a claim about money that does not move. PR 3's accept
  // reward is the creator's side of a free placement and is not derived from
  // this split, so it does not belong in this sentence either.
  const payout = draft.purchase
    ? stickerPurchaseCopy(draft.purchase.creatorUsername)
    : placingFree
    ? null
    : payoutCopy(ownerShare, ownerUsername);

  // Which of the two refill prices is being offered. Defaults to the single
  // use: it is the cheaper of the two and exactly what placing this draft
  // spends, so the larger commitment is the one you have to ask for.
  const [buyMode, setBuyMode] = useState<'use' | 'pack'>('use');
  const canBuyUse = draft.purchase?.perUse != null;
  const canBuyPack = !!draft.purchase?.pack;
  const offersBoth = canBuyUse && canBuyPack;
  // A first purchase has no per-use option at all — you cannot top up a sticker
  // you do not own — so the toggle's value only decides anything when both are
  // open.
  const effectiveMode = offersBoth ? buyMode : canBuyPack ? 'pack' : 'use';
  const packUses = draft.purchase?.pack?.uses;

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
      panelBand: panelBandFor(width),
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
      panelsInside: panelsFitInsideEdges(width),
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
        select(gesture.draftId);
        try {
          target.setPointerCapture(gesture.pointerId);
        } catch {
          // Pointer already gone; the layer's own up/cancel handling still ends it.
        }
      };

      if (mode === 'move') {
        /**
         * Alt-drag leaves a copy behind and drags the new one, the way every
         * photo editor does it.
         *
         * The gesture continues against the COPY rather than the original, which
         * is why `onDuplicate` hands back an id: dragging the original instead
         * would leave the duplicate stranded under the pointer and move the
         * thing the placer was trying to keep in place.
         *
         * The copy lands at the original's position for this path — the button's
         * nudge exists so a click produces something visible, but an alt-drag is
         * about to be positioned by the pointer, and offsetting it first makes
         * the sticker jump out from under the cursor at the start of the drag.
         */
        const altCopyId = event.altKey ? onDuplicate?.(draft.id) : null;
        if (altCopyId) move(altCopyId, { x: draft.x, y: draft.y });

        // Keep the sticker where it was relative to the grab, instead of
        // snapping its centre to the cursor.
        take({
          draftId: altCopyId ?? draft.id,
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

  // One payload for both buttons, so the two offers cannot drift into placing
  // different stickers. `free` is the only thing that differs, and it selects a
  // path rather than asserting anything — the server re-decides all of it.
  const placementInput = () => ({
    imageId: draft.imageId,
    free: placingFree,
    data: {
      cosmeticId: draft.cosmeticId,
      x: draft.x,
      y: draft.y,
      scale: draft.scale,
      rotation: draft.rotation,
      flip: draft.flip,
      opacity: draft.opacity,
      // Sent only when there is something to send, so an opened-then-abandoned
      // field is the same as never opening it.
      ...(note.trim() ? { comment: note } : {}),
    },
  });

  /**
   * A second copy of this sticker, already arranged.
   *
   * Placing several of one sticker meant a trip back through the tray for each,
   * which is what this removes. It creates a DRAFT and nothing else — the copy
   * is bought and placed by the same button and the same mutation as the first,
   * so there is no second route into the charge path and nothing here can place
   * a sticker without being charged for it.
   *
   * Absent rather than disabled where the host does not supply a handler: a
   * control that cannot act is a question the placer has to answer by pressing
   * it.
   */
  const duplicateControl = onDuplicate && (
    <Tooltip label="Duplicate" withinPortal>
      <ActionIcon
        size="sm"
        radius="xl"
        variant="subtle"
        color="gray"
        aria-label="Duplicate this sticker"
        onClick={() => onDuplicate(draft.id)}
      >
        <IconCopy size={14} />
      </ActionIcon>
    </Tooltip>
  );

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
        {/* Tabler names these for the MIRROR AXIS, not the motion: this control
            mirrors left-to-right (`scaleX(-1)`, see `placement-appearance`), and
            the glyph that draws a vertical mirror line is `IconFlipVertical`.
            The same crossed pairing is in the drawing editor's flip controls. */}
        <IconFlipVertical size={14} />
      </ActionIcon>
    </Tooltip>
  );

  // The slider is behind a control rather than always on screen: it is set once,
  // and a slider parked on the artwork would be in the way of every later drag.
  const opacityControl = (
    <Popover width={210} position="top" withArrow withinPortal shadow="md">
      <Popover.Target>
        <ActionIcon
          size="sm"
          radius="xl"
          variant="subtle"
          color={draft.opacity < 1 ? 'blue' : 'gray'}
          aria-label="Set this sticker's opacity"
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
            {duplicateControl}
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
            ancestor and moves ABOVE or BELOW the sticker accordingly.
            `shouldFlipPlaceButton` is vertical only — the horizontal position
            follows the draft's own x with nothing clamping it — so handing it the
            controls buys them the vertical avoidance and no more. Still better
            than a third set of hand-derived offsets. */}
        {!panelsInside && (
          <div
            className="flex items-center gap-0.5 rounded-full bg-dark-7 px-1 py-0.5"
            onPointerDown={pressPanel}
          >
            {duplicateControl}
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

        {/* Above the button in both states: this is who the press underneath it
            pays, so it reads as a label on the button rather than a footnote
            after the decision. Capped and truncated because the cluster is
            `w-max`, and its width feeds the overlap test that decides whether
            the button flips above the sticker. */}
        {payout && (
          <div className="max-w-[240px] truncate rounded-full bg-black/80 px-2 py-0.5 text-center">
            <Text size="xs" fw={500} c="yellow.4" className="leading-tight" title={payout.name}>
              {payout.lead}
              {payout.name ? ' ' : ''}
              {payout.name && <span className="font-bold">{payout.name}</span>}
            </Text>
          </div>
        )}

        {/* Both ways to pay for a spent sticker, where both are open. One use is
            what placing this draft actually costs; the pack is the listing's own
            price, offered only while it is genuinely on sale. */}
        {offersBoth && (
          <SegmentedControl
            size="xs"
            radius="xl"
            value={buyMode}
            onChange={(value) => setBuyMode(value as 'use' | 'pack')}
            data={[
              { label: '1 use', value: 'use' },
              {
                label: packUses == null ? 'Pack' : `${numberWithCommas(packUses)} uses`,
                value: 'pack',
              },
            ]}
          />
        )}

        {/* The other two-way choice, and deliberately the same control as the
            one above it: this is the same kind of decision — which of two
            offers you are taking — made a step later, so giving it a different
            shape would make them read as unrelated. They never coexist; the one
            above only appears on a sticker that still has to be bought.

            The free option carries the mode, which the sticker button upstream
            deliberately does not. This is the last moment the placer can change
            their mind, and it is what makes auto-accept and review read as two
            different offers rather than a setting nobody can see. */}
        {!draft.purchase && freeOffer && (
          <SegmentedControl
            size="xs"
            radius="xl"
            value={payMode}
            onChange={(value) => setPayChoice(value as 'free' | 'paid')}
            data={[
              { label: freeOptionLabel(), value: 'free' },
              { label: `${numberWithCommas(price)} Buzz`, value: 'paid' },
            ]}
          />
        )}

        {draft.purchase && effectiveMode === 'pack' && draft.purchase.pack ? (
          <BuzzTransactionButton
            size="sm"
            style={{ minWidth: BUY_BUTTON_MIN_WIDTH }}
            buzzAmount={draft.purchase.pack.unitAmount}
            accountTypes={draft.purchase.pack.acceptsBlue ? ['blue', ...spendTypes] : spendTypes}
            label={draft.purchase.refill ? 'Buy another pack' : 'Purchase sticker'}
            loading={purchasingShopItem}
            onPerformTransaction={buySticker}
          />
        ) : draft.purchase ? (
          // Owned, and out of uses. One use, because one is what placing this
          // draft spends.
          <BuzzTransactionButton
            size="sm"
            style={{ minWidth: BUY_BUTTON_MIN_WIDTH }}
            buzzAmount={draft.purchase.perUse ?? 0}
            accountTypes={spendTypes}
            label="Buy a use"
            loading={buyUses.isPending}
            // A sticker sold before per-use pricing existed has no price to
            // charge, and the listing price is not a stand-in for one. Says so
            // rather than offering a button that cannot work.
            error={
              draft.purchase.perUse == null
                ? 'This sticker sells no extra uses, and it is not on sale right now'
                : undefined
            }
            onPerformTransaction={buyOneUse}
          />
        ) : placingFree ? (
          // Not a `BuzzTransactionButton`. That control exists to show a price
          // and check a balance against it, and a free placement has neither —
          // rendering it at zero would put a currency badge on something nobody
          // is paying for, and its account picker would ask which Buzz to spend.
          // The use it does spend is shown by the tray's own count, and refused
          // by the server independently.
          <Button
            size="sm"
            radius="xl"
            color="yellow"
            style={{ minWidth: BUY_BUTTON_MIN_WIDTH }}
            loading={place.isPending}
            onClick={() => place.mutate(placementInput())}
          >
            Place free
          </Button>
        ) : (
          <BuzzTransactionButton
            size="sm"
            style={{ minWidth: BUY_BUTTON_MIN_WIDTH }}
            buzzAmount={price}
            accountTypes={spendTypes}
            label="Place"
            loading={place.isPending}
            onPerformTransaction={() => place.mutate(placementInput())}
          />
        )}

        {/* Under the button, not above it: it is a consequence of pressing, and
            above the control it read as a description of the option. Same chip
            shape and same triangle as the second-payment warning below, because
            they are the same kind of thing — a cost you meet by pressing.

            Only where it is true. On an auto-accept space the placement is live
            the moment it is made, so there is no decline to warn about. */}
        {placingFree && freeOffer && !freeOffer.instant && (
          <div className="flex items-center gap-1 rounded-full bg-black/80 px-2 py-0.5">
            <IconAlertTriangleFilled size={12} className="shrink-0 text-yellow-4" />
            <Text size="xs" c="gray.3" className="leading-tight">
              {FREE_REVIEW_CAVEAT}
            </Text>
          </div>
        )}

        {/* The second payment, said before the first one is made. Someone who
            buys a sticker to put it here and then meets another price has been
            surprised with their own money. */}
        {draft.purchase && (
          <div className="flex items-center gap-1 rounded-full bg-black/80 px-2 py-0.5">
            <IconAlertTriangleFilled size={12} className="shrink-0 text-yellow-4" />
            <Text size="xs" c="gray.3" className="leading-tight">
              Then {numberWithCommas(price)} Buzz to place it
            </Text>
          </div>
        )}
      </div>
    </div>
  );
}
