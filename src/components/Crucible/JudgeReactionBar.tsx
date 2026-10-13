import { Tooltip } from '@mantine/core';
import clsx from 'clsx';
import { ReactionButton } from '~/components/Reaction/ReactionButton';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { constants } from '~/server/common/constants';
import type { ReviewReactions } from '~/shared/utils/prisma/enums';

const JUDGE_REACTIONS: ReviewReactions[] = ['Like', 'Heart', 'Laugh', 'Cry'];

export type JudgeReactionBarProps = {
  imageId: number;
  reactions: { userId: number; reaction: ReviewReactions }[];
  side: string;
  /** Until the viewer's own reactions are known a click could delete one, so the bar is read-only. */
  reactionsLoaded: boolean;
  className?: string;
};

export function JudgeReactionBar({
  imageId,
  reactions,
  side,
  reactionsLoaded,
  className,
}: JudgeReactionBarProps) {
  const currentUser = useCurrentUser();

  return (
    <div
      data-testid="judge-reactions"
      data-side={side}
      className={clsx(
        'flex items-center rounded-[18px] border border-solid border-white/[0.12] bg-[#101113CC] p-[3px]',
        className
      )}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {JUDGE_REACTIONS.map((reaction) => (
        <ReactionButton
          key={reaction}
          entityType="image"
          entityId={imageId}
          reaction={reaction}
          userReaction={reactions.find(
            (x) => x.userId === currentUser?.id && x.reaction === reaction
          )}
          readonly={!currentUser || currentUser.muted || !reactionsLoaded}
        >
          {(props) => <JudgeReactionPill {...props} />}
        </ReactionButton>
      ))}
    </div>
  );
}

function JudgeReactionPill({
  hasReacted,
  reaction,
  canClick,
  count: _count,
  countUnknown: _countUnknown,
  className,
  ...buttonProps
}: {
  hasReacted: boolean;
  reaction: ReviewReactions;
  canClick: boolean;
  count: number;
  countUnknown: boolean;
} & React.ComponentPropsWithoutRef<'button'>) {
  return (
    <Tooltip label={reaction} withinPortal position="top" openDelay={150}>
      <button
        {...buttonProps}
        type="button"
        aria-label={`${reaction} reaction`}
        aria-pressed={hasReacted}
        disabled={!canClick}
        className={clsx(
          'flex h-7 w-8 items-center justify-center rounded-[14px] text-[15px] leading-none',
          'border-0 bg-transparent p-0 transition-colors hover:bg-white/10',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-white',
          'aria-pressed:bg-[#1971C240] aria-pressed:ring-1 aria-pressed:ring-inset aria-pressed:ring-[#228BE6]',
          canClick ? 'cursor-pointer' : 'cursor-default',
          className
        )}
      >
        {constants.availableReactions[reaction]}
      </button>
    </Tooltip>
  );
}
