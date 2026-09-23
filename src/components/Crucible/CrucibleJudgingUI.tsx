import { Button, Kbd, Paper, Text, Loader, Box, Skeleton, Tooltip } from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import { IconPlayerSkipForward, IconCheck } from '@tabler/icons-react';
import clsx from 'clsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import type { RouterOutput } from '~/types/router';
import { MediaType } from '~/shared/utils/prisma/enums';
import { accumulatePlaybackMs } from '~/shared/constants/crucible.constants';

/**
 * Type inferred from tRPC router output - stays in sync with backend automatically
 */
export type JudgingPairData = RouterOutput['crucible']['getJudgingPair'];

/**
 * Entry type for judging - extracted from JudgingPairData
 */
export type JudgingEntry = NonNullable<JudgingPairData>['left'];

export type WatchedMs = { winnerWatchedMs: number; loserWatchedMs: number };

export type CrucibleJudgingUIProps = {
  pair: JudgingPairData;
  isLoading?: boolean;
  disabled?: boolean;
  /** Playback each clip needs before either vote unlocks. Null or absent means no rule. */
  minViewSeconds?: number | null;
  onVote: (winnerId: number, loserId: number, watched: WatchedMs) => void;
  onSkip: () => void;
  className?: string;
};

/**
 * CrucibleJudgingUI - Side-by-side interface for voting on entry pairs
 *
 * Features:
 * - Two images side by side with 4:5 aspect ratio
 * - Vote buttons under each image
 * - Skip button for undecided
 * - Keyboard shortcuts: 1 for left, 2 for right, Space for skip
 * - Loading state while fetching next pair
 * - Visual feedback when vote is selected
 */
export function CrucibleJudgingUI({
  pair,
  isLoading,
  disabled,
  minViewSeconds,
  onVote,
  onSkip,
  className,
}: CrucibleJudgingUIProps) {
  const [selectedSide, setSelectedSide] = useState<'left' | 'right' | null>(null);
  const [watchedMs, setWatchedMs] = useState<{ left: number; right: number }>(emptyWatched);
  const isDisabled = disabled || isLoading || !pair;

  const pairKey = pair ? `${pair.left.id}:${pair.right.id}` : null;
  useEffect(() => {
    setWatchedMs(emptyWatched);
  }, [pairKey]);

  const requiredMs = (minViewSeconds ?? 0) * 1000;
  const remainingMs = requiredMs
    ? Math.max(0, requiredMs - watchedMs.left) + Math.max(0, requiredMs - watchedMs.right)
    : 0;
  const watchGateOpen = remainingMs === 0;

  const handleWatched = useCallback((side: 'left' | 'right', ms: number) => {
    setWatchedMs((prev) => (ms > prev[side] ? { ...prev, [side]: ms } : prev));
  }, []);

  const handleVote = useCallback(
    (side: 'left' | 'right') => {
      if (isDisabled || !pair || !watchGateOpen) return;

      setSelectedSide(side);

      // Small delay for visual feedback, then call onVote
      setTimeout(() => {
        const winnerId = side === 'left' ? pair.left.id : pair.right.id;
        const loserId = side === 'left' ? pair.right.id : pair.left.id;
        onVote(winnerId, loserId, {
          winnerWatchedMs: side === 'left' ? watchedMs.left : watchedMs.right,
          loserWatchedMs: side === 'left' ? watchedMs.right : watchedMs.left,
        });
        setSelectedSide(null);
      }, 200);
    },
    [isDisabled, pair, onVote, watchGateOpen, watchedMs]
  );

  const handleSkip = useCallback(() => {
    if (isDisabled) return;
    setSelectedSide(null);
    onSkip();
  }, [isDisabled, onSkip]);

  // Keyboard shortcuts
  useHotkeys(
    isDisabled || !watchGateOpen
      ? [
          // Skip stays live while the gate is closed: a judge who does not want to watch either
          // clip through needs a way past the pair.
          ['Space', handleSkip],
        ]
      : [
          ['1', () => handleVote('left')],
          ['ArrowLeft', () => handleVote('left')],
          ['2', () => handleVote('right')],
          ['ArrowRight', () => handleVote('right')],
          ['Space', handleSkip],
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
      {/* On md+ the pair fills the height left over, so the vote buttons never need a scroll. */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 md:grid-cols-2">
        {/* Left Image */}
        <ImageCard
          entry={pair?.left ?? null}
          position="left"
          isSelected={selectedSide === 'left'}
          isLoading={isLoading}
          disabled={isDisabled || !watchGateOpen}
          pairKey={pairKey}
          watchedMs={watchedMs.left}
          requiredMs={requiredMs}
          onWatched={(ms) => handleWatched('left', ms)}
          onVote={() => handleVote('left')}
          hotkeyLabel="1"
        />

        {/* Right Image */}
        <ImageCard
          entry={pair?.right ?? null}
          position="right"
          isSelected={selectedSide === 'right'}
          isLoading={isLoading}
          disabled={isDisabled || !watchGateOpen}
          pairKey={pairKey}
          watchedMs={watchedMs.right}
          requiredMs={requiredMs}
          onWatched={(ms) => handleWatched('right', ms)}
          onVote={() => handleVote('right')}
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
  position: 'left' | 'right';
  isSelected: boolean;
  isLoading?: boolean;
  disabled: boolean;
  pairKey: string | null;
  watchedMs: number;
  requiredMs: number;
  onWatched: (ms: number) => void;
  onVote: () => void;
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
  onWatched,
  onVote,
  hotkeyLabel,
}: ImageCardProps) {
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
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
    const currentTime = e.currentTarget.currentTime;
    watchedRef.current = accumulatePlaybackMs({
      watchedMs: watchedRef.current,
      previousTime: lastTimeRef.current,
      currentTime,
    });
    lastTimeRef.current = currentTime;
    onWatched(watchedRef.current);
  };

  const remainingSeconds = Math.ceil(Math.max(0, requiredMs - watchedMs) / 1000);

  if (!entry) {
    return <Skeleton radius="lg" className="aspect-[4/5] md:aspect-auto md:h-full" />;
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
        className="relative aspect-[4/5] bg-[#1a1b1e] md:aspect-auto md:min-h-0 md:flex-1"
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
          <EdgeMedia
            src={entry.image.url}
            type={entry.image.type}
            // Forces playback past the viewer's autoplay setting — a judge comparing two
            // clips must not have to start each one by hand.
            anim
            // Stated rather than inherited from EdgeVideo's default: two clips autoplaying
            // audio at a judge is the failure mode, and nothing else here would say so.
            muted
            // Native rather than EdgeVideo's own bar, which has no seek control — judging a clip
            // means re-watching a moment, not just replaying it from the top.
            html5Controls
            width={600}
            // EdgeImage caps maxWidth at the requested width, which pinned a narrower image
            // to the left of its box instead of centring it.
            style={{ width: '100%', height: '100%', objectFit: 'contain', maxWidth: '100%' }}
            wrapperProps={{ className: 'flex size-full items-center justify-center' }}
            videoProps={{ onTimeUpdate: handleTimeUpdate }}
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
      <div className="flex shrink-0 items-center justify-center gap-3 p-3">
        <Button
          className={clsx(
            'flex-1 font-semibold transition-all duration-200',
            isSelected
              ? 'bg-green-600 hover:bg-green-500'
              : 'bg-blue-600 hover:-translate-y-0.5 hover:bg-blue-500'
          )}
          size="md"
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

/**
 * Skeleton loader for CrucibleJudgingUI
 */
export function CrucibleJudgingUISkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 md:grid-cols-2">
        {[0, 1].map((i) => (
          <Paper key={i} className="flex min-h-0 flex-col overflow-hidden rounded-xl" bg="dark.7">
            <Skeleton radius={0} className="aspect-[4/5] md:aspect-auto md:min-h-0 md:flex-1" />
            <div className="p-3">
              <Skeleton height={36} radius="md" />
            </div>
          </Paper>
        ))}
      </div>
      <Skeleton height={42} width={220} radius="md" className="mx-auto" />
    </div>
  );
}
