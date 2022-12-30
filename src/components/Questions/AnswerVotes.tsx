import { Badge, Center, BadgeProps, ButtonProps } from '@mantine/core';
import { useDidUpdate } from '@mantine/hooks';
import { IconCheck, IconX } from '@tabler/icons';
import { createContext, useContext, useState } from 'react';
import { ReactionBadge } from '~/components/Questions/ReactionBadge';
import { trpc } from '~/utils/trpc';

interface AnswerVoteContext {
  disabled?: boolean;
  vote?: boolean | null;
  setCheck: (value: boolean | null) => void;
  setCross: (value: boolean | null) => void;
  crossCount: number;
  checkCount: number;
}

const AnswerVoteCtx = createContext<AnswerVoteContext>({} as any);

export function AnswerVotes({
  answerId,
  disabled,
  userVote,
  questionId,
  questionOwnerId,
  ...props
}: {
  children: React.ReactNode;
  userVote?: boolean | null;
  crossCount?: number;
  checkCount?: number;
  answerId: number;
  disabled?: boolean;
  questionId: number;
  questionOwnerId: number;
}) {
  const [vote, setVote] = useState<boolean | undefined | null>(userVote);
  const [crossCount, setCrossCount] = useState(
    vote === false && !props.crossCount ? 1 : props.crossCount ?? 0
  );
  const [checkCount, setCheckCount] = useState(
    vote === true && !props.checkCount ? 1 : props.checkCount ?? 0
  );

  const { mutate } = trpc.answer.vote.useMutation();

  const handleCheckClick = (value: boolean | null) => {
    if (vote !== value) {
      setVote(value);
      if (vote === undefined || vote === null) {
        // user hasn't voted, add vote
        setCheckCount((c) => c + 1);
      } else if (value === null) {
        // user has voted, remove vote
        setCheckCount((c) => c - 1);
      } else {
        setCrossCount((c) => (value ? c - 1 : c + 1));
        setCheckCount((c) => (value ? c + 1 : c - 1));
      }
    }
  };

  const handleCrossClick = (value: boolean | null) => {
    if (vote !== value) {
      setVote(value);
      if (vote === undefined || vote === null) {
        // user hasn't voted, add vote
        setCrossCount((c) => c + 1);
      } else if (value === null) {
        // user has voted, remove vote
        setCrossCount((c) => c - 1);
      } else {
        // user has voted, change vote
        setCrossCount((c) => (value ? c - 1 : c + 1));
        setCheckCount((c) => (value ? c + 1 : c - 1));
      }
    }
  };

  useDidUpdate(() => {
    if (vote !== undefined) {
      mutate({
        id: answerId,
        vote,
        questionId,
        questionOwnerId,
      });
    }
  }, [vote]);

  return (
    <AnswerVoteCtx.Provider
      value={{
        vote,
        setCheck: handleCheckClick,
        setCross: handleCrossClick,
        crossCount,
        checkCount,
        disabled,
      }}
    >
      {props.children}
    </AnswerVoteCtx.Provider>
  );
}

type VoteButtonProps = Omit<ButtonProps, 'children'>;
function AnswerVoteCheck(props: VoteButtonProps) {
  const { vote, setCheck, checkCount, disabled } = useContext(AnswerVoteCtx);
  const active = vote === true;

  const handleClick = () => setCheck(!active ? true : null);

  return (
    <ReactionBadge
      color={active ? 'green' : undefined}
      leftIcon={<IconCheck size={18} />}
      onClick={!disabled ? handleClick : undefined}
      {...props}
    >
      {checkCount}
    </ReactionBadge>
  );
}

function AnswerVoteCross(props: VoteButtonProps) {
  const { vote, setCross, crossCount, disabled } = useContext(AnswerVoteCtx);
  const active = vote === false;

  const handleClick = () => setCross(!active ? false : null);

  return (
    <ReactionBadge
      color={active ? 'red' : undefined}
      leftIcon={<IconX size={18} />}
      onClick={!disabled ? handleClick : undefined}
      {...props}
    >
      {crossCount}
    </ReactionBadge>
  );
}

AnswerVotes.Check = AnswerVoteCheck;
AnswerVotes.Cross = AnswerVoteCross;
