import { Button, ButtonProps } from '@mantine/core';
import { useDidUpdate } from '@mantine/hooks';
import { IconCheck, IconX } from '@tabler/icons';
import { createContext, useContext, useState } from 'react';
import { trpc } from '~/utils/trpc';

interface AnswerVoteContext {
  vote?: boolean;
  setVote: (value: boolean) => void;
  crossCount: number;
  checkCount: number;
}

const AnswerVoteCtx = createContext<AnswerVoteContext>({} as any);

export function AnswerVotes({
  answerId,
  ...props
}: {
  children: React.ReactNode;
  userVote?: boolean;
  crossCount?: number;
  checkCount?: number;
  answerId: number;
}) {
  const [vote, setVote] = useState(props.userVote);
  const [crossCount, setCrossCount] = useState(props.crossCount ?? 0);
  const [checkCount, setCheckCount] = useState(props.checkCount ?? 0);

  const { mutate } = trpc.answer.vote.useMutation();

  const handleSetVote = (value: boolean) => {
    console.log({ vote, value });
    if (vote !== value) {
      setVote(value);
      if (vote === undefined) {
        if (value === true) setCheckCount((c) => c + 1);
        else if (value === false) setCrossCount((c) => c + 1);
      } else {
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
      });
    }
  }, [vote]);

  return (
    <AnswerVoteCtx.Provider value={{ vote, setVote: handleSetVote, crossCount, checkCount }}>
      {props.children}
    </AnswerVoteCtx.Provider>
  );
}

function AnswerVoteCheck(props: Omit<ButtonProps, 'children'>) {
  const { vote, setVote, checkCount } = useContext(AnswerVoteCtx);
  const active = vote === true;

  const handleClick = () => setVote(true);

  return (
    <Button
      variant={active ? 'filled' : 'default'}
      leftIcon={<IconCheck size={18} />}
      onClick={!active ? handleClick : undefined}
      {...props}
    >
      {checkCount}
    </Button>
  );
}

function AnswerVoteCross(props: Omit<ButtonProps, 'children'>) {
  const { vote, setVote, crossCount } = useContext(AnswerVoteCtx);
  const active = vote === false;

  const handleClick = () => setVote(false);

  return (
    <Button
      variant={active ? 'filled' : 'default'}
      leftIcon={<IconX size={18} />}
      onClick={!active ? handleClick : undefined}
      {...props}
    >
      {crossCount}
    </Button>
  );
}

AnswerVotes.Check = AnswerVoteCheck;
AnswerVotes.Cross = AnswerVoteCross;
