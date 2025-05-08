import { clsx, MantineSize, Paper, PaperProps, ThemeIcon, Tooltip } from '@mantine/core';
import { IconFlame, IconHeart, IconMoneybag, IconSword } from '@tabler/icons-react';
import React from 'react';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { LevelProgress } from '~/components/Games/LevelProgress/LevelProgress';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { newOrderConfig } from '~/server/common/constants';
import { SimpleUser } from '~/server/selectors/user.selector';
import { getLevelProgression } from '~/server/utils/game-helpers';
import { Currency, NewOrderRankType } from '~/shared/utils/prisma/enums';
import { GetPlayer } from '~/types/router';
import { abbreviateNumber, numberWithCommas } from '~/utils/number-helpers';

const MAX_SMITE_COUNT = 3;

const ranksExplanation: Record<NewOrderRankType, React.ReactElement> = {
  [NewOrderRankType.Acolyte]: (
    <>
      <p>You are currently an Acolyte and have not yet joined the Knights of New Order.</p>
      <p>Keep leveling up to reach Knight rank and unlock all game features.</p>
    </>
  ),
  [NewOrderRankType.Knight]: (
    <>
      <p>You are a Knight of New Order and have access to all game features.</p>
      <p>Keep rating images and leveling up to earn gold and fervor to become a Templar.</p>
    </>
  ),
  [NewOrderRankType.Templar]: (
    <>
      <p>You are a Templar of New Order and have access to all game features.</p>
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
  blessedBuzz,
  smites = 0,
  leaderboard,
  showStats,
  className,
  ...paperProps
}: Props) {
  const progression = getLevelProgression(exp);
  const rankExplanation = ranksExplanation[rank.type];

  const remainingSmites = MAX_SMITE_COUNT - smites;

  return (
    <Paper className={clsx('flex items-center gap-4 py-2 md:p-4', className)} {...paperProps}>
      <div className="flex w-full flex-col gap-2">
        <div className="flex justify-between gap-2">
          <div className="flex items-center gap-2">
            <UserAvatar user={user} size="md" radius={999} />
            {rank.iconUrl && (
              <EdgeMedia2 src={rank.iconUrl} className="size-6" type="image" width={32} />
            )}
            <p className="text-lg font-medium">{rank.name}</p>
            {rankExplanation && !user.isModerator && (
              <InfoPopover iconProps={{ size: 20 }} withinPortal>
                {rankExplanation}
              </InfoPopover>
            )}
          </div>

          {smites < MAX_SMITE_COUNT && (
            <Tooltip
              label={`Receive ${remainingSmites} more ${
                remainingSmites === 1 ? 'smite' : 'smites'
              } and it's game over!`}
              withinPortal
            >
              <div className="flex flex-nowrap items-center">
                {Array.from({ length: MAX_SMITE_COUNT - smites }).map((_, index) => (
                  <ThemeIcon
                    key={index}
                    size="sm"
                    color="red"
                    className="text-red-500"
                    // @ts-ignore: this works
                    variant="transparent"
                  >
                    <IconHeart size={16} stroke={1.5} fill="currentColor" />
                  </ThemeIcon>
                ))}
              </div>
            </Tooltip>
          )}
        </div>
        <LevelProgress
          className="w-full"
          level={progression.level}
          progress={progression.progressPercent}
          currentExp={progression.xpIntoLevel}
          nextLevelExp={progression.xpForNextLevel}
          total={exp}
          icon={<IconSword size={18} stroke={1.5} />}
        />
        {showStats && <PlayerStats stats={{ fervor, blessedBuzz, smites }} />}
      </div>
    </Paper>
  );
}

type Props = PaperProps &
  GetPlayer['stats'] & {
    user: Omit<Partial<SimpleUser & { isModerator: boolean }>, 'profilePicture' | 'deletedAt'>;
    rank: GetPlayer['rank'];
    showStats?: boolean;
    leaderboard?: number;
    onClick?: VoidFunction;
  };

const iconSizes = {
  xs: 16,
  sm: 16,
  md: 16,
  lg: 18,
  xl: 20,
};

export function PlayerStats({
  stats,
  size = 'lg',
  showSmiteCount,
}: {
  stats: Omit<GetPlayer['stats'], 'exp'>;
  size?: MantineSize;
  showSmiteCount?: boolean;
}) {
  const iconSize = iconSizes[size] || iconSizes.lg;
  const totalBuzz = Math.floor(stats.blessedBuzz * newOrderConfig.blessedBuzzConversionRatio);

  return (
    <div className="flex items-center gap-1">
      <IconBadge
        tooltip={`Total Gold: ${numberWithCommas(stats.blessedBuzz)}`}
        size={size}
        color="yellow"
        icon={<IconMoneybag size={iconSize} stroke={1.5} />}
      >
        {abbreviateNumber(stats.blessedBuzz)}
      </IconBadge>
      <IconBadge
        tooltip={`Total Buzz: ${numberWithCommas(totalBuzz)}`}
        size={size}
        color="yellow.7"
        icon={<CurrencyIcon type={Currency.BUZZ} size={iconSize} stroke={1.5} />}
      >
        {abbreviateNumber(totalBuzz)}
      </IconBadge>
      <IconBadge
        tooltip={`Total Fervor: ${numberWithCommas(stats.fervor)}`}
        size={size}
        color="orange"
        icon={<IconFlame size={iconSize} fill="currentColor" />}
      >
        {abbreviateNumber(stats.fervor)}
      </IconBadge>
      {showSmiteCount && (
        <IconBadge
          tooltip="Health"
          size={size}
          color="red"
          icon={<IconHeart size={iconSize} fill="currentColor" />}
        >
          {MAX_SMITE_COUNT - stats.smites}
        </IconBadge>
      )}
    </div>
  );
}
