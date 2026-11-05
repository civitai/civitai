import { useEffect, useRef, useState } from 'react';
import { Button } from '@mantine/core';
import clsx from 'clsx';
import { useTeamColor } from '~/components/Events/events.utils';
import { HatIcon } from '~/components/HatTurf/HatIcon';
import { useHatTurfCard } from '~/components/HatTurf/HatTurfCardProvider';
import type { HatSpot } from '~/components/HatTurf/HatTurfCardProvider';
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
import { STICKER_PLACEMENT_MAX_SCALE } from '~/shared/utils/sticker-placement';
import {
  createStickerPlacementDraftStore,
  DraftStoreContext,
} from '~/store/sticker-placement-draft.store';
import type { DraftStoreHook } from '~/store/sticker-placement-draft.store';
import { mediaContentRectOf } from '~/components/Sticker/media-content-rect';
import { useSignalTopic } from '~/components/Signals/SignalsProvider';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/** `shownWidth` is the part of the picture's width the card shows; a cropped picture is wider. */
type Box = { width: number; height: number; left: number; top: number; shownWidth: number };

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
  artwork: (scale: number) => React.ReactNode;
  saving: boolean;
  onSave: (pose: HatPose) => void;
  onDiscard: () => void;
};

/**
 * The hat being placed, on the sticker editor: drag, corner resize, rotate knob, flip, opacity,
 * remove and arrow keys, all from `DraftSticker`. Its own draft store, so it never joins the
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
  artwork,
  saving,
  onSave,
  onDiscard,
  useStore,
}: HatDraftProps & { useStore: DraftStoreHook }) {
  const draft = useStore((state) => state.drafts[0]);
  const onGesture = useDraftGestures(STICKER_PLACEMENT_MAX_SCALE);

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
  const { x, y, scale, rotation, flip, opacity } = draft;
  return (
    <DraftSticker
      draft={draft}
      artwork={artwork(scale)}
      selected
      dressed={UNDRESSED}
      price={0}
      creatorMaxScale={STICKER_PLACEMENT_MAX_SCALE}
      freeOffer={null}
      ownerShare={undefined}
      ownerUsername={null}
      onGesture={onGesture}
      commit={
        <Button
          size="sm"
          radius="xl"
          loading={saving}
          disabled={!width}
          onClick={() => onSave({ x, y, scale, rotation, flip, opacity })}
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
  const { cosmeticId, hats } = useChosenHat();
  const chosenArt = hats?.find((hat) => hat.cosmeticId === cosmeticId)?.art;
  const teamColor = useTeamColor();
  const utils = trpc.useUtils();
  const place = trpc.hatTurf.place.useMutation();
  const track = useHatTurfAction('feed-card');
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Box | null>(null);
  const [surface, setSurface] = useState<HTMLElement | null>(null);
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
      const next = {
        width: drawn.width,
        height: drawn.height,
        left: at.x - self.x + drawn.left,
        top: at.y - self.y + drawn.top,
        shownWidth: Math.min(drawn.width, media.offsetWidth),
      };
      setBox((current) =>
        current &&
        current.width === next.width &&
        current.height === next.height &&
        current.left === next.left &&
        current.top === next.top &&
        current.shownWidth === next.shownWidth
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
  const drawn = showHats ? mineDrawn.slice(0, limit) : [];
  const totalShown = summary ? Object.values(summary.shown).reduce((a, b) => a + b, 0) : 0;
  const overflow = showHats ? Math.max(0, totalShown - drawn.length - (placed ? 1 : 0)) : 0;

  const stop = (event: React.SyntheticEvent) => {
    // The card is a link and this sits on top of it.
    event.preventDefault();
    event.stopPropagation();
  };

  const save = (pose: HatPose) => {
    if (!cosmeticId) return;
    place.mutate(
      { event: feed.event, imageId, cosmeticId, source, data: pose },
      {
        onSuccess: () => {
          setDraft(null);
          setPlaced(pose);
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
        opacity: pose.opacity,
        transform: `rotate(${pose.rotation}deg) scaleX(${pose.flip ? -1 : 1})`,
      }}
    >
      <TurfHatArt art={art} color={colorOf(team)} size={hatSize(pose.scale)} />
    </span>
  );

  return (
    <div ref={ref} className={classes.layer} data-testid="hat-turf-layer" data-sticker-overlay>
      {feed?.joined && <HatTurfLive imageId={imageId} />}
      {/* Until the picture is measured, the frame's corner stands in for the picture's. */}
      {!box && corner && <div className={classes.corner}>{corner}</div>}
      {box && (
        <div
          ref={setSurface}
          className={classes.box}
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
                {hatArt(sticker.art, sticker.team, pose)}
              </div>
            );
          })}
          {showHats && placed && (
            <div
              className={clsx(classes.placed, classes.landed, protectedImage && classes.muted)}
              style={poseStyle(placed)}
              data-testid="hat-turf-placed"
            >
              {hatArt(chosenArt, feed.team, placed)}
            </div>
          )}
          {draft && showHats && surface && cosmeticId != null && (
            // The card is a link: a press on the editor must not follow it.
            <div className="contents" data-testid="hat-turf-draft" onClick={stop}>
              <HatDraft
                imageId={imageId}
                cosmeticId={cosmeticId}
                spot={draft}
                surface={surface}
                width={box.width}
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
                className={clsx(classes.more, classes.moreButton)}
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
                className={classes.more}
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
