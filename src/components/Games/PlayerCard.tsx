import type { MantineSize, PaperProps } from '@mantine/core';
import { Paper, Stack, Text, ThemeIcon, Tooltip } from '@mantine/core';
import { IconFlame, IconHeart, IconMoneybag, IconSword } from '@tabler/icons-react';
import dayjs from 'dayjs';
import React from 'react';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { LevelProgress } from '~/components/Games/LevelProgress/LevelProgress';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { newOrderConfig } from '~/server/common/constants';
import type { SimpleUser } from '~/server/selectors/user.selector';
import { getLevelProgression } from '~/server/utils/game-helpers';
import { Currency, NewOrderRankType } from '~/shared/utils/prisma/enums';
import type { GetPlayer } from '~/types/router';
import { abbreviateNumber, numberWithCommas } from '~/utils/number-helpers';
import clsx from 'clsx';

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
  pendingBlessedBuzz,
  nextGrantDate,
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
        {showStats && (
          <PlayerStats stats={{ fervor, blessedBuzz, smites, pendingBlessedBuzz, nextGrantDate }} />
        )}
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
  const totalAccumulatedBuzz = Math.floor(
    stats.blessedBuzz * newOrderConfig.blessedBuzzConversionRatio
  );
  const pendingBuzzAmount = Math.floor(
    (stats.pendingBlessedBuzz ?? 0) * newOrderConfig.blessedBuzzConversionRatio
  );
  const futureGrantsBuzz = totalAccumulatedBuzz - pendingBuzzAmount;

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
        tooltip={
          <Stack gap={4}>
            <Text size="sm" fw={500}>
              Yellow Buzz Breakdown
            </Text>
            <Stack gap={2}>
              {pendingBuzzAmount > 0 && (
                <Text size="xs">
                  Next Grant: <strong>{numberWithCommas(pendingBuzzAmount)}</strong> (
                  {stats.nextGrantDate
                    ? dayjs(stats.nextGrantDate).format('MMM D, HH:mm')
                    : 'next cycle'}{' '}
                  UTC)
                </Text>
              )}
              {futureGrantsBuzz > 0 && (
                <Text size="xs">
                  Future Grants: <strong>{numberWithCommas(futureGrantsBuzz)}</strong> (after 3-day
                  waiting period, subject to change based on vote accuracy)
                </Text>
              )}
              <Text
                size="xs"
                c="dimmed"
                style={{ borderTop: '1px solid var(--mantine-color-dark-4)', paddingTop: '4px' }}
              >
                Total Accumulated: <strong>{numberWithCommas(totalAccumulatedBuzz)}</strong>
              </Text>
              <Text size="xs" c="dimmed" fs="italic">
                Buzz is granted after judgments age 3 days
              </Text>
            </Stack>
          </Stack>
        }
        size={size}
        color="yellow.7"
        icon={<CurrencyIcon currency={Currency.BUZZ} type="yellow" size={iconSize} stroke={1.5} />}
      >
        {abbreviateNumber(totalAccumulatedBuzz)}
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
