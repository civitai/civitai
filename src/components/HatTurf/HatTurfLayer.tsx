import { useEffect, useRef, useState } from 'react';
import { Button } from '@mantine/core';
import clsx from 'clsx';
import { useTeamColor } from '~/components/Events/events.utils';
import { armReactionNudge } from '~/components/HatTurf/reaction-nudge';
import { HatIcon } from '~/components/HatTurf/HatIcon';
import { HatTimeLeft } from '~/components/HatTurf/HatTimeLeft';
import { useHatTurfCard } from '~/components/HatTurf/HatTurfCardProvider';
import type { HatSpot } from '~/components/HatTurf/HatTurfCardProvider';
import revealClasses from '~/components/Sticker/placement-reveal.module.scss';
import { hatRevealDelays, useHatReveal } from '~/components/HatTurf/useHatReveal';
import classes from '~/components/HatTurf/HatTurfLayer.module.css';
import { TurfHatArt } from '~/components/HatTurf/TurfHatArt';
import { useTurfFeed, useTurfSummary } from '~/components/HatTurf/TurfSummaryProvider';
import { useHatTurfStore } from '~/components/HatTurf/hat-turf.store';
import { useChosenHat } from '~/components/HatTurf/useHatTurf';
import { useHatTurfAction } from '~/components/HatTurf/useHatTurfAction';
import {
  FALLBACK_COLOR,
  badgeLeader,
  hatTone,
  readHatPose,
  turfTopic,
} from '~/components/HatTurf/hat-turf.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { offsetWithin } from '~/components/Sticker/CardStickerOverlay';
import type { HatPose, HatSticker } from '~/components/HatTurf/hat-turf.utils';
import { DraftSticker } from '~/components/Sticker/DraftSticker';
import { resolveTreatment } from '~/components/Sticker/treatments/sticker-treatments';
import { useDraftGestures } from '~/components/Sticker/useDraftGestures';
import { HAT_MAX_SCALE } from '~/server/schema/turf.schema';
import {
  createStickerPlacementDraftStore,
  DraftStoreContext,
} from '~/store/sticker-placement-draft.store';
import type { DraftStoreHook } from '~/store/sticker-placement-draft.store';
import { mediaContentRectOf } from '~/components/Sticker/media-content-rect';
import { useSignalTopic } from '~/components/Signals/SignalsProvider';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * `shownWidth` is the part of the picture's width the card shows; a cropped picture is wider.
 * `visible` is that shown part as fractions of the picture, inset so a hat's controls stay on the card.
 */
type Box = {
  width: number;
  height: number;
  left: number;
  top: number;
  shownWidth: number;
  visible: Visible;
};
type Visible = { x0: number; x1: number; y0: number; y1: number };
/** How far a dragged hat's centre stays inside the card's edge, in px, so its controls stay reachable. */
const DRAG_MARGIN = 28;

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
const UNDRESSED = resolveTreatment({ treatment: 'none', surface: 'detail', isPending: false });

type HatDraftProps = {
  imageId: number;
  cosmeticId: number;
  spot: HatSpot;
  surface: HTMLElement;
  /** The drawn picture's width in px, to size the art like the draft's frame. */
  width: number;
  /** Where on the picture the card shows it; the hat is kept there. */
  visible: Visible;
  artwork: (scale: number) => React.ReactNode;
  saving: boolean;
  onSave: (pose: HatPose) => void;
  onDiscard: () => void;
};

/**
 * The hat being placed, on the sticker editor: drag, corner resize, rotate knob, flip, remove
 * and arrow keys, all from `DraftSticker`. Its own draft store, so it never joins the
 * sticker tray's session; only the commit is a hat's.
 */
function HatDraft(props: HatDraftProps) {
  const [useStore] = useState(createStickerPlacementDraftStore);
  return (
    <DraftStoreContext.Provider value={useStore}>
      <HatDraftSticker {...props} useStore={useStore} />
    </DraftStoreContext.Provider>
  );
}

function HatDraftSticker({
  imageId,
  cosmeticId,
  spot,
  surface,
  width,
  visible,
  artwork,
  saving,
  onSave,
  onDiscard,
  useStore,
}: HatDraftProps & { useStore: DraftStoreHook }) {
  const draft = useStore((state) => state.drafts[0]);
  const onGesture = useDraftGestures(HAT_MAX_SCALE);

  // A cropped feed card hides part of the picture; a hat dragged there would take its
  // controls with it. The store only keeps it on the picture, so this keeps it on the card.
  const { x0, x1, y0, y1 } = visible;
  useEffect(() => {
    if (!draft) return;
    const x = Math.min(x1, Math.max(x0, draft.x));
    const y = Math.min(y1, Math.max(y0, draft.y));
    if (x !== draft.x || y !== draft.y) useStore.getState().move(draft.id, { x, y });
  }, [draft, x0, x1, y0, y1, useStore]);

  useEffect(() => useStore.getState().setSurface(surface), [useStore, surface]);
  useEffect(() => {
    const store = useStore.getState();
    store.open(imageId);
    store.begin(cosmeticId, spot);
    store.closeTray();
    return () => useStore.getState().close();
    // Started once per placement: `spot` is only where it begins.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useStore, imageId]);

  // The editor's own remove control ends the placement.
  const started = useRef(false);
  useEffect(() => {
    if (draft) started.current = true;
    else if (started.current) onDiscard();
  }, [draft, onDiscard]);

  if (!draft) return null;
  const { x, y, scale, rotation, flip } = draft;
  return (
    <DraftSticker
      draft={draft}
      artwork={
        <span style={{ display: 'block', transform: flip ? 'scaleX(-1)' : undefined }}>
          {artwork(scale)}
        </span>
      }
      selected
      dressed={UNDRESSED}
      price={0}
      creatorMaxScale={HAT_MAX_SCALE}
      freeOffer={null}
      ownerShare={undefined}
      ownerUsername={null}
      onGesture={onGesture}
      opaque
      liftOverTray
      knobFlips
      commit={
        <Button
          size="sm"
          radius="xl"
          loading={saving}
          disabled={!width}
          // A placed hat has no move or undo (only a moderator can remove it).
          aria-label="Place hat (free, can't be moved afterwards)"
          title="Free. Can't be moved afterwards."
          onClick={() => onSave({ x, y, scale, rotation, flip, opacity: 1 })}
        >
          Place hat
        </Button>
      }
    />
  );
}

/**
 * Measures the picture like the sticker overlay, so a spot is a fraction of the drawn image, not
 * the letterboxed card, and means the same on image detail.
 */
export type HatTurfLayerProps = {
  imageId: number;
  /** Where the press came from, for the experiment readout. */
  source?: 'feed' | 'image-detail';
  /** Hats to draw when the surface reads its own (image detail); the feed's few per card otherwise. */
  stickers?: HatSticker[];
  /** How many hats to draw; a narrow feed card draws fewer. */
  drawLimit?: number;
  /** Turns the "+N" chip into a button that loads the next hats. */
  onMore?: () => void;
  moreLoading?: boolean;
  /** After a hat is saved, for a surface that reads its hats itself. */
  onPlaced?: () => void;
  /** Pinned to the picture's own top-left corner, not the frame's, on a letterboxed picture. */
  corner?: React.ReactNode;
};

export function HatTurfLayer(props: HatTurfLayerProps) {
  const feed = useTurfFeed();
  // Hooks stay in the inner component so cards without a joined viewer run none.
  if (feed?.joined) return <HatTurfLayerContent {...props} />;
  // A viewer who has not joined sees no hats, though a surface may still pin its corner.
  if (feed && props.corner) return <HatTurfLayerContent {...props} stickers={[]} />;
  return null;
}

function HatTurfLayerContent({
  imageId,
  source = 'feed',
  stickers: stickersProp,
  drawLimit,
  onMore,
  moreLoading,
  onPlaced,
  corner,
}: HatTurfLayerProps) {
  const card = useHatTurfCard();
  const feed = useTurfFeed();
  const summary = useTurfSummary(imageId);
  const user = useCurrentUser();
  const showHats = useHatTurfStore((state) => state.showHats);
  const reveal = useHatReveal(showHats, !!card?.draft);
  const { cosmeticId, hats } = useChosenHat();
  const chosenArt = hats?.find((hat) => hat.cosmeticId === cosmeticId)?.art;
  const teamColor = useTeamColor();
  const utils = trpc.useUtils();
  const place = trpc.hatTurf.place.useMutation();
  const track = useHatTurfAction('feed-card');
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Box | null>(null);
  const [surface, setSurface] = useState<HTMLElement | null>(null);
  // When this visit's placement landed, for its time left.
  const [placedAt, setPlacedAt] = useState<Date | null>(null);
  const stickers = stickersProp ?? feed?.stickers[imageId];
  const active = !!card && (!!card.draft || !!card.placed || !!stickers?.length || !!corner);

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
      const left = at.x - self.x + drawn.left;
      const top = at.y - self.y + drawn.top;
      const span = (start: number, size: number, frame: number) => {
        const lo = Math.max(0, (DRAG_MARGIN - start) / size);
        const hi = Math.min(1, (frame - DRAG_MARGIN - start) / size);
        return lo < hi ? [lo, hi] : [0, 1];
      };
      const [x0, x1] = span(left, drawn.width, node.offsetWidth);
      const [y0, y1] = span(top, drawn.height, node.offsetHeight);
      const next = {
        width: drawn.width,
        height: drawn.height,
        left,
        top,
        shownWidth: Math.min(drawn.width, media.offsetWidth),
        visible: { x0, x1, y0, y1 },
      };
      setBox((current) =>
        current &&
        current.width === next.width &&
        current.height === next.height &&
        current.left === next.left &&
        current.top === next.top &&
        current.shownWidth === next.shownWidth &&
        current.visible.x0 === x0 &&
        current.visible.x1 === x1 &&
        current.visible.y0 === y0 &&
        current.visible.y1 === y1
          ? current
          : next
      );
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
  const colorOf = (team: string | null | undefined) => (team && teamColor(team)) || FALLBACK_COLOR;
  const leader = summary ? badgeLeader(summary) : null;
  const protectedImage = !!summary?.hatted;
  // A fraction of the drawn picture's width, as a sticker's is.
  const hatSize = (scale: number) => (box ? box.width * scale : 0);
  const mineDrawn = placed
    ? (stickers ?? []).filter((sticker) => sticker.userId !== user?.id)
    : stickers ?? [];
  const limit = drawLimit ?? (box && box.shownWidth < NARROW_PICTURE ? 3 : 5);
  const drawn = reveal.visible ? mineDrawn.slice(0, limit) : [];
  const totalShown = summary ? Object.values(summary.shown).reduce((a, b) => a + b, 0) : 0;
  const overflow = reveal.visible ? Math.max(0, totalShown - drawn.length - (placed ? 1 : 0)) : 0;
  const delays = reveal.revealGen ? hatRevealDelays(drawn) : null;
  // The reveal is on the art's wrapper, not the hat: its opacity keyframes would override `.dim`.
  const revealed = (key: string, art: React.ReactNode) =>
    delays ? (
      <div
        key={reveal.revealGen}
        className={revealClasses.appear}
        style={{ ['--sticker-delay' as string]: `${delays.get(key) ?? 0}ms` }}
      >
        {art}
      </div>
    ) : (
      art
    );

  const stop = (event: React.SyntheticEvent) => {
    // The card is a link and this sits on top of it.
    event.preventDefault();
    event.stopPropagation();
  };

  const save = (pose: HatPose) => {
    if (!cosmeticId) return;
    place.mutate(
      { event: feed.event, imageId, cosmeticId, source, data: { ...pose, opacity: 1 } },
      {
        onSuccess: () => {
          if (feed.team)
            armReactionNudge(imageId, feed.team, () =>
              utils.hatTurf.reactionEarns.fetch({ event: feed.event, imageId }, { staleTime: 0 })
            );
          setDraft(null);
          setPlaced(pose);
          setPlacedAt(new Date());
          if (source === 'feed') track('feed_place_save', feed.event);
          void utils.hatTurf.getStock.invalidate();
          void utils.hatTurf.getSummaries.invalidate();
          void utils.hatTurf.getStickersForImages.invalidate();
          onPlaced?.();
        },
        onError: (error) => showErrorNotification({ title: "Couldn't place the hat", error }),
      }
    );
  };

  // Rotation and flip on the art, so the landing animation's transform cannot drop them.
  const poseStyle = (pose: HatPose) => ({
    left: `${pose.x * 100}%`,
    top: `${pose.y * 100}%`,
    transform: 'translate(-50%, -50%)',
  });
  const hatArt = (art: HatSticker['art'], team: string | null | undefined, pose: HatPose) => (
    <span
      style={{
        display: 'block',
        transform: `rotate(${pose.rotation}deg) scaleX(${pose.flip ? -1 : 1})`,
      }}
    >
      <TurfHatArt art={art} color={colorOf(team)} size={hatSize(pose.scale)} />
    </span>
  );

  return (
    <div
      ref={ref}
      className={clsx(classes.layer, (source !== 'feed' || draft) && classes.raised)}
      data-testid="hat-turf-layer"
      data-sticker-overlay
    >
      {feed?.joined && <HatTurfLive imageId={imageId} />}
      {/* Until the picture is measured, the frame's corner stands in for the picture's. */}
      {!box && corner && <div className={classes.corner}>{corner}</div>}
      {box && (
        <div
          ref={setSurface}
          className={clsx(classes.box, reveal.fading && classes.fading)}
          style={{ width: box.width, height: box.height, left: box.left, top: box.top }}
        >
          {corner && <div className={classes.corner}>{corner}</div>}
          {drawn.map((sticker) => {
            const pose = readHatPose(sticker.data);
            if (!pose) return null;
            const own = sticker.userId === user?.id;
            const tone = hatTone(sticker.team, leader, own);
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
                style={{ ...poseStyle(pose), ['--hat-glow' as string]: colorOf(sticker.team) }}
              >
                {revealed(String(sticker.id), hatArt(sticker.art, sticker.team, pose))}
                {own && <HatTimeLeft placedAt={sticker.createdAt} />}
              </div>
            );
          })}
          {reveal.visible && placed && (
            <div
              className={clsx(classes.placed, classes.landed, protectedImage && classes.muted)}
              style={poseStyle(placed)}
              data-testid="hat-turf-placed"
            >
              {hatArt(chosenArt, feed.team, placed)}
              <HatTimeLeft placedAt={placedAt} />
            </div>
          )}
          {/* Shown with Show hats off too: placing a hat is still the game. */}
          {draft && surface && cosmeticId != null && (
            // The card is a link: a press on the editor must not follow it.
            <div className="contents" data-testid="hat-turf-draft" onClick={stop}>
              <HatDraft
                imageId={imageId}
                cosmeticId={cosmeticId}
                spot={draft}
                surface={surface}
                width={box.width}
                visible={box.visible}
                artwork={(scale) => (
                  <TurfHatArt art={chosenArt} color={colorOf(feed.team)} size={hatSize(scale)} />
                )}
                saving={place.isPending}
                onSave={save}
                onDiscard={() => setDraft(null)}
              />
            </div>
          )}
          {overflow > 0 &&
            (onMore ? (
              <button
                type="button"
                className={clsx(
                  classes.more,
                  source === 'feed' && classes.moreFeed,
                  classes.moreButton
                )}
                data-testid="hat-turf-more"
                disabled={moreLoading}
                onClick={(event) => {
                  stop(event);
                  onMore();
                }}
              >
                <HatIcon size={14} />+{overflow} more
              </button>
            ) : (
              <div
                className={clsx(classes.more, source === 'feed' && classes.moreFeed)}
                data-testid="hat-turf-more"
                title={`${overflow} more hats`}
              >
                <HatIcon size={14} />+{overflow}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
