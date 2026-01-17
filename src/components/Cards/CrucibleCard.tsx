import { Badge, Box, Skeleton, Text } from '@mantine/core';
import { IconClockHour4, IconFlame } from '@tabler/icons-react';
import clsx from 'clsx';
import React from 'react';
import { AspectRatioImageCard } from '~/components/CardTemplates/AspectRatioImageCard';
import cardClasses from '~/components/Cards/Cards.module.css';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { UserAvatarSimple } from '~/components/UserAvatar/UserAvatarSimple';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { Currency, CrucibleStatus } from '~/shared/utils/prisma/enums';
import { abbreviateNumber } from '~/utils/number-helpers';
import { slugit } from '~/utils/string-helpers';

type CrucibleCardData = {
  id: number;
  name: string;
  status: CrucibleStatus;
  endAt: Date | null;
  entryFee: number;
  user: {
    id: number;
    username: string | null;
    deletedAt: Date | null;
    image: string | null;
  };
  image: {
    id: number;
    url: string;
    type: any;
    name: string | null;
    metadata: any;
    nsfwLevel: number;
    width: number | null;
    height: number | null;
  } | null;
  _count: {
    entries: number;
  };
};

export function CrucibleCard({ data }: { data: CrucibleCardData }) {
  const { id, name, status, endAt, entryFee, user, image, _count } = data;
  const entryCount = _count.entries ?? 0;

  // Calculate total prize pool (entryFee * entryCount)
  const prizePool = entryFee * entryCount;

  // Determine status badge
  const getStatusBadge = () => {
    switch (status) {
      case CrucibleStatus.Active:
        return (
          <Badge
            className={cardClasses.chip}
            color="green"
            variant="filled"
            radius="xl"
            px={8}
            h={26}
            fw="bold"
          >
            Active
          </Badge>
        );
      case CrucibleStatus.Pending:
        return (
          <Badge
            className={cardClasses.chip}
            color="blue"
            variant="filled"
            radius="xl"
            px={8}
            h={26}
            fw="bold"
          >
            Upcoming
          </Badge>
        );
      case CrucibleStatus.Completed:
        return (
          <Badge
            className={cardClasses.chip}
            color="gray"
            variant="filled"
            radius="xl"
            px={8}
            h={26}
            fw="bold"
          >
            Completed
          </Badge>
        );
      case CrucibleStatus.Cancelled:
        return (
          <Badge
            className={cardClasses.chip}
            color="red"
            variant="filled"
            radius="xl"
            px={8}
            h={26}
            fw="bold"
          >
            Cancelled
          </Badge>
        );
      default:
        return null;
    }
  };

  return (
    <AspectRatioImageCard
      href={`/crucibles/${id}/${slugit(name)}`}
      aspectRatio="portrait"
      contentType="crucible"
      contentId={id}
      image={
        image
          ? {
              id: image.id,
              url: image.url,
              type: image.type,
              name: image.name,
              metadata: (image.metadata as MixedObject) ?? null,
              nsfwLevel: image.nsfwLevel,
              width: image.width,
              height: image.height,
            }
          : undefined
      }
      header={<div className="flex w-full justify-end">{getStatusBadge()}</div>}
      footerGradient
      footer={
        <div className="flex w-full flex-col gap-2">
          <UserAvatarSimple {...user} />
          <div className="flex items-start justify-between gap-2">
            <Text size="xl" fw={700} lineClamp={2} lh={1.2}>
              {name}
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
              style={{
                backgroundColor: 'rgba(0, 0, 0, 0.31)',
              }}
            />
            {status !== CrucibleStatus.Completed &&
              status !== CrucibleStatus.Cancelled &&
              endAt && (
                <IconBadge
                  icon={<IconClockHour4 size={14} />}
                  color="dark"
                  className={cardClasses.chip}
                  style={{
                    backgroundColor: 'rgba(0, 0, 0, 0.31)',
                  }}
                  radius="xl"
                  px={8}
                  h={26}
                  variant="filled"
                >
                  <Text fw="bold" size="xs">
                    <DaysFromNow date={endAt} withoutSuffix />
                  </Text>
                </IconBadge>
              )}
          </div>
          <IconBadge
            icon={<IconFlame size={14} />}
            color="dark"
            className={cardClasses.chip}
            style={{
              backgroundColor: 'rgba(0, 0, 0, 0.31)',
            }}
            radius="xl"
            px={8}
            h={26}
            variant="filled"
          >
            <Text size="xs" fw="bold">
              {abbreviateNumber(entryCount)} {entryCount === 1 ? 'entry' : 'entries'}
            </Text>
          </IconBadge>
          {/* Status indicator with colored dot */}
          <div className="flex items-center gap-1.5">
            <Box className={clsx('size-2 rounded-full', getStatusDotColor(status, endAt))} />
            <Text size="xs" c="dimmed">
              {getStatusText(status, endAt)}
            </Text>
          </div>
        </div>
      }
    />
  );
}

/**
 * Check if a crucible is ending soon (within 3 days)
 */
function isEndingSoon(endAt: Date): boolean {
  const now = new Date();
  const threeDaysFromNow = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
  return new Date(endAt) <= threeDaysFromNow;
}

/**
 * Get the status dot color class based on crucible status
 */
function getStatusDotColor(status: CrucibleStatus, endAt: Date | null): string {
  if (status === CrucibleStatus.Active && endAt && isEndingSoon(endAt)) {
    return 'bg-yellow-5';
  }
  switch (status) {
    case CrucibleStatus.Active:
      return 'bg-green-5';
    case CrucibleStatus.Pending:
      return 'bg-blue-5';
    case CrucibleStatus.Completed:
      return 'bg-gray-5';
    case CrucibleStatus.Cancelled:
      return 'bg-red-5';
    default:
      return 'bg-gray-5';
  }
}

/**
 * Get status text for display
 */
function getStatusText(status: CrucibleStatus, endAt: Date | null): string {
  switch (status) {
    case CrucibleStatus.Active:
      if (endAt && isEndingSoon(endAt)) {
        return 'Ending Soon';
      }
      return 'Active - Accepting entries';
    case CrucibleStatus.Pending:
      return 'Upcoming';
    case CrucibleStatus.Completed:
      return 'Completed';
    case CrucibleStatus.Cancelled:
      return 'Cancelled';
    default:
      return '';
  }
}

/**
 * Skeleton loader for CrucibleCard
 * Matches the card dimensions and layout while data is loading
 */
export function CrucibleCardSkeleton() {
  return (
    <div className="relative overflow-hidden rounded-lg bg-dark-6" style={{ aspectRatio: '7/9' }}>
      {/* Background skeleton */}
      <Skeleton height="100%" width="100%" radius={0} />

      {/* Header - status badge */}
      <div className="absolute left-0 top-0 flex w-full justify-end p-2">
        <Skeleton height={26} width={70} radius="xl" />
      </div>

      {/* Footer */}
      <div
        className="absolute bottom-0 left-0 w-full p-2"
        style={{
          background: 'linear-gradient(transparent, rgba(0,0,0,.6))',
        }}
      >
        <div className="flex flex-col gap-2">
          {/* User avatar */}
          <div className="flex items-center gap-2">
            <Skeleton height={24} width={24} circle />
            <Skeleton height={12} width={80} />
          </div>

          {/* Name */}
          <Skeleton height={24} width="80%" />

          {/* Prize pool and countdown */}
          <div className="flex items-center justify-between gap-2">
            <Skeleton height={26} width={80} radius="xl" />
            <Skeleton height={26} width={70} radius="xl" />
          </div>

          {/* Entries */}
          <Skeleton height={26} width={80} radius="xl" />

          {/* Status indicator */}
          <div className="flex items-center gap-1.5">
            <Skeleton height={8} width={8} circle />
            <Skeleton height={12} width={100} />
          </div>
        </div>
      </div>
    </div>
  );
}
