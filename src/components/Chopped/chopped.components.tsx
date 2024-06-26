import {
  ActionIcon,
  Button,
  Card,
  Container,
  Group,
  Stack,
  Title,
  Text,
  Select,
  Alert,
  Input,
  TextInput,
  NumberInput,
  ThemeIcon,
  ThemeIconProps,
  MantineColor,
  Menu,
} from '@mantine/core';
import {
  IconArrowLeft,
  IconCheck,
  IconPlus,
  IconX,
  IconPlayerPlayFilled,
  IconThumbDownFilled,
  IconThumbUpFilled,
  IconHeartFilled,
  IconBubbleFilled,
  IconMessageFilled,
  IconMessageChatbotFilled,
  IconCrown,
  IconPlayerStopFilled,
  IconMenu,
  IconMenu2,
  IconLogout,
  IconVolume,
  IconVolumeOff,
} from '@tabler/icons-react';
import React, { useState } from 'react';
import { useBuzzTransaction } from '~/components/Buzz/buzz.utils';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import {
  GameState,
  GlobalState,
  JoinGame,
  NewGame,
  Submission,
  Round,
} from '~/components/Chopped/chopped.shared-types';
import { ComputeCost, useChoppedStore, useIsHost } from '~/components/Chopped/chopped.utils';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { getRandom, shuffle } from '~/utils/array-helpers';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import { useCallback, ReactNode } from 'react';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';
import { generationPanel } from '~/store/generation.store';
import { useBase64Audio } from '~/server/utils/audio-utils';
import { PopConfirm } from '~/components/PopConfirm/PopConfirm';
import { openConfirmModal } from '@mantine/modals';
import { useChoppedServer } from '~/components/Chopped/chopped.connection';

type JudgeThinkType = 'critiquing' | 'deciding';

export function ChoppedRetryButton() {
  const isHost = useIsHost();
  const { retry } = useChoppedServer();
  return isHost ? <Button onClick={retry}>Retry</Button> : null;
}

export function ChoppedLayoutOld({
  children,
  canBack,
  title,
  canCreate,
  footer,
}: {
  children: ReactNode;
  canBack?: boolean;
  title?: ReactNode;
  canCreate?: boolean;
  footer?: React.ReactNode;
}) {
  const setGameState = useChoppedStore((state) => state.setGame);

  return (
    <main className="flex flex-col h-full w-full">
      {title && (
        <div className="bg-dark-6 p-3">
          <div className="flex gap-3 justify-between container max-w-xs">
            <div
              className={`flex flex-1 gap-3 items-center ${
                !canBack && !canCreate ? 'justify-center' : ''
              }`}
            >
              {canBack && (
                <ActionIcon onClick={() => setGameState(undefined)}>
                  <IconArrowLeft />
                </ActionIcon>
              )}
              {typeof title === 'string' ? <Title>{title}</Title> : title}
            </div>
          </div>
        </div>
      )}
      <ScrollArea className="flex flex-col justify-center items-center">
        <div className="container max-w-xs">{children}</div>
      </ScrollArea>
      {footer && (
        <div className="bg-dark-1 p-3">
          <div className="container max-w-xs">{footer}</div>
        </div>
      )}
    </main>
  );
}

export function ChoppedLayout({
  children,
  canBack,
  title,
  canCreate,
  footer,
}: {
  children: ReactNode;
  canBack?: boolean;
  title?: ReactNode;
  canCreate?: boolean;
  footer?: React.ReactNode;
}) {
  const setGameState = useChoppedStore((state) => state.setGame);
  const server = useChoppedServer();
  const autoplay = useChoppedStore((state) => state.autoplayAudio);
  const setAutoplay = useChoppedStore((state) => state.setAutoplayAudio);
  const isHost = useIsHost();

  const exitGame = () => {
    openConfirmModal({
      title: 'Are you sure?',
      children: <Text size="sm">Are you sure you want to leave this game?</Text>,
      centered: true,
      labels: { confirm: 'Leave game', cancel: 'Nevemind' },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        server.leave();
      },
    });
  };

  const toggleAutoplay = () => {
    setAutoplay(!autoplay);
  };

  return (
    <main className="flex flex-col">
      {title && (
        <div className="bg-dark-6 p-3">
          <div className="flex gap-3 justify-between container max-w-xs">
            <div
              className={`flex flex-1 gap-3 items-center ${
                !canBack && !canCreate ? 'justify-center' : ''
              }`}
            >
              {canBack && (
                <ActionIcon onClick={() => setGameState(undefined)}>
                  <IconArrowLeft />
                </ActionIcon>
              )}
              {typeof title === 'string' ? <Title>{title}</Title> : title}
              <Menu position="bottom-end">
                <Menu.Target>
                  <ActionIcon className="ml-auto">
                    <IconMenu2 />
                  </ActionIcon>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Item
                    onClick={toggleAutoplay}
                    icon={autoplay ? <IconVolume /> : <IconVolumeOff />}
                  >
                    {autoplay ? 'Disable' : 'Enable'} Audio Autoplay
                  </Menu.Item>
                  <Menu.Item color="red" icon={<IconLogout />} onClick={exitGame}>
                    Leave Game
                  </Menu.Item>
                </Menu.Dropdown>
              </Menu>
            </div>
          </div>
        </div>
      )}
      <ScrollArea className="flex flex-col justify-center items-center">
        <div className="container max-w-xs">{children}</div>
      </ScrollArea>
      {footer && (
        <div className="bg-dark-1 p-3">
          <div className="container max-w-xs">{footer}</div>
        </div>
      )}
    </main>
  );
}

export function ChoppedHeader({
  children,
  canBack,
}: {
  children: React.ReactNode;
  canBack?: boolean;
}) {
  const setGameState = useChoppedStore((state) => state.setGame);

  return (
    <Group>
      {canBack && (
        <ActionIcon onClick={() => setGameState(undefined)}>
          <IconArrowLeft />
        </ActionIcon>
      )}
      {typeof children === 'string' ? <Title>{children}</Title> : children}
    </Group>
  );
}

export function ChoppedUserSubmission({
  submission,
  decisionType,
  className,
}: {
  submission: Submission;
  decisionType?: Round['decisionType'];
  className?: string;
}) {
  const { user } = useChoppedStore(
    useCallback(
      (state) => {
        const user = state.game!.users.find((u) => u.id === submission.userId)!;
        return { user };
      },
      [submission]
    )
  );

  return (
    <div
      className={`card flex flex-col shadow-lg shadow-black rounded-md overflow-hidden ${className}`}
    >
      <div className="flex justify-center gap-3 items-center bg-gray-8 text-white font-bold uppercase px-4 py-1 relative">
        <Text size="lg">{user.name}</Text>
      </div>
      <img src={submission.image} alt={user.name} />
      {decisionType ? (
        <ChoppedJudgeDecision
          decisionType={decisionType}
          className="rounded-none rounded-tl-md absolute bottom-0 right-0 shadow-xl shadow-black aspect-square"
          size={64}
        />
      ) : submission.judgeScore ? (
        <ChoppedJudgeReaction
          score={submission.judgeScore}
          size={64}
          radius={0}
          className=" rounded-none rounded-tl-md absolute bottom-0 right-0 shadow-xl shadow-black aspect-square"
        />
      ) : null}
    </div>
  );
}

export function ChoppedJudgeReaction({
  score,
  type = 'critiquing',
  ...props
}: Omit<ThemeIconProps, 'children'> & { score: number; type?: JudgeThinkType }) {
  const iconSize = typeof props.size === 'number' ? props.size * 0.8 : 24;
  let icon: React.ReactNode, color: MantineColor;
  if (type === 'deciding') {
    icon =
      score < 5 ? (
        <IconBubbleFilled size={iconSize} />
      ) : score < 8 ? (
        <IconMessageFilled size={iconSize} />
      ) : (
        <IconMessageChatbotFilled size={iconSize} />
      );
    color = score < 5 ? 'gray' : score < 8 ? 'green' : 'gold';
  } else {
    icon =
      score < 5 ? (
        <IconThumbDownFilled size={iconSize} />
      ) : score < 8 ? (
        <IconThumbUpFilled size={iconSize} />
      ) : (
        <IconHeartFilled size={iconSize} />
      );
    color = score < 5 ? 'red' : score < 8 ? 'green' : 'gold';
  }

  return (
    <ThemeIcon color={color} {...props}>
      {icon}
    </ThemeIcon>
  );
}

export function ChoppedJudgeDecision({
  decisionType,
  ...props
}: Omit<ThemeIconProps, 'children'> & { decisionType: Round['decisionType'] }) {
  const iconSize = typeof props.size === 'number' ? props.size * 0.8 : 24;
  const { Icon, color } = decisionDict[decisionType];

  return (
    <ThemeIcon color={color} {...props}>
      <Icon size={iconSize} />
    </ThemeIcon>
  );
}

export function ChoppedJudgeComment({
  judgeId,
  indicator,
  text,
  audio,
  onContinue,
}: {
  judgeId: string;
  indicator?: React.ReactNode;
  text: string;
  audio?: string;
  onContinue?: () => Promise<void>;
}) {
  const isHost = useIsHost();
  const judge = useChoppedStore((state) => state.global!.judges.find((j) => j.id === judgeId)!);
  const autoplay = useChoppedStore((state) => state.autoplayAudio);
  const { play, stop, playing } = useBase64Audio(audio!, autoplay);

  const toggleAudio = async () => {
    if (!audio) return;
    if (playing) stop();
    else play();
  };

  const Icon = !playing ? IconPlayerPlayFilled : IconPlayerStopFilled;

  return (
    <div>
      <div className="mb-4 flex items-start">
        <div className="bg-black p-4 pl-2 pt-2 rounded-md flex gap-4 items-start">
          <div className="flex flex-col items-center gap-4">
            <div className="w-[100px] rounded-md relative overflow-hidden">
              <EdgeMedia src={judge.avatar} width={400} />
              {indicator}
            </div>
            {audio && (
              <ActionIcon color="gray" variant="filled" radius="xl" size="xl" onClick={toggleAudio}>
                <Icon />
              </ActionIcon>
            )}
          </div>
          <div className="flex-1">
            <h2 className="text-white text-md font-bold mb-1">
              {judge.name}
              <span className="opacity-60 italic font-normal ml-2 text-sm">
                {judge.shortDescription}
              </span>
            </h2>
            <p className="leading-snug">{text}</p>
          </div>
        </div>
      </div>
      {onContinue && isHost && (
        <Button size="lg" fullWidth onClick={onContinue}>
          Continue
        </Button>
      )}
    </div>
  );
}

const decisionDict = {
  elimination: { Icon: IconX, color: 'red' },
  winner: { Icon: IconCrown, color: 'gold' },
};
