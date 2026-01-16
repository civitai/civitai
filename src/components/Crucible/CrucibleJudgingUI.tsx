import { Button, Kbd, Paper, Text, Loader, Box, SimpleGrid, Skeleton, Tooltip } from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import { IconPlayerSkipForward, IconCheck } from '@tabler/icons-react';
import clsx from 'clsx';
import { useCallback, useState } from 'react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import type { RouterOutput } from '~/types/router';

/**
 * Type inferred from tRPC router output - stays in sync with backend automatically
 */
export type JudgingPairData = RouterOutput['crucible']['getJudgingPair'];

/**
 * Entry type for judging - extracted from JudgingPairData
 */
export type JudgingEntry = NonNullable<JudgingPairData>['left'];

export type CrucibleJudgingUIProps = {
  pair: JudgingPairData;
  isLoading?: boolean;
  disabled?: boolean;
  onVote: (winnerId: number, loserId: number) => void;
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
  onVote,
  onSkip,
  className,
}: CrucibleJudgingUIProps) {
  const [selectedSide, setSelectedSide] = useState<'left' | 'right' | null>(null);
  const isDisabled = disabled || isLoading || !pair;

  const handleVote = useCallback(
    (side: 'left' | 'right') => {
      if (isDisabled || !pair) return;

      setSelectedSide(side);

      // Small delay for visual feedback, then call onVote
      setTimeout(() => {
        const winnerId = side === 'left' ? pair.left.id : pair.right.id;
        const loserId = side === 'left' ? pair.right.id : pair.left.id;
        onVote(winnerId, loserId);
        setSelectedSide(null);
      }, 200);
    },
    [isDisabled, pair, onVote]
  );

  const handleSkip = useCallback(() => {
    if (isDisabled) return;
    setSelectedSide(null);
    onSkip();
  }, [isDisabled, onSkip]);

  // Keyboard shortcuts
  useHotkeys(
    isDisabled
      ? []
      : [
          ['1', () => handleVote('left')],
          ['ArrowLeft', () => handleVote('left')],
          ['2', () => handleVote('right')],
          ['ArrowRight', () => handleVote('right')],
          ['Space', handleSkip],
        ]
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
    <div className={clsx('flex flex-col gap-6', className)}>
      {/* Voting Container - Two images side by side */}
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="lg">
        {/* Left Image */}
        <ImageCard
          entry={pair?.left ?? null}
          position="left"
          isSelected={selectedSide === 'left'}
          isLoading={isLoading}
          disabled={isDisabled}
          onVote={() => handleVote('left')}
          hotkeyLabel="1"
        />

        {/* Right Image */}
        <ImageCard
          entry={pair?.right ?? null}
          position="right"
          isSelected={selectedSide === 'right'}
          isLoading={isLoading}
          disabled={isDisabled}
          onVote={() => handleVote('right')}
          hotkeyLabel="2"
        />
      </SimpleGrid>

      {/* Skip Button */}
      <Tooltip
        label="Skips this pair without voting. The pair may appear again later."
        position="top"
        withArrow
      >
        <Button
          variant="default"
          size="lg"
          fullWidth
          onClick={handleSkip}
          disabled={isDisabled}
          className="border-[#495057] bg-[#373a40] text-[#c1c2c5] hover:border-[#5c636e] hover:bg-[#495057]"
          leftSection={<IconPlayerSkipForward size={18} />}
          rightSection={
            <span className="ml-auto flex items-center gap-2">
              <Kbd>Space</Kbd>
            </span>
          }
        >
          Skip Pair
        </Button>
      </Tooltip>

      {/* Keyboard shortcut hint */}
      <Text size="xs" c="dimmed" ta="center" className="hidden md:block">
        Press <Kbd>1</Kbd> or <Kbd>←</Kbd> to vote left, <Kbd>2</Kbd> or <Kbd>→</Kbd> to vote right,{' '}
        <Kbd>Space</Kbd> to skip
      </Text>
    </div>
  );
}

type ImageCardProps = {
  entry: JudgingEntry | null;
  position: 'left' | 'right';
  isSelected: boolean;
  isLoading?: boolean;
  disabled: boolean;
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

  if (!entry) {
    return <Skeleton radius="lg" style={{ aspectRatio: '4 / 5' }} />;
  }

  return (
    <Paper
      className={clsx(
        'cursor-pointer overflow-hidden rounded-xl border-2 transition-all duration-200',
        'focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-[#1a1b1e]',
        isSelected
          ? 'border-green-500 shadow-[0_0_20px_rgba(64,192,87,0.3)]'
          : 'border-transparent hover:border-blue-500 hover:-translate-y-0.5'
      )}
      bg="dark.7"
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-label={`Vote for ${position} image`}
      aria-disabled={disabled}
      onClick={disabled ? undefined : onVote}
      onKeyDown={handleKeyDown}
    >
      {/* Image wrapper with 4:5 aspect ratio */}
      <Box className="relative bg-[#1a1b1e]" style={{ aspectRatio: '4 / 5' }}>
        {isLoading ? (
          <div className="flex h-full w-full items-center justify-center">
            <Loader size="lg" />
          </div>
        ) : (
          <EdgeMedia
            src={entry.image.url}
            type="image"
            className="h-full w-full object-contain"
            width={600}
          />
        )}

        {/* Selected indicator */}
        {isSelected && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-500">
              <IconCheck size={32} className="text-white" />
            </div>
          </div>
        )}
      </Box>

      {/* Vote button section */}
      <div className="flex items-center justify-center gap-3 p-4">
        <Button
          className={clsx(
            'flex-1 font-semibold transition-all duration-200',
            isSelected
              ? 'bg-green-600 hover:bg-green-500'
              : 'bg-blue-600 hover:bg-blue-500 hover:-translate-y-0.5'
          )}
          size="md"
          onClick={(e: React.MouseEvent) => {
            e.stopPropagation();
            if (!disabled) onVote();
          }}
          disabled={disabled}
        >
          <div className="flex flex-col items-center gap-1">
            <span>Vote</span>
            <div className="flex items-center gap-1 text-xs opacity-75">
              <Kbd size="xs">{hotkeyLabel}</Kbd>
            </div>
          </div>
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
    <div className="flex flex-col gap-6">
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="lg">
        <Paper className="overflow-hidden rounded-xl" bg="dark.7">
          <Skeleton radius={0} style={{ aspectRatio: '4 / 5' }} />
          <div className="p-4">
            <Skeleton height={42} radius="md" />
          </div>
        </Paper>
        <Paper className="overflow-hidden rounded-xl" bg="dark.7">
          <Skeleton radius={0} style={{ aspectRatio: '4 / 5' }} />
          <div className="p-4">
            <Skeleton height={42} radius="md" />
          </div>
        </Paper>
      </SimpleGrid>
      <Skeleton height={50} radius="md" />
    </div>
  );
}
