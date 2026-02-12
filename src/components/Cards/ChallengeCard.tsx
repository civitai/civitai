import type { BadgeProps } from '@mantine/core';
import { Badge, Group, Text } from '@mantine/core';
import {
  IconClockHour4,
  IconMessageCircle2,
  IconPhoto,
  IconTrophy,
  IconSparkles,
} from '@tabler/icons-react';
import cardClasses from '~/components/Cards/Cards.module.css';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { abbreviateNumber } from '~/utils/number-helpers';
import { slugit } from '~/utils/string-helpers';
import { DaysFromNow } from '../Dates/DaysFromNow';
import { AspectRatioImageCard } from '~/components/CardTemplates/AspectRatioImageCard';
import { UserAvatarSimple } from '~/components/UserAvatar/UserAvatarSimple';
import clsx from 'clsx';
import { Currency, ChallengeStatus, ChallengeSource } from '~/shared/utils/prisma/enums';
import type { ChallengeListItem } from '~/server/schema/challenge.schema';

const sharedBadgeProps: Omit<BadgeProps, 'children'> = {
  radius: 'xl',
  variant: 'filled',
  px: 8,
  h: 26,
  tt: 'capitalize',
  fw: 'bold',
};

const darkBgStyle = { backgroundColor: 'rgba(0, 0, 0, 0.31)' } as const;

function StatusBadge({ status, startsAt, endsAt }: StatusBadgeProps) {
  switch (status) {
    case ChallengeStatus.Completed:
      return (
        <Badge className={cardClasses.chip} {...sharedBadgeProps} color="yellow.7">
          <Group gap={4}>
            <IconTrophy size={12} />
            <Text size="xs" fw="bold">
              Complete
            </Text>
          </Group>
        </Badge>
      );
    case ChallengeStatus.Active:
      return (
        <Badge className={cardClasses.chip} {...sharedBadgeProps} color="green">
          <Group gap={4}>
            <IconSparkles size={12} />
            <Text size="xs" fw="bold">
              Live
            </Text>
          </Group>
        </Badge>
      );
    case ChallengeStatus.Scheduled:
      return (
        <Badge className={cardClasses.chip} {...sharedBadgeProps} color="blue">
          Upcoming
        </Badge>
      );
    default:
      return (
        <IconBadge
          {...sharedBadgeProps}
          color="dark"
          icon={<IconClockHour4 size={14} />}
          style={darkBgStyle}
        >
          <Text fw="bold" size="xs">
            <DaysFromNow date={endsAt < new Date() ? endsAt : startsAt} withoutSuffix />
          </Text>
        </IconBadge>
      );
  }
}

export function ChallengeCard({ data }: Props) {
  const {
    id,
    title,
    theme,
    coverImage,
    startsAt,
    endsAt,
    status,
    source,
    prizePool,
    entryCount,
    commentCount,
    createdBy,
  } = data;

  const isActive = status === ChallengeStatus.Active;

  const image = coverImage
    ? {
        id: coverImage.id,
        url: coverImage.url,
        type: coverImage.type,
        width: coverImage.width ?? 512,
        height: coverImage.height ?? 512,
        nsfwLevel: coverImage.nsfwLevel,
        hash: coverImage.hash,
        metadata: null,
      }
    : undefined;

  return (
    <AspectRatioImageCard
      href={`/challenges/${id}/${slugit(title)}`}
      aspectRatio="square"
      image={image}
      header={
        <div className="flex w-full justify-between">
          <div className="flex gap-1">
            {source !== ChallengeSource.System && (
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
            )}
            <StatusBadge status={status} startsAt={startsAt} endsAt={endsAt} />
            {isActive && (
              <IconBadge
                {...sharedBadgeProps}
                color="dark"
                icon={<IconClockHour4 size={14} />}
                style={darkBgStyle}
              >
                <Text fw="bold" size="xs">
                  <DaysFromNow date={endsAt} withoutSuffix />
                </Text>
              </IconBadge>
            )}
          </div>
        </div>
      }
      footerGradient
      footer={
        <div className="flex w-full flex-col gap-2">
          <UserAvatarSimple
            id={createdBy.id}
            username={createdBy.username}
            profilePicture={createdBy.profilePicture}
            cosmetics={createdBy.cosmetics}
            deletedAt={createdBy.deletedAt}
          />
          <div className="flex flex-col gap-1">
            {theme && (
              <Text size="sm" c="white" lineClamp={1} className="drop-shadow-sm">
                Theme: {theme}
              </Text>
            )}
            <Text size="xl" fw={700} lineClamp={2} lh={1.2}>
              {title}
            </Text>
          </div>
          <div className="flex items-center justify-between gap-2">
            <CurrencyBadge
              currency={Currency.BUZZ}
              unitAmount={prizePool}
              radius="xl"
              px={8}
              variant="filled"
              className={cardClasses.chip}
              style={darkBgStyle}
            />
            <Group gap={4}>
              {commentCount > 0 && (
                <IconBadge
                  icon={<IconMessageCircle2 size={14} />}
                  color="gray.0"
                  p={0}
                  px={8}
                  size="lg"
                  variant="transparent"
                  className={cardClasses.chip}
                  style={darkBgStyle}
                  radius="xl"
                >
                  <Text fw="bold" size="xs">
                    {abbreviateNumber(commentCount)}
                  </Text>
                </IconBadge>
              )}
              <IconBadge
                icon={<IconPhoto size={14} />}
                color="gray.0"
                p={0}
                px={8}
                size="lg"
                variant="transparent"
                className={cardClasses.chip}
                style={darkBgStyle}
                radius="xl"
              >
                <Text fw="bold" size="xs">
                  {abbreviateNumber(entryCount)}
                </Text>
              </IconBadge>
            </Group>
          </div>
        </div>
      }
    />
  );
}

type StatusBadgeProps = Pick<ChallengeListItem, 'status' | 'startsAt' | 'endsAt'>;
type Props = { data: ChallengeListItem };
