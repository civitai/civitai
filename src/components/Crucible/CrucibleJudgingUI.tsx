import {
  ActionIcon,
  Button,
  Kbd,
  Paper,
  Text,
  Loader,
  Box,
  Skeleton,
  Tooltip,
} from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import {
  IconPlayerSkipForward,
  IconCheck,
  IconPhotoOff,
  IconRefresh,
  IconVolume,
  IconVolumeOff,
} from '@tabler/icons-react';
import clsx from 'clsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import type { RouterOutput } from '~/types/router';
import { MediaType } from '~/shared/utils/prisma/enums';
import {
  accumulatePlaybackMs,
  CRUCIBLE_PLAYBACK_SAMPLE_CEILING_MS,
  playsToEnd,
} from '~/shared/constants/crucible.constants';

/**
 * Type inferred from tRPC router output - stays in sync with backend automatically
 */
export type JudgingPairData = RouterOutput['crucible']['getJudgingPair'];

/**
 * Entry type for judging - extracted from JudgingPairData
 */
export type JudgingEntry = NonNullable<JudgingPairData>['left'];

export type WatchedMs = { winnerWatchedMs: number; loserWatchedMs: number };

type Side = 'left' | 'right';
type MediaStatus = 'loading' | 'loaded' | 'error';

const IMAGE_LOAD_TIMEOUT_MS = 12_000;
const VIDEO_LOAD_TIMEOUT_MS = 20_000;
const bothLoading = { left: 'loading', right: 'loading' } as const;
const notPlayedThrough = { left: false, right: false };
const noDurations = { left: null, right: null };
const LOOP_WRAP_WINDOW_SECONDS = CRUCIBLE_PLAYBACK_SAMPLE_CEILING_MS / 1000;

// Below md the pair gets fixed heights and the page scrolls: squeezed into the space left under
// the header, a phone (landscape especially) cropped each entry to a strip.
const pairGridClass =
  'grid grid-cols-1 gap-3 max-md:landscape:grid-cols-2 md:min-h-0 md:flex-1 md:grid-cols-2 md:gap-4';
const mediaBoxClass =
  'h-[36svh] min-h-[200px] max-md:landscape:h-[calc(100svh-8rem)] md:h-auto md:min-h-0 md:flex-1';

// A held key would otherwise vote on every pair that loads while it is down.
const ignoreKeyRepeat = (action: () => void) => (event: KeyboardEvent) => {
  if (!event.repeat) action();
};

export type CrucibleJudgingUIProps = {
  pair: JudgingPairData;
  isLoading?: boolean;
  disabled?: boolean;
  /**
   * Playback each clip needs before either vote unlocks. Null or absent means no rule. Overridden
   * per side by `pair.watchSeconds`, which shortens a clip already judged this session.
   */
  minViewSeconds?: number | null;
  onVote: (winnerId: number, loserId: number, watched: WatchedMs) => void;
  /** `unavailable`: an entry in the pair didn't load, so skipping wasn't the judge's choice. */
  onSkip: (skip: { unavailable: boolean }) => void;
  className?: string;
};

export function CrucibleJudgingUI({
  pair,
  isLoading,
  disabled,
  minViewSeconds,
  onVote,
  onSkip,
  className,
}: CrucibleJudgingUIProps) {
  const [selectedSide, setSelectedSide] = useState<Side | null>(null);
  const [watchedMs, setWatchedMs] = useState<Record<Side, number>>(emptyWatched);
  const [playedThrough, setPlayedThrough] = useState<Record<Side, boolean>>(notPlayedThrough);
  const [reachedEnd, setReachedEnd] = useState<Record<Side, boolean>>(notPlayedThrough);
  const [durations, setDurations] = useState<Record<Side, number | null>>(noDurations);
  const [mediaStatus, setMediaStatus] = useState<
    { pairKey: string | null } & Record<Side, MediaStatus>
  >({ pairKey: null, ...bothLoading });
  const [playingSide, setPlayingSide] = useState<Side | null>(null);
  const [soundWanted, setSoundWanted] = useState(true);
  const [soundBlockedPairKey, setSoundBlockedPairKey] = useState<string | null>(null);
  const isDisabled = disabled || isLoading || !pair;

  const pairKey = pair ? `${pair.left.id}:${pair.right.id}` : null;
  // A browser refusal is retried on the next pair: the judge has usually clicked something by
  // then, which is what the browser was waiting for. Only the judge's own mute sticks.
  const soundOn = soundWanted && soundBlockedPairKey !== pairKey;
  const handleSoundChange = useCallback((on: boolean) => {
    setSoundWanted(on);
    if (on) setSoundBlockedPairKey(null);
  }, []);
  const handleSoundBlocked = useCallback(() => setSoundBlockedPairKey(pairKey), [pairKey]);
  useEffect(() => {
    setWatchedMs(emptyWatched);
    setPlayedThrough(notPlayedThrough);
    setReachedEnd(notPlayedThrough);
    setDurations(noDurations);
  }, [pairKey]);

  // Keyed on the pair so a new pair reads as loading from its first render, not after an effect.
  const media = mediaStatus.pairKey === pairKey ? mediaStatus : bothLoading;
  const mediaReady = media.left === 'loaded' && media.right === 'loaded';

  const handleMediaStatus = useCallback(
    (side: Side, status: MediaStatus) =>
      setMediaStatus((prev) => {
        const current = prev.pairKey === pairKey ? prev : { pairKey, ...bothLoading };
        return current[side] === status ? current : { ...current, [side]: status };
      }),
    [pairKey]
  );

  const ruleSeconds = (side: Side) =>
    (pair?.watchSeconds ? pair.watchSeconds[side] : minViewSeconds) ?? 0;
  const requiredMs: Record<Side, number> = {
    left: ruleSeconds('left') * 1000,
    right: ruleSeconds('right') * 1000,
  };
  // A clip shorter than the rule can never reach it, so playing it to its end once is enough.
  const sideDone = (side: Side) => playedThrough[side] || watchedMs[side] >= requiredMs[side];
  // The server checks the rule, not the clip's length, so a played-through short clip reports it.
  const reportedMs = (side: Side) =>
    playedThrough[side] ? Math.max(watchedMs[side], requiredMs[side]) : watchedMs[side];
  const remainingMs = (['left', 'right'] as const).reduce(
    (sum, side) => sum + (sideDone(side) ? 0 : Math.max(0, requiredMs[side] - watchedMs[side])),
    0
  );
  const watchGateOpen = remainingMs === 0;

  // Left plays its share, then right, then the judge is on their own. Derived from the watched
  // totals so a judge who plays a clip by hand is counted rather than fought.
  const isVideoPair =
    pair?.left.image.type === MediaType.video && pair?.right.image.type === MediaType.video;
  // The gate opens at the rule, but a clip only a little longer still plays on to its end.
  const playbackDone = (side: Side) =>
    sideDone(side) && (reachedEnd[side] || !playsToEnd(durations[side], ruleSeconds(side)));
  const sequencing = isVideoPair && mediaReady && !(playbackDone('left') && playbackDone('right'));
  const autoplaySide: Side | null = !sequencing ? null : !playbackDone('left') ? 'left' : 'right';
  const voteLocked = isDisabled || !mediaReady || !watchGateOpen;

  const handleWatched = useCallback((side: Side, ms: number, durationSeconds: number) => {
    setWatchedMs((prev) => (ms > prev[side] ? { ...prev, [side]: ms } : prev));
    setDurations((prev) =>
      prev[side] === durationSeconds ? prev : { ...prev, [side]: durationSeconds }
    );
  }, []);

  const handleReachedEnd = useCallback((side: Side) => {
    setReachedEnd((prev) => (prev[side] ? prev : { ...prev, [side]: true }));
  }, []);

  const handlePlayedThrough = useCallback((side: Side) => {
    setPlayedThrough((prev) => (prev[side] ? prev : { ...prev, [side]: true }));
  }, []);

  // The parent locks only once `onVote` runs, so clicks inside the feedback delay would each vote.
  const voteQueued = useRef(false);
  const handleVote = useCallback(
    (side: Side) => {
      if (voteLocked || !pair || voteQueued.current) return;

      voteQueued.current = true;
      setSelectedSide(side);

      // Small delay for visual feedback, then call onVote
      setTimeout(() => {
        voteQueued.current = false;
        const winnerId = side === 'left' ? pair.left.id : pair.right.id;
        const loserId = side === 'left' ? pair.right.id : pair.left.id;
        onVote(winnerId, loserId, {
          winnerWatchedMs: reportedMs(side),
          loserWatchedMs: reportedMs(side === 'left' ? 'right' : 'left'),
        });
        setSelectedSide(null);
      }, 200);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `reportedMs` reads only the deps below
    [voteLocked, pair, onVote, watchedMs, playedThrough, requiredMs.left, requiredMs.right]
  );

  const anyUnavailable = media.left === 'error' || media.right === 'error';
  const handleSkip = useCallback(() => {
    if (isDisabled) return;
    setSelectedSide(null);
    onSkip({ unavailable: anyUnavailable });
  }, [isDisabled, onSkip, anyUnavailable]);

  // Keyboard shortcuts
  useHotkeys(
    voteLocked
      ? [
          // Skip stays live while voting is locked: a judge facing an entry that won't load, or
          // who does not want to watch either clip through, needs a way past the pair.
          ['Space', ignoreKeyRepeat(handleSkip)],
        ]
      : [
          ['1', ignoreKeyRepeat(() => handleVote('left'))],
          ['ArrowLeft', ignoreKeyRepeat(() => handleVote('left'))],
          ['2', ignoreKeyRepeat(() => handleVote('right'))],
          ['ArrowRight', ignoreKeyRepeat(() => handleVote('right'))],
          ['Space', ignoreKeyRepeat(handleSkip)],
        ],
    // VIDEO on top of Mantine's defaults: a focused video player answers Space with play/pause and
    // the arrows with seek, and every one of those is also bound here — so without it, pausing a
    // clip skips the pair and seeking it casts a vote.
    ['INPUT', 'TEXTAREA', 'SELECT', 'VIDEO']
  );

  // Loading state
  if (isLoading && !pair) {
    return <CrucibleJudgingUISkeleton />;
  }

  // No pair available
  if (!pair && !isLoading) {
    return null; // Parent should handle empty state
  }

  return (
    <div className={clsx('flex flex-col gap-4', className)}>
      <div className={pairGridClass}>
        <ImageCard
          entry={pair?.left ?? null}
          position="left"
          isSelected={selectedSide === 'left'}
          isLoading={isLoading}
          disabled={voteLocked}
          pairKey={pairKey}
          watchedMs={sideDone('left') ? Math.max(watchedMs.left, requiredMs.left) : watchedMs.left}
          requiredMs={requiredMs.left}
          autoplay={autoplaySide === 'left'}
          sequencing={sequencing}
          onWatched={(ms, durationSeconds) => handleWatched('left', ms, durationSeconds)}
          onPlayedThrough={() => handlePlayedThrough('left')}
          onReachedEnd={() => handleReachedEnd('left')}
          onVote={() => handleVote('left')}
          onSkip={handleSkip}
          onMediaStatus={handleMediaStatus}
          otherPlaying={playingSide === 'right'}
          onPlay={setPlayingSide}
          soundOn={soundOn}
          onSoundChange={handleSoundChange}
          onSoundBlocked={handleSoundBlocked}
          hotkeyLabel="1"
        />

        <ImageCard
          entry={pair?.right ?? null}
          position="right"
          isSelected={selectedSide === 'right'}
          isLoading={isLoading}
          disabled={voteLocked}
          pairKey={pairKey}
          watchedMs={
            sideDone('right') ? Math.max(watchedMs.right, requiredMs.right) : watchedMs.right
          }
          requiredMs={requiredMs.right}
          autoplay={autoplaySide === 'right'}
          sequencing={sequencing}
          onWatched={(ms, durationSeconds) => handleWatched('right', ms, durationSeconds)}
          onPlayedThrough={() => handlePlayedThrough('right')}
          onReachedEnd={() => handleReachedEnd('right')}
          onVote={() => handleVote('right')}
          onSkip={handleSkip}
          onMediaStatus={handleMediaStatus}
          otherPlaying={playingSide === 'left'}
          onPlay={setPlayingSide}
          soundOn={soundOn}
          onSoundChange={handleSoundChange}
          onSoundBlocked={handleSoundBlocked}
          hotkeyLabel="2"
        />
      </div>

      <div className="flex shrink-0 flex-col items-center gap-2 md:flex-row md:justify-center md:gap-4">
        <Tooltip
          label="Skips this pair without voting. The pair may appear again later."
          position="top"
          withArrow
        >
          <Button
            variant="default"
            size="md"
            onClick={handleSkip}
            disabled={isDisabled}
            className="border-[#495057] bg-[#373a40] font-semibold text-[#c1c2c5] hover:border-[#5c636e] hover:bg-[#495057]"
            styles={{
              root: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.5rem',
              },
              inner: {
                display: 'flex',
                width: '100%',
                alignItems: 'center',
                justifyContent: 'center',
              },
            }}
            leftSection={<IconPlayerSkipForward size={18} />}
            rightSection={<Kbd>Space</Kbd>}
          >
            Skip Pair
          </Button>
        </Tooltip>

        <Text size="xs" c="dimmed" className="hidden whitespace-nowrap md:block">
          Press <Kbd>1</Kbd> or <Kbd>←</Kbd> to vote left, <Kbd>2</Kbd> or <Kbd>→</Kbd> to vote
          right, <Kbd>Space</Kbd> to skip
        </Text>
      </div>
    </div>
  );
}

const emptyWatched = { left: 0, right: 0 };

type ImageCardProps = {
  entry: JudgingEntry | null;
  position: Side;
  isSelected: boolean;
  isLoading?: boolean;
  disabled: boolean;
  pairKey: string | null;
  watchedMs: number;
  requiredMs: number;
  autoplay: boolean;
  sequencing: boolean;
  onWatched: (ms: number, durationSeconds: number) => void;
  onPlayedThrough: () => void;
  onReachedEnd: () => void;
  onVote: () => void;
  onSkip: () => void;
  onMediaStatus: (side: Side, status: MediaStatus) => void;
  otherPlaying: boolean;
  onPlay: (side: Side) => void;
  soundOn: boolean;
  onSoundChange: (soundOn: boolean) => void;
  onSoundBlocked: () => void;
  hotkeyLabel: string;
};

/**
 * Individual image card for judging
 */
function ImageCard({
  entry,
  position,
  isSelected,
  isLoading,
  disabled,
  pairKey,
  watchedMs,
  requiredMs,
  autoplay,
  sequencing,
  onWatched,
  onPlayedThrough,
  onReachedEnd,
  onVote,
  onSkip,
  onMediaStatus,
  otherPlaying,
  onPlay,
  soundOn,
  onSoundChange,
  onSoundBlocked,
  hotkeyLabel,
}: ImageCardProps) {
  const [attempt, setAttempt] = useState(0);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (disabled || e.repeat) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onVote();
    }
  };

  const lastTimeRef = useRef<number | null>(null);
  const watchedRef = useRef(0);
  // Keyed on the PAIR, not on this entry: pair selection is a random sample that excludes only
  // skipped entries, so the same entry routinely carries over into the next pair. Keyed on the
  // entry alone, that card kept its accumulated playback while the parent reset the gate to zero,
  // and the first `timeupdate` handed the stale total straight back — unlocking a vote on the new
  // pair without watching any of it.
  useEffect(() => {
    lastTimeRef.current = null;
    watchedRef.current = 0;
  }, [entry?.id, pairKey]);

  const handleTimeUpdate = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const { currentTime, duration } = e.currentTarget;
    const previousTime = lastTimeRef.current;
    // The player loops, so `ended` never fires: reaching the end shows up as the playhead wrapping.
    // The element's decoded duration, not the uploader-reported one, decides what counts as short.
    const wrapped =
      previousTime != null &&
      currentTime < previousTime &&
      previousTime >= duration - LOOP_WRAP_WINDOW_SECONDS &&
      currentTime <= LOOP_WRAP_WINDOW_SECONDS;
    if (wrapped && duration * 1000 < requiredMs) onPlayedThrough();
    // Only after the rule is met, so a skip to the end cannot cut the tail short.
    if (wrapped && watchedRef.current >= requiredMs) onReachedEnd();
    watchedRef.current = accumulatePlaybackMs({
      watchedMs: watchedRef.current,
      previousTime: lastTimeRef.current,
      currentTime,
    });
    lastTimeRef.current = currentTime;
    onWatched(watchedRef.current, duration);
  };

  const remainingSeconds = Math.ceil(Math.max(0, requiredMs - watchedMs) / 1000);

  if (!entry) {
    return <Skeleton radius="lg" className={mediaBoxClass} />;
  }

  const isVideo = entry.image.type === MediaType.video;

  return (
    <Paper
      className={clsx(
        'flex min-h-0 cursor-pointer flex-col overflow-hidden rounded-xl border-2 transition-all duration-200',
        'focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-[#1a1b1e]',
        isSelected
          ? 'border-green-500 shadow-[0_0_20px_rgba(64,192,87,0.3)]'
          : 'border-transparent hover:-translate-y-0.5 hover:border-blue-500'
      )}
      bg="dark.7"
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-label={`Vote for ${position} ${isVideo ? 'video' : 'image'}`}
      aria-disabled={disabled}
      data-watch-remaining={remainingSeconds || undefined}
      onClick={disabled ? undefined : onVote}
      onKeyDown={handleKeyDown}
    >
      <Box
        className={clsx('relative bg-[#1a1b1e]', mediaBoxClass)}
        // A video owns its own clicks: scrubbing, play/pause and unmuting all land inside this
        // box, and the card votes on click, so without this every control press is a misvote.
        // Voting a video is therefore the Vote button or the hotkey. Images still vote on click.
        onClick={isVideo ? (e: React.MouseEvent) => e.stopPropagation() : undefined}
        onKeyDown={isVideo ? (e: React.KeyboardEvent) => e.stopPropagation() : undefined}
      >
        {isLoading ? (
          <div className="flex size-full items-center justify-center">
            <Loader size="lg" />
          </div>
        ) : (
          <JudgingMedia
            // A fresh element per pair and per retry, so each starts paused, muted and unloaded.
            key={`${pairKey}:${attempt}`}
            entry={entry}
            side={position}
            onStatus={onMediaStatus}
            onRetry={() => setAttempt((n) => n + 1)}
            onSkip={onSkip}
            otherPlaying={otherPlaying}
            autoplay={autoplay}
            sequencing={sequencing}
            onPlay={onPlay}
            soundOn={soundOn}
            onSoundChange={onSoundChange}
            onSoundBlocked={onSoundBlocked}
            onTimeUpdate={handleTimeUpdate}
          />
        )}

        {/* Selected indicator */}
        {isSelected && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40">
            <div className="flex size-16 items-center justify-center rounded-full bg-green-500">
              <IconCheck size={32} className="text-white" />
            </div>
          </div>
        )}
      </Box>

      {/* Vote button section */}
      <div className="flex shrink-0 items-center justify-center gap-3 p-2 md:p-3">
        <Button
          className={clsx(
            'flex-1 font-semibold transition-all duration-200',
            isSelected
              ? 'bg-green-600 hover:bg-green-500'
              : 'bg-blue-600 hover:-translate-y-0.5 hover:bg-blue-500'
          )}
          size="md"
          data-testid="judge-vote"
          onClick={(e: React.MouseEvent) => {
            e.stopPropagation();
            if (!disabled) onVote();
          }}
          disabled={disabled}
        >
          <span className="flex items-center gap-2">
            {remainingSeconds > 0 ? `Watch ${remainingSeconds}s more` : 'Vote'}
            <Kbd size="xs" className="opacity-75">
              {hotkeyLabel}
            </Kbd>
          </span>
        </Button>
      </div>
    </Paper>
  );
}

type JudgingMediaProps = {
  entry: JudgingEntry;
  side: Side;
  onStatus: (side: Side, status: MediaStatus) => void;
  onRetry: () => void;
  onSkip: () => void;
  otherPlaying: boolean;
  autoplay: boolean;
  sequencing: boolean;
  onPlay: (side: Side) => void;
  soundOn: boolean;
  onSoundChange: (soundOn: boolean) => void;
  onSoundBlocked: () => void;
  onTimeUpdate: (e: React.SyntheticEvent<HTMLVideoElement>) => void;
};

function JudgingMedia({
  entry,
  side,
  onStatus,
  onRetry,
  onSkip,
  otherPlaying,
  autoplay,
  sequencing,
  onPlay,
  soundOn,
  onSoundChange,
  onSoundBlocked,
  onTimeUpdate,
}: JudgingMediaProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<MediaStatus>('loading');
  const isVideo = entry.image.type === MediaType.video;
  const getVideo = () => ref.current?.querySelector('video') ?? null;

  useEffect(() => {
    onStatus(side, status);
  }, [side, status, onStatus]);

  // A stalled request fires neither load nor error, and would otherwise spin forever.
  useEffect(() => {
    if (status !== 'loading') return;
    const timeout = setTimeout(
      () => setStatus('error'),
      isVideo ? VIDEO_LOAD_TIMEOUT_MS : IMAGE_LOAD_TIMEOUT_MS
    );
    return () => clearTimeout(timeout);
  }, [status, isVideo]);

  const applySound = useCallback(() => {
    const video = ref.current?.querySelector('video');
    if (video) video.muted = !soundOn;
  }, [soundOn]);
  useEffect(applySound, [applySound]);

  // Browsers refuse sound until the judge has interacted with the page (Safari, per element), so a
  // refused clip falls back to muted, and the toggle shows it, rather than not playing at all.
  // The retry un-pauses the clip before its `volumechange` is dispatched, so without this the
  // fallback's own mute reads as the judge pressing mute, and sound never comes back.
  const fallbackMuted = useRef(false);
  const play = useCallback(
    (video: HTMLVideoElement) => {
      video.play().catch((error: unknown) => {
        if ((error as Error)?.name !== 'NotAllowedError' || video.muted) return;
        fallbackMuted.current = true;
        video.muted = true;
        onSoundBlocked();
        video.play().catch(() => undefined);
      });
    },
    [onSoundBlocked]
  );

  useEffect(() => {
    if (otherPlaying) ref.current?.querySelector('video')?.pause();
  }, [otherPlaying]);

  const wasAutoplaying = useRef(false);
  useEffect(() => {
    const video = getVideo();
    if (!video) return;
    if (autoplay) {
      applySound();
      play(video);
    } else if (wasAutoplaying.current) {
      video.pause();
    }
    wasAutoplaying.current = autoplay;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `getVideo` only reads the ref
  }, [autoplay, applySound, play]);

  const handleLoaded = () => {
    setStatus('loaded');
    // Again once loaded: EdgeVideo re-applies its own `muted` while its stored volume hydrates.
    applySound();
  };

  const handleError = (e: React.SyntheticEvent) => {
    const target = e.target as HTMLElement;
    // A failed <source> only moves the browser on to the next one.
    if (target.tagName === 'SOURCE' && target.nextElementSibling) return;
    setStatus('error');
  };

  const handlePointerEnter = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse' || sequencing) return;
    const video = getVideo();
    if (!video) return;
    video.muted = !soundOn;
    play(video);
  };

  const handlePointerLeave = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && !sequencing) getVideo()?.pause();
  };

  const handleVolumeChange = (e: React.SyntheticEvent) => {
    const video = e.target as HTMLVideoElement;
    if (fallbackMuted.current) {
      fallbackMuted.current = false;
      return;
    }
    // A paused element's `muted` is also rewritten by EdgeVideo itself, so only a playing clip's
    // native mute button is taken as the judge's choice.
    if (!video.paused) onSoundChange(!video.muted);
  };

  return (
    <div
      ref={ref}
      className="relative size-full"
      data-media-status={status}
      onLoadCapture={handleLoaded}
      onLoadedMetadataCapture={handleLoaded}
      onErrorCapture={handleError}
      onPlayCapture={isVideo ? () => onPlay(side) : undefined}
      onVolumeChangeCapture={isVideo ? handleVolumeChange : undefined}
      onPointerEnter={isVideo ? handlePointerEnter : undefined}
      onPointerLeave={isVideo ? handlePointerLeave : undefined}
    >
      <EdgeMedia
        src={entry.image.url}
        type={entry.image.type}
        // Off for video, where it autoplays every clip in view: a judge plays one at a time.
        anim={!isVideo}
        muted
        // Native rather than EdgeVideo's own bar, which has no seek control — judging a clip
        // means re-watching a moment, not just replaying it from the top.
        html5Controls
        width={600}
        // EdgeImage caps maxWidth at the requested width, which pinned a narrower image
        // to the left of its box instead of centring it.
        style={{ width: '100%', height: '100%', objectFit: 'contain', maxWidth: '100%' }}
        wrapperProps={{ className: 'flex size-full items-center justify-center' }}
        // EdgeVideo defaults a native-controls player to `preload="none"`, and a clip that never
        // loads never unlocks the vote.
        // Playback is driven here, so EdgeVideo's delayed hover-play (which a tap also triggers)
        // would start a clip the judge didn't choose.
        videoProps={{ onTimeUpdate, preload: 'auto', hoverPlay: false }}
      />

      {status === 'loading' && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Loader size="lg" />
        </div>
      )}

      {status === 'error' && (
        <div
          role="alert"
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#1a1b1e] p-4 text-center"
        >
          <IconPhotoOff size={32} className="text-gray-500" />
          <Text size="sm">This entry didn&apos;t load.</Text>
          <div className="flex gap-2">
            <Button
              size="xs"
              variant="light"
              leftSection={<IconRefresh size={14} />}
              onClick={(e: React.MouseEvent) => {
                e.stopPropagation();
                onRetry();
              }}
            >
              Retry
            </Button>
            <Button
              size="xs"
              variant="default"
              onClick={(e: React.MouseEvent) => {
                e.stopPropagation();
                onSkip();
              }}
            >
              Skip pair
            </Button>
          </div>
        </div>
      )}

      {isVideo && status === 'loaded' && (
        <ActionIcon
          className="absolute right-2 top-2 z-10 bg-black/60 hover:bg-black/80"
          size={44}
          radius="xl"
          variant="filled"
          color="dark"
          aria-label={soundOn ? 'Mute clips' : 'Unmute clips'}
          aria-pressed={soundOn}
          onClick={() => onSoundChange(!soundOn)}
        >
          {soundOn ? <IconVolume size={24} /> : <IconVolumeOff size={24} />}
        </ActionIcon>
      )}
    </div>
  );
}

/**
 * Skeleton loader for CrucibleJudgingUI
 */
export function CrucibleJudgingUISkeleton() {
  return (
    <div className="flex flex-1 flex-col gap-4 md:min-h-0">
      <div className={pairGridClass}>
        {[0, 1].map((i) => (
          <Paper key={i} className="flex min-h-0 flex-col overflow-hidden rounded-xl" bg="dark.7">
            <Skeleton radius={0} className={mediaBoxClass} />
            <div className="p-2 md:p-3">
              <Skeleton height={36} radius="md" />
            </div>
          </Paper>
        ))}
      </div>
      <Skeleton height={42} width={220} radius="md" className="mx-auto" />
    </div>
  );
}
