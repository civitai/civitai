import clsx from 'clsx';
import { EdgeImage } from '~/components/EdgeMedia/EdgeImage';
import type { ResolvedSticker } from '~/components/Sticker/sticker.util';
import { useStickerCosmetics } from '~/components/Sticker/sticker.util';
import type { PlacedSticker } from '~/components/Sticker/placement.util';
import { orderPlacements, placementRevealDelays } from '~/components/Sticker/placement-order';
import { stickerArtworkStyle } from '~/components/Sticker/placement-appearance';
import { placementControlPosition } from '~/components/Sticker/placement-control-position';
import { placementMarkLayout } from '~/components/Sticker/placement-mark-layout';
import { PENDING_CONTROL_Z } from '~/components/Sticker/placement-layers';
import { StickerPlacementActions } from '~/components/Sticker/StickerPlacementActions';
import { StickerPlacementHoverCard } from '~/components/Sticker/StickerPlacementHoverCard';
import { freeMarkerVisible } from '~/components/Sticker/free-marker';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import {
  STILL_STICKER_TREATMENT,
  resolveTreatment,
  type StickerSurface,
  type StickerTreatmentKey,
} from '~/components/Sticker/treatments/sticker-treatments';
import styles from '~/components/Sticker/placement-reveal.module.scss';
import { useRevealSpeed } from '~/store/sticker-reveal-speed.store';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';

/**
 * Clear air between the bottom of a pending sticker and the owner's controls.
 *
 * Generous rather than tight: the artwork sways for as long as it is on screen,
 * and the treatments draw shadows and a die-cut edge outside the element's box,
 * so a gap measured to the pixel is a gap the sticker moves into.
 */
const CONTROL_GAP_PX = 14;

/** Shared so the two in-box marks cannot drift apart in size or weight. */
const PLACEMENT_MARK_CLASS =
  'truncate rounded px-1.5 py-0.5 text-[10px] font-semibold leading-tight';

/**
 * Follow from `PLACEMENT_MARK_CLASS` and the `top-1`/`bottom-1`/`gap-0.5` below
 * — change those and change these. They only feed `placementMarkLayout`, whose
 * questions (is a mark entirely outside, is there room for two) a pixel either
 * way does not answer differently.
 */
const PLACEMENT_MARK_HEIGHT_PX = 17;
const PLACEMENT_MARK_INSET_PX = 4;
const PLACEMENT_MARK_GAP_PX = 2;

/**
 * Placed stickers, drawn over the content they were placed on.
 *
 * Oldest at the bottom, newest on top. Covering another sticker is a feature —
 * a hat, a speech bubble, decorating what someone else left — so what a viewer
 * sees is the image as it was most recently built, and the history panel is
 * where the buried ones stay reachable.
 *
 * Positions are fractions of the target's bounds, never pixels, so the same
 * overlay is correct at card size in a feed and at full size in the detail view.
 * `scale` is a fraction of the *width* only — using both axes would stretch a
 * sticker with the aspect ratio of whatever it sits on.
 *
 * `pointer-events-none` throughout except on the sticker itself, so an overlay
 * never swallows a click meant for the image beneath it. A feed card is a link,
 * and an invisible layer over it is indistinguishable from the card being broken.
 */
export function StickerPlacementOverlay({
  placements,
  viewerId,
  className,
  interactive = true,
  sticker,
  artworkWidth = 512,
  treatment = STILL_STICKER_TREATMENT,
  surface = 'detail',
  stagger = false,
  armed = false,
  paced = true,
  step = null,
}: {
  placements: PlacedSticker[];
  viewerId?: number;
  className?: string;
  /**
   * Off on a feed card, where the card is a link and the layer is clipped.
   *
   * An interactive sticker is a hole in the card that does not open the image —
   * at `scale: 0.3` roughly a third of its width — and the owner's approve /
   * decline buttons sit below the sticker, so on anything placed low they are
   * cut off by the card's `overflow-hidden` and offered half-visible. Both are
   * fine at detail size, which is the only place this rendered before.
   *
   * It also takes the hover card with it, and the moderator remove action inside
   * it — so that action is detail-view only, which is where Justin asked for it.
   * `key={placement.id}` on `body` below is load-bearing because of this: it was
   * inert while every return was wrapped in a keyed element, and it is now what
   * keys the array item on the non-interactive path.
   */
  interactive?: boolean;
  /**
   * Artwork already resolved for the whole surface.
   *
   * Without it this component resolves its own, which is one query per instance
   * — fine on the detail view where there is one, and a request per card on a
   * feed, since cards hold different sticker sets and so produce different query
   * keys. That is the exact cost the batch provider exists to remove, and it
   * removed it for placements and counts while the artwork still had to be
   * fetched to draw anything.
   */
  sticker?: Map<number, ResolvedSticker>;
  /**
   * Width to request from the CDN. 512 is a sticker's natural size — the
   * artwork rules cap the long edge there — and right for the detail view. A
   * card draws one at a fraction of a ~450px box, so it asks for less; the CDN
   * caches a variant per width, so this mints a second one rather than being
   * free.
   */
  artworkWidth?: number;
  /**
   * How an approved sticker is separated from the artwork under it. Never
   * applied to a pending placement — pending owns the dashed yellow outline, and
   * a second always-on treatment on top of it would make "waiting on you" and
   * "settled" look the same to the owner.
   */
  treatment?: StickerTreatmentKey;
  /**
   * Which surface is drawing, kept separate from `interactive` — that prop
   * already carries pointer-events, the hover card and the moderator remove
   * action, and a detail view that turned those off would still want the
   * detail treatment.
   */
  surface?: StickerSurface;
  /**
   * Reveal the stickers one at a time, oldest first, instead of all at once.
   *
   * Detail view only. A feed draws dozens of these and a staggered reveal there
   * is movement across the whole page on every scroll — Justin's call, and the
   * same reason the treatments drop their animation on a card.
   */
  stagger?: boolean;
  /**
   * Whether the staggering surface is being looked at yet.
   *
   * Separate from `stagger` because the two answer different questions and the
   * gap between them is a frame the viewer sees. `stagger` is a property of the
   * surface and is known at the first render; arming is an observation that
   * cannot happen until after a paint. While a staggering surface is unarmed its
   * stickers are held at zero opacity, so the reveal starts from blank rather
   * than from a painted frame it then has to blank out.
   */
  armed?: boolean;
  /**
   * Whether to space the reveal out. Off reveals everything together, in one
   * short fade — still no un-staggered frame, just no sequence.
   *
   * Separate from `stagger` because `stagger` must not change while mounted:
   * removing it and putting it back re-adds the animation to elements already
   * on screen, which replays the whole reveal. Anything that wants the reveal
   * to stop being a sequence has to say so without touching that flag.
   */
  paced?: boolean;
  /**
   * Index of the last sticker to draw, for the history replay. `null` draws all
   * of them, which is every surface that is not being stepped through.
   */
  step?: number | null;
}) {
  const cosmeticIds = useMemo(
    () =>
      // Nothing to resolve when the surface already did it. `useStickerCosmetics`
      // issues no query for an empty list, and a hook cannot be skipped.
      sticker ? [] : placements.map((placement) => placement.data.cosmeticId),
    [placements, sticker]
  );
  const { sticker: resolved } = useStickerCosmetics(cosmeticIds);
  const artwork = sticker ?? resolved;

  // Ordered here rather than trusted from the caller: this component decides
  // what covers what, and the paint order of these elements IS that decision.
  // Only for the moderator flag. Who the viewer is comes from `viewerId`, which
  // the surfaces already pass and the server-side render has.
  const currentUser = useCurrentUser();
  const ordered = useMemo(() => orderPlacements(placements), [placements]);
  // Off the full history, not off the visible slice: stepping through a replay
  // must not re-pace the stickers already on screen.
  const revealSpeed = useRevealSpeed();
  const delays = useMemo(
    () => (stagger ? placementRevealDelays(ordered, { speed: revealSpeed }) : null),
    [ordered, stagger, revealSpeed]
  );

  // The rendered height of each pending sticker, in pixels, measured rather than
  // derived. Two attempts to compute where the owner's controls go from `scale`
  // were both wrong on real images, because `scale` is a fraction of the box's
  // WIDTH and the artwork's own aspect is not in the payload at all — the number
  // needed here is simply not knowable from the data. It IS knowable from the
  // element, so it is read off the element.
  //
  // Only pending placements are measured; nothing else is positioned relative to
  // a sticker's edge.
  const [stickerBoxes, setStickerBoxes] = useState<
    Record<number, { height: number; width: number }>
  >({});
  /**
   * The media box everything here stays inside, and how big each control is.
   *
   * Read off the sticker layer, not the owner's control layer — that one mounts
   * only when there is a control to draw, and the marks need the box whether or
   * not the viewer is the owner.
   *
   * Both are needed before the position can be clamped, and neither is knowable
   * from CSS: the control's width depends on which buttons the owner gets, and
   * the box is the media rectangle this overlay was drawn over. Until they land,
   * `placementControlPosition` returns null and the unclamped position stands.
   */
  const [controlBox, setControlBox] = useState({ width: 0, height: 0 });
  const [controlSizes, setControlSizes] = useState<
    Record<number, { width: number; height: number }>
  >({});

  const measureBox = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const read = () =>
      setControlBox((current) =>
        current.width === node.offsetWidth && current.height === node.offsetHeight
          ? current
          : { width: node.offsetWidth, height: node.offsetHeight }
      );
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(read);
    observer.observe(node);
    boxObserver.current?.disconnect();
    boxObserver.current = observer;
  }, []);
  const boxObserver = useRef<ResizeObserver | null>(null);
  useEffect(() => () => boxObserver.current?.disconnect(), []);

  const measureControl = useCallback(
    (placementId: number) => (node: HTMLDivElement | null) => {
      if (!node) return;
      // `offsetWidth`/`offsetHeight` for the same reason the sticker is measured
      // that way: they are layout numbers and ignore the reveal animation's
      // transform.
      const size = { width: node.offsetWidth, height: node.offsetHeight };
      setControlSizes((current) =>
        current[placementId]?.width === size.width && current[placementId]?.height === size.height
          ? current
          : { ...current, [placementId]: size }
      );
    },
    []
  );
  // Disposers rather than observers, because the no-`ResizeObserver` path has
  // its own thing to unhook.
  const disposers = useRef(new Map<number, () => void>());
  useEffect(() => {
    const live = disposers.current;
    return () => {
      live.forEach((dispose) => dispose());
      live.clear();
    };
  }, []);

  const measureSticker = useCallback(
    (placement: PlacedSticker) => (node: HTMLDivElement | null) => {
      const placementId = placement.id;
      const existing = disposers.current.get(placementId);
      if (existing) {
        existing();
        disposers.current.delete(placementId);
      }
      if (!node) return;

      const record = () => {
        // `offsetHeight`/`offsetWidth`, deliberately: they are LAYOUT numbers and
        // ignore transforms. A bounding rect would be simpler and is wrong here,
        // because the artwork animates — it pops from 0.72 to 1.06 on arrival and
        // sways forever after — so a rect measured at observe time is whatever
        // frame that landed on, and a sticker measured mid-pop reports too small
        // and the controls sit on top of it.
        //
        // Stored unrotated. The two consumers want different things from it: the
        // controls sit outside the sticker and need the rotated extent, the marks
        // sit on the box's own edges and need the box. Deriving the first from
        // this is arithmetic; recovering this from the first is not.
        const box = { height: node.offsetHeight, width: node.offsetWidth };
        // Guarded, because writing state from a ResizeObserver that the write
        // then resizes is how a resize loop starts.
        setStickerBoxes((current) =>
          current[placementId]?.height === box.height && current[placementId]?.width === box.width
            ? current
            : { ...current, [placementId]: box }
        );
      };

      // No observer is not a reason to hide the owner's only control forever —
      // the same call the sibling observer makes, and it was inverted here.
      // Measured now and again when the artwork lands, because before the image
      // loads the box is zero-height and the controls would sit on the sticker's
      // centre until something re-measured. `load` does not bubble, so the
      // listener captures.
      if (typeof ResizeObserver === 'undefined') {
        record();
        node.addEventListener('load', record, true);
        disposers.current.set(placementId, () => node.removeEventListener('load', record, true));
        return;
      }

      const observer = new ResizeObserver(record);
      observer.observe(node);
      disposers.current.set(placementId, () => observer.disconnect());
    },
    []
  );

  const [replayed, setReplayed] = useState(false);
  useEffect(() => {
    if (step != null) setReplayed(true);
  }, [step]);
  // Cleared when the surface leaves the screen, because arming repeats now: one
  // replay used to unpace every later arrival for the lifetime of the mount, so
  // coming back to a slide you had once stepped through revealed everything at
  // once with no sequence.
  useEffect(() => {
    if (!armed) setReplayed(false);
  }, [armed]);

  if (!placements.length) return null;

  const visible = step == null ? ordered : ordered.slice(0, step + 1);

  // The owner's approve/decline, drawn in their own layer below so they out-rank
  // every placed sticker and not just the one they belong to; isolation would cap
  // them at the layer's own z-index.
  const pendingControls: ReactElement[] = [];

  return (
    <>
      {/* `isolate` is load-bearing. Without it these z-indexes are hoisted into
          whatever context the surface provides and compete with everything else
          in it: on a feed card the header and footer, which are absolutely
          positioned with no z-index of their own and rely on DOM order — AspectRatioImageCard states "under
          the header and footer" as a contract. Contained, the whole layer keeps
          the z-index it had before this change, and the ordering inside it is
          purely internal. */}
      <div
        ref={measureBox}
        className={clsx('pointer-events-none absolute inset-0 isolate overflow-hidden', className)}
      >
        {visible.map((placement, index) => {
          const art = artwork.get(placement.data.cosmeticId);
          if (!art) return null;

          // Explicit, rather than left to paint order. Paint order gives the same
          // answer today, and stops giving it the moment anything here becomes a
          // portal, gains a transform, or is reordered by a keyed re-render — and
          // a sticker silently sliding under the one it was placed over is the
          // one failure this layer exists to prevent.
          const layer = index + 1;
          const delay = paced && armed && step == null && !replayed ? delays?.[index] ?? 0 : 0;
          const delayStyle = delay ? ({ '--sticker-delay': `${delay}ms` } as CSSProperties) : {};
          // Worn by everything belonging to this placement, not just the
          // artwork. The owner's approve/decline is drawn in a separate layer,
          // and without this it appeared instantly over a sticker still waiting
          // its turn — buttons hovering over nothing, asking about a sticker
          // that had not arrived yet.
          const revealClassName = stagger && (armed ? styles.appear : styles.hold);

          // Pending rows only ever reach a viewer who is party to them — the
          // server scopes them to the placer and the owner — so this decides how
          // to present it, not whether to show it. A client-side visibility rule
          // would be a filter where a refusal is needed.
          const isOwner = placement.ownerId === viewerId;

          const showsFree = freeMarkerVisible({
            free: placement.free,
            isPending: placement.isPending,
            ownerId: placement.ownerId,
            placerId: placement.placerId,
            viewerId,
            isModerator: currentUser?.isModerator,
          });

          const dressed = resolveTreatment({
            treatment,
            surface,
            isPending: placement.isPending,
          });

          // The placer's own opacity, drawn at its true value even while the
          // owner is deciding. Pending used to be dimmed a further 40% on top of
          // this, which compounds — a sticker placed at the 30% floor would reach
          // a review card at 18%, looking like nothing there and then appearing
          // at full strength once approved, which is exactly what the floor
          // exists to prevent. The dashed outline carries "awaiting review" now.
          const appearance = stickerArtworkStyle(placement.data);

          // The owner gets approve/decline instead of "Pending": it says the
          // same thing and can be acted on.
          // What the controls need, and only they: a tilted rectangle's visual
          // height is h·|cos r| + w·|sin r|, and dropping the second term is what
          // put the buttons over the artwork on anything more than slightly
          // turned.
          const radians = (placement.data.rotation * Math.PI) / 180;
          const measured = stickerBoxes[placement.id];
          const stickerExtent = measured
            ? measured.height * Math.abs(Math.cos(radians)) +
              measured.width * Math.abs(Math.sin(radians))
            : 0;

          const hasPending = placement.isPending && interactive && !isOwner;
          const side = placementMarkLayout({
            y: placement.data.y,
            stickerHeight: stickerBoxes[placement.id]?.height ?? 0,
            rotation: placement.data.rotation,
            markHeight: PLACEMENT_MARK_HEIGHT_PX,
            inset: PLACEMENT_MARK_INSET_PX,
            gap: PLACEMENT_MARK_GAP_PX,
            box: controlBox,
            hasFree: showsFree,
            hasPending,
          });
          // Free first, pending second: within either stack this puts the mark
          // that flipped inboard of the one already on that edge.
          const marks = [
            side.free && {
              key: 'free',
              side: side.free,
              label: 'Free placement',
              className: 'bg-blue-6 text-white',
            },
            side.pending && {
              // "Pending", not the queues' "Awaiting review" — the longer
              // wording truncates inside a sticker at its default size, and the
              // hover card carries the detail.
              key: 'pending',
              side: side.pending,
              label: 'Pending',
              className: 'bg-yellow-6 text-dark-9',
            },
          ].filter((mark) => !!mark);

          const artworkImage = (
            <EdgeImage
              src={art.url}
              alt={`:${art.slug}:`}
              // A fixed request width rather than a measured one: a sticker has
              // a natural size and the element scales it down in layout.
              options={{ width: artworkWidth, anim: art.animated, optimized: true }}
              style={{
                width: '100%',
                height: 'auto',
                display: 'block',
                ...dressed.imageStyle?.[surface],
                ...appearance,
              }}
            />
          );

          const body = (
            <div
              key={placement.id}
              ref={placement.isPending ? measureSticker(placement) : undefined}
              className={clsx('absolute', interactive && 'pointer-events-auto', revealClassName)}
              style={{
                left: `${placement.data.x * 100}%`,
                top: `${placement.data.y * 100}%`,
                width: `${placement.data.scale * 100}%`,
                transform: `translate(-50%, -50%) rotate(${placement.data.rotation}deg)`,
                zIndex: layer,
                ...delayStyle,
              }}
            >
              {/* The wrapper's own transform makes it a stacking context, so a
                negative z-index here stays behind the sticker without reaching
                behind the artwork the sticker sits on. */}
              {dressed.behind && (
                <span
                  aria-hidden
                  className={dressed.behind.className}
                  style={{
                    zIndex: -1,
                    ...dressed.behind.style,
                    opacity: placement.data.opacity,
                  }}
                />
              )}

              {dressed.animationClassName ? (
                <div className={dressed.animationClassName}>{artworkImage}</div>
              ) : (
                artworkImage
              )}

              {/* A dashed outline, and now the only mark. Fading was the second
                cue and could not stay: the placer sets their own opacity, so a
                dim-for-pending would compound with theirs and be indistinguishable
                from a sticker they chose to place faint. A border is a deliberate
                mark at any size and against any background. */}
              {placement.isPending && (
                <span
                  className={clsx(
                    'pointer-events-none absolute rounded border-2 border-dashed border-yellow-6',
                    // Inside the artwork's own box on a card, outside it in the
                    // detail view. A card draws this inside two `overflow-hidden`
                    // layers over `object-fit: cover` media, so an outset ring on
                    // an edge-placed sticker is clipped while the artwork it marks
                    // is still visible — and a card shows none of the other
                    // pending cues, so that ring is the whole signal there.
                    //
                    // Reduces that, does not close it: a `cover` crop can still
                    // land the sticker's interior in frame with its edges out,
                    // and the ring goes with the edges.
                    surface === 'card' ? 'inset-0' : '-inset-1'
                  )}
                />
              )}

              {/* Marks, not controls — nobody can act on either — so they need
                  neither the pending-controls layer nor an escape from the box's
                  transform. Which edge each sits on, and whether there is room
                  at all, is `placementMarkLayout`.

                  🔴 `inset-x-0` + `truncate` is the containment. Anchored
                  `left-1/2` instead, a mark's shrink-to-fit width is measured
                  against the half of the box to its right, so `Free placement`
                  truncated at sizes where it would have fitted; with
                  `whitespace-nowrap` and no cap at all it hung over both edges
                  of a small sticker — the collision these were moved inside to
                  avoid, sideways. */}
              {(['top', 'bottom'] as const).map((edge) => {
                const stack = marks.filter((mark) => mark.side === edge);
                if (!stack.length) return null;
                return (
                  <div
                    key={edge}
                    className={clsx(
                      'pointer-events-none absolute inset-x-0 flex flex-col items-center gap-0.5',
                      edge === 'top' ? 'top-1' : 'bottom-1'
                    )}
                    // Counter-rotated: rotation runs to ±180 and a mark riding
                    // the sticker's own transform reads upside down.
                    style={{ transform: `rotate(${-placement.data.rotation}deg)` }}
                  >
                    {stack.map((mark) => (
                      <span key={mark.key} className={clsx(PLACEMENT_MARK_CLASS, mark.className)}>
                        {mark.label}
                      </span>
                    ))}
                  </div>
                );
              })}
            </div>
          );

          // A hover card needs something to hover, so a non-interactive layer gets
          // the sticker alone. The detail view is one click away and carries all
          // of it.
          if (!interactive) return body;

          if (!placement.isPending)
            return (
              <StickerPlacementHoverCard
                key={placement.id}
                placementId={placement.id}
                imageId={placement.imageId}
              >
                {body}
              </StickerPlacementHoverCard>
            );

          // Pending, and the viewer is one of the two people who can see it. Both
          // get the hover card — the owner needs to know who is asking before
          // answering, and the placer gets the same detail they would once it goes
          // live. Only the owner gets the buttons.
          // `> 0`, not merely present. Before the artwork loads the box is
          // zero-height, and at rotation 0 the measurement is exactly 0 — a real
          // number that says nothing about where the sticker's edge is. Treating
          // it as valid put the controls 14px below the sticker's CENTRE, on top
          // of the artwork, until the image landed and moved them.
          // Clamped into the media box, once both it and the control have been
          // measured. Null until then, and the unclamped position below stands —
          // see `placementControlPosition` for why this exists at all.
          const clamped = placementControlPosition({
            x: placement.data.x,
            y: placement.data.y,
            stickerHeight: stickerExtent,
            gap: CONTROL_GAP_PX,
            control: controlSizes[placement.id] ?? { width: 0, height: 0 },
            box: controlBox,
          });

          if (isOwner && stickerExtent > 0)
            pendingControls.push(
              <div key={placement.id}>
                {/* ⚠️ Known wrong, and left wrong deliberately.

                `scale` is a fraction of the media box's WIDTH while a `top`
                percentage resolves against its HEIGHT, so this is the sticker's
                real half-height only when the sticker's own aspect matches the
                media box's. Otherwise it is off by `mediaAspect / stickerAspect`
                — a gap below the sticker on the tall side, an overlap onto it on
                the wide side. Not portrait vs landscape: a 2:1 sticker on a
                square media box clears the sticker by half its height again.

                Anchoring inside the sticker's own box fixes the arithmetic and
                costs three worse things:
                  - it lands inside the hover-card trigger, whose 400px dropdown
                    opens over it. The marks live there and are fine — nobody can
                    act on them, so a dropdown covering them costs nothing;
                  - anchoring BELOW the box (`top-full`) rides the rotation: at
                    180° the local bottom edge is the screen top, at 90° it is
                    off to the side. Counter-rotation keeps it upright but does
                    not move it back below. An anchor inside the box — the two
                    marks above — avoids this; a control has to sit outside;
                  - `body`'s transform makes it a stacking context, so a z-index
                    inside it stops out-ranking other placements — a sticker
                    placed later then covers the owner's buttons. Nothing done
                    INSIDE the box can fix that; it needs the controls kept
                    outside the transform (what this does) or a z-index on the
                    pending wrapper itself. A draft covers them either way now,
                    which is DRAFT_STICKER_Z doing what it says. */}
                {/* Not rendered at all until the sticker has been measured.
                  Rendering it early would put it at the sticker's centre — on
                  top of the artwork — and then jump when the measurement lands.
                  An inline `visibility` did that job until the reveal started
                  animating visibility itself, at which point the two were
                  fighting over the same property. Absent beats hidden here:
                  there is nothing to interact with either. */}
                <div
                  ref={measureControl(placement.id)}
                  className={clsx(
                    // `w-max` is load-bearing, not tidying. Absolutely positioned
                    // with no width, this shrink-to-fits against the space left
                    // between its `left` and the container's right edge — so near
                    // that edge it comes back NARROWER than its content, the
                    // measurement feeding the clamp is that squeezed width, and
                    // the clamp concludes it fits while the buttons are cut off.
                    // The wider the row, the further in it starts happening.
                    'pointer-events-auto absolute w-max',
                    // The translate goes with the clamp: a clamped `left` is the
                    // control's own left edge, stated against the box, so
                    // shifting it by half its width afterwards would put it back
                    // outside on the very edges this fixes.
                    !clamped && '-translate-x-1/2',
                    revealClassName
                  )}
                  style={{
                    left: clamped ? clamped.left : `${placement.data.x * 100}%`,
                    // Measured half-height plus a gap, in pixels. No percentage
                    // arithmetic: a percentage in `top` resolves against the box's
                    // height while the sticker is sized from its width, and every
                    // attempt to reconcile the two by calculation has been wrong on
                    // some aspect ratio.
                    top: clamped
                      ? clamped.top
                      : `calc(${placement.data.y * 100}% + ${
                          stickerExtent / 2 + CONTROL_GAP_PX
                        }px)`,
                    // Above every sticker, not just above the one it belongs to:
                    // the layer order means anything placed later covers this
                    // sticker, and it would cover the owner's only way to answer.
                    zIndex: layer,
                    ...delayStyle,
                  }}
                >
                  <div>
                    <StickerPlacementActions
                      placementIds={[placement.id]}
                      hasComment={placement.hasComment}
                      free={placement.free}
                      compact
                    />
                  </div>
                </div>
              </div>
            );

          return (
            <StickerPlacementHoverCard
              key={placement.id}
              placementId={placement.id}
              imageId={placement.imageId}
              pending
            >
              {body}
            </StickerPlacementHoverCard>
          );
        })}
      </div>

      {/* Outside the isolated layer so these out-rank every placed sticker, not
          just the one they belong to. Below the draft on purpose
          (DRAFT_STICKER_Z > PENDING_CONTROL_Z): whatever is under the cursor wins. */}
      {pendingControls.length > 0 && (
        <div
          className="pointer-events-none absolute inset-0 overflow-hidden"
          style={{ zIndex: PENDING_CONTROL_Z }}
        >
          {pendingControls}
        </div>
      )}
    </>
  );
}
