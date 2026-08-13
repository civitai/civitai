import clsx from 'clsx';
import { EdgeImage } from '~/components/EdgeMedia/EdgeImage';
import type { ResolvedSticker } from '~/components/Sticker/sticker.util';
import { useStickerCosmetics } from '~/components/Sticker/sticker.util';
import type { PlacedSticker } from '~/components/Sticker/placement.util';
import { orderPlacements, placementRevealDelays } from '~/components/Sticker/placement-order';
import { stickerArtworkStyle } from '~/components/Sticker/placement-appearance';
import { StickerPlacementActions } from '~/components/Sticker/StickerPlacementActions';
import { StickerPlacementHoverCard } from '~/components/Sticker/StickerPlacementHoverCard';
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
 * The pending controls' layer, above the stickers and above the draft.
 *
 * Only has to clear the draft sticker's own z-index, which is 1 — the number is
 * this far clear of it so a later hand-written z-index nearby does not silently
 * bury the owner's only way to answer a pending placement.
 */
const PENDING_CONTROL_Z = 1000;

/**
 * Clear air between the bottom of a pending sticker and the owner's controls.
 *
 * Generous rather than tight: the artwork sways for as long as it is on screen,
 * and the treatments draw shadows and a die-cut edge outside the element's box,
 * so a gap measured to the pixel is a gap the sticker moves into.
 */
const CONTROL_GAP_PX = 14;

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
  const [stickerHeights, setStickerHeights] = useState<Record<number, number>>({});
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
      const radians = (placement.data.rotation * Math.PI) / 180;
      const existing = disposers.current.get(placementId);
      if (existing) {
        existing();
        disposers.current.delete(placementId);
      }
      if (!node) return;

      const read = () =>
        // `offsetHeight`/`offsetWidth`, deliberately: they are LAYOUT numbers and
        // ignore transforms. A bounding rect would be simpler and is wrong here,
        // because the artwork animates — it pops from 0.72 to 1.06 on arrival and
        // sways forever after — so a rect measured at observe time is whatever
        // frame that landed on, and a sticker measured mid-pop reports too small
        // and the controls sit on top of it.
        //
        // The rotation is then added back by hand: a tilted rectangle's visual
        // height is h·|cos r| + w·|sin r|, and ignoring the second term is what
        // put the buttons over the artwork on anything more than slightly
        // turned.
        node.offsetHeight * Math.abs(Math.cos(radians)) +
        node.offsetWidth * Math.abs(Math.sin(radians));

      const record = () => {
        const height = read();
        // Guarded, because writing state from a ResizeObserver that the write
        // then resizes is how a resize loop starts.
        setStickerHeights((current) =>
          current[placementId] === height ? current : { ...current, [placementId]: height }
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

  // The owner's approve/decline for each pending placement, collected here and
  // drawn in their own layer below. They cannot live in the isolated layer: they
  // have to out-rank the draft sticker as well as every placed one, and the
  // isolation that keeps the layer order from leaking would trap them under it.
  const pendingControls: ReactElement[] = [];

  return (
    <>
      {/* `isolate` is load-bearing. Without it these z-indexes are hoisted into
          whatever context the surface provides and compete with everything else
          in it: on the detail view the draft being dragged (which is a sibling
          with z-index 1 at most, so every sticker above the first would cover
          it, along with its buy button and its hit area), and on a feed card the
          header and footer, which are absolutely positioned with no z-index of
          their own and rely on DOM order — AspectRatioImageCard states "under
          the header and footer" as a contract. Contained, the whole layer keeps
          the z-index it had before this change, and the ordering inside it is
          purely internal. */}
      <div
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
          if (stickerHeights[placement.id] > 0)
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
                costs three worse things, and the third is why the obvious
                restructure is not enough on its own:
                  - the badge lands inside the hover-card trigger, whose 400px
                    dropdown opens over the owner's approve/decline — fixed by
                    having the hover card wrap only the artwork;
                  - rotation is clamped to ±180, so the badge goes upside down
                    AND ends up above the sticker. Counter-rotating fixes only
                    the first half; `top-full` is the local bottom edge, which
                    at 180° is the screen top and at 90° is off to the side.
                    Staying upright and staying below are two separate fixes;
                  - `body`'s transform makes it a stacking context, so a z-index
                    inside it stops out-ranking other placements — a draft
                    dragged over a pending one then swallows the owner's
                    buttons. Nothing done INSIDE the box can fix that; it needs
                    the badge kept outside the transform (what this does) or a
                    z-index on the pending wrapper itself. */}
                {/* Not rendered at all until the sticker has been measured.
                  Rendering it early would put it at the sticker's centre — on
                  top of the artwork — and then jump when the measurement lands.
                  An inline `visibility` did that job until the reveal started
                  animating visibility itself, at which point the two were
                  fighting over the same property. Absent beats hidden here:
                  there is nothing to interact with either. */}
                <div
                  className={clsx('pointer-events-auto absolute -translate-x-1/2', revealClassName)}
                  style={{
                    left: `${placement.data.x * 100}%`,
                    // Measured half-height plus a gap, in pixels. No percentage
                    // arithmetic: a percentage in `top` resolves against the box's
                    // height while the sticker is sized from its width, and every
                    // attempt to reconcile the two by calculation has been wrong on
                    // some aspect ratio.
                    top: `calc(${placement.data.y * 100}% + ${
                      stickerHeights[placement.id] / 2 + CONTROL_GAP_PX
                    }px)`,
                    // Above every sticker, not just above the one it belongs to:
                    // the layer order means anything placed later covers this
                    // sticker, and it would cover the owner's only way to answer.
                    zIndex: layer,
                    ...delayStyle,
                  }}
                >
                  <div>
                    {isOwner ? (
                      <StickerPlacementActions
                        placementIds={[placement.id]}
                        hasComment={placement.hasComment}
                        compact
                      />
                    ) : (
                      <span className="whitespace-nowrap rounded bg-yellow-6 px-2 py-0.5 text-[10px] font-semibold text-dark-9">
                        Awaiting review
                      </span>
                    )}
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

      {/* Outside the isolated layer, and above the draft: an owner arranging
          their own sticker must not lose the buttons that answer someone
          else's. Deliberately NOT inside the layer above — isolation would trap
          these under the draft along with everything else. */}
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
