import { clsx, Paper, PaperProps, ThemeIcon, Tooltip } from '@mantine/core';
import { IconCoin, IconCrown, IconFlame, IconSkull, IconSword } from '@tabler/icons-react';
import React from 'react';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { LevelProgress } from '~/components/Games/LevelProgress/LevelProgress';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { SimpleUser } from '~/server/selectors/user.selector';
import { calculateLevelProgression } from '~/server/utils/research-utils';
import { Currency, NewOrderRankType } from '~/shared/utils/prisma/enums';
import { abbreviateNumber, numberWithCommas } from '~/utils/number-helpers';

const MAX_SMITE_COUNT = 3;

const ranksExplanation: Record<NewOrderRankType, React.ReactElement> = {
  [NewOrderRankType.Acolyte]: (
    <>
      <p className="text-sm font-medium">
        You are currently an Acolyte and have not yet joined the Knights of New Order.
      </p>
      <p>Keep leveling up to reach Knight rank and unlock all game features.</p>
    </>
  ),
  [NewOrderRankType.Knight]: (
    <>
      <p className="text-sm font-medium">
        You are a Knight of New Order and have access to all game features.
      </p>
      <p>Keep rating images and leveling up to earn blessed buzz and fervor to become a Templar.</p>
    </>
  ),
  [NewOrderRankType.Templar]: (
    <>
      <p className="text-sm font-medium">
        You are a Templar of New Order and have access to all game features.
      </p>
      <p>
        You&apos;ve reached the highest rank in the game and can now see a special queue of images
        to rate.
      </p>
    </>
  ),
};

export function PlayerCard({
  user,
  rank,
  exp,
  fervor,
  gold,
  smiteCount = 0,
  leaderboard,
  showStats,
  className,
  ...paperProps
}: Props) {
  // TODO.newOrder: update this to calculate level progression based on the new order game
  const progression = calculateLevelProgression(exp);
  const rankExplanation = ranksExplanation[rank.type];

  return (
    <Paper className={clsx('flex items-center gap-4', className)} {...paperProps}>
      <UserAvatar user={user} size="xl" radius={999} />
      <div className="flex w-full flex-col gap-2">
        <div className="flex justify-between gap-2">
          <div className="flex items-center gap-1">
            {rank.iconUrl && (
              <EdgeMedia2 src={rank.iconUrl} className="size-8" type="image" width={32} />
            )}
            <p className="text-lg font-medium">{rank.name}</p>
            {rankExplanation && !user.isModerator && (
              <InfoPopover iconProps={{ size: 20 }} withinPortal>
                {rankExplanation}
              </InfoPopover>
            )}
          </div>

          {smiteCount ? (
            <Tooltip
              label={`Receive ${MAX_SMITE_COUNT - smiteCount} more smite and it's game over!`}
            >
              <div className="flex flex-nowrap items-center gap-1">
                {Array.from({ length: smiteCount }).map((_, index) => (
                  <ThemeIcon key={index} size="sm" color="red" variant="light">
                    <IconSkull size={16} stroke={1.5} />
                  </ThemeIcon>
                ))}
              </div>
            </Tooltip>
          ) : null}
        </div>
        <LevelProgress
          className="w-full"
          level={progression.level}
          progress={progression.progress}
          currentExp={exp}
          nextLevelExp={progression.ratingsForNextLevel}
          icon={<IconSword size={18} stroke={1.5} />}
        />
        {!showStats && (
          <div className="flex items-center gap-1">
            <IconBadge
              tooltip={`Total Gold: ${numberWithCommas(gold)}`}
              size="lg"
              color="yellow"
              icon={<IconCoin size={18} stroke={1.5} />}
            >
              {abbreviateNumber(gold)}
            </IconBadge>
            {/* TODO.newOrder: get actual conversion rate */}
            <IconBadge
              tooltip={`Total Buzz: ${numberWithCommas(gold / 1000)}`}
              size="lg"
              color="yellow.7"
              icon={<CurrencyIcon type={Currency.BUZZ} size={18} stroke={1.5} />}
            >
              {abbreviateNumber(gold / 1000)}
            </IconBadge>
            <IconBadge
              tooltip={`Total Fervor: ${numberWithCommas(fervor)}`}
              size="lg"
              color="orange"
              icon={<IconFlame size={18} stroke={1.5} />}
            >
              {abbreviateNumber(fervor)}
            </IconBadge>
            {leaderboard && (
              <IconBadge
                tooltip="Leaderboard Position"
                size="lg"
                color="blue"
                icon={<IconCrown size={18} stroke={1.5} />}
              >
                #{leaderboard}
              </IconBadge>
            )}
          </div>
        )}
      </div>
    </Paper>
  );
}

type Props = PaperProps & {
  user: Omit<Partial<SimpleUser & { isModerator: boolean }>, 'profilePicture' | 'deletedAt'>;
  rank: { type: NewOrderRankType; name: string; iconUrl?: string };
  exp: number;
  fervor: number;
  gold: number;
  smiteCount?: number;
  showStats?: boolean;
  leaderboard?: number;
  onClick?: VoidFunction;
};
