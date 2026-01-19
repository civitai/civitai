import type { BadgeProps } from '@mantine/core';
import { Badge, Group, Text } from '@mantine/core';
import { IconClockHour4, IconPhoto, IconTrophy, IconSparkles } from '@tabler/icons-react';
import React from 'react';
import cardClasses from '~/components/Cards/Cards.module.css';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { abbreviateNumber } from '~/utils/number-helpers';
import { slugit } from '~/utils/string-helpers';
import { DaysFromNow } from '../Dates/DaysFromNow';
import { AspectRatioImageCard } from '~/components/CardTemplates/AspectRatioImageCard';
import { UserAvatarSimple } from '~/components/UserAvatar/UserAvatarSimple';
import clsx from 'clsx';
import { Currency, ChallengeStatus, ChallengeSource, MediaType } from '~/shared/utils/prisma/enums';
import type { ChallengeListItem } from '~/server/schema/challenge.schema';

const sharedBadgeProps: Omit<BadgeProps, 'children'> = {
  radius: 'xl',
  variant: 'filled',
  px: 8,
  h: 26,
  tt: 'capitalize',
  fw: 'bold',
};

export function ChallengeCard({ data }: Props) {
  const {
    id,
    title,
    theme,
    coverUrl,
    startsAt,
    endsAt,
    status,
    source,
    prizePool,
    entryCount,
    modelName,
    createdBy,
  } = data;

  const now = new Date();
  const isActive = status === ChallengeStatus.Active;
  const isCompleted = status === ChallengeStatus.Completed;
  const isScheduled = status === ChallengeStatus.Scheduled;
  const hasEnded = endsAt < now;

  // Create a simple image object for AspectRatioImageCard
  const image = coverUrl
    ? {
        id: id,
        url: coverUrl,
        type: MediaType.image,
        width: 512,
        height: 512,
        nsfwLevel: 1,
        metadata: null,
      }
    : undefined;

  // Status badges
  const activeBadge = (
    <Badge
      className={cardClasses.chip}
      {...sharedBadgeProps}
      color="green"
      variant="filled"
      radius="xl"
    >
      <Group gap={4}>
        <IconSparkles size={12} />
        <Text size="xs" fw="bold">
          Live
        </Text>
      </Group>
    </Badge>
  );

  const countdownBadge = (
    <IconBadge
      {...sharedBadgeProps}
      color="dark"
      icon={<IconClockHour4 size={14} />}
      style={{
        backgroundColor: 'rgba(0, 0, 0, 0.31)',
      }}
    >
      <Text fw="bold" size="xs">
        <DaysFromNow date={isActive ? endsAt : startsAt} withoutSuffix />
      </Text>
    </IconBadge>
  );

  const completedBadge = (
    <Badge
      className={cardClasses.chip}
      {...sharedBadgeProps}
      color="yellow.7"
      variant="filled"
      radius="xl"
    >
      <Group gap={4}>
        <IconTrophy size={12} />
        <Text size="xs" fw="bold">
          Complete
        </Text>
      </Group>
    </Badge>
  );

  const scheduledBadge = (
    <Badge
      className={cardClasses.chip}
      {...sharedBadgeProps}
      color="blue"
      variant="filled"
      radius="xl"
    >
      Upcoming
    </Badge>
  );

  // Source badge (System, Mod, User)
  const sourceBadge = source !== ChallengeSource.System && (
    <Badge
      className={clsx(cardClasses.infoChip, cardClasses.chip)}
      variant="light"
      radius="xl"
      color={source === ChallengeSource.User ? 'grape' : 'cyan'}
    >
      <Text size="xs" tt="capitalize" fw="bold">
        {source === ChallengeSource.User ? 'Community' : 'Staff'}
      </Text>
    </Badge>
  );

  // Status badge logic
  const statusBadge = isCompleted
    ? completedBadge
    : isActive
    ? activeBadge
    : isScheduled
    ? scheduledBadge
    : hasEnded
    ? completedBadge
    : countdownBadge;

  return (
    <AspectRatioImageCard
      href={`/challenges/${id}/${slugit(title)}`}
      aspectRatio="square"
      image={image}
      header={
        <div className="flex w-full justify-between">
          <div className="flex gap-1">
            {sourceBadge}
            {statusBadge}
            {isActive && countdownBadge}
          </div>
        </div>
      }
      footerGradient
      footer={
        <div className="flex w-full flex-col gap-2">
          <UserAvatarSimple id={createdBy.id} username={createdBy.username} />
          <div className="flex flex-col gap-1">
            {theme && (
              <Text size="sm" c="dimmed" lineClamp={1}>
                Theme: {theme}
              </Text>
            )}
            <Text size="xl" fw={700} lineClamp={2} lh={1.2}>
              {title}
            </Text>
          </div>
          <div className="flex items-center justify-between gap-2">
            {/* Prize pool */}
            <CurrencyBadge
              currency={Currency.BUZZ}
              unitAmount={prizePool}
              radius="xl"
              px={8}
              variant="filled"
              className={cardClasses.chip}
              style={{
                backgroundColor: 'rgba(0, 0, 0, 0.31)',
              }}
            />
            {/* Stats */}
            <Badge
              className={cardClasses.chip}
              style={{
                backgroundColor: 'rgba(0, 0, 0, 0.31)',
              }}
              radius="xl"
              px={8}
              variant="filled"
            >
              <div className="flex items-center gap-2">
                <IconBadge
                  icon={<IconPhoto size={14} />}
                  color="gray.0"
                  p={0}
                  size="lg"
                  variant="transparent"
                >
                  <Text fw="bold" size="xs">
                    {abbreviateNumber(entryCount)}
                  </Text>
                </IconBadge>
                {modelName && (
                  <Text size="xs" c="dimmed" lineClamp={1} maw={80}>
                    {modelName}
                  </Text>
                )}
              </div>
            </Badge>
          </div>
        </div>
      }
    />
  );
}

type Props = { data: ChallengeListItem };
