import { Badge, Skeleton, Text, Tooltip } from '@mantine/core';
import { IconCheck, IconGavel, IconHourglass, IconUsers } from '@tabler/icons-react';
import clsx from 'clsx';
import React, { useMemo } from 'react';
import { AspectRatioImageCard } from '~/components/CardTemplates/AspectRatioImageCard';
import cardClasses from '~/components/Cards/Cards.module.css';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { UserAvatarSimple } from '~/components/UserAvatar/UserAvatarSimple';
import { CrucibleContextMenu } from '~/components/Crucible/CrucibleContextMenu';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import type { CrucibleJudgingStatus } from '~/server/schema/crucible.schema';
import { Currency, CrucibleStatus } from '~/shared/utils/prisma/enums';
import {
  CRUCIBLE_PRIZE_BUZZ_TYPE,
  CRUCIBLE_STATUS_BADGES,
  getCrucibleJudgingBadge,
  getCrucibleStatusBadge,
  getCrucibleTotalPrizePool,
  getCrucibleUrl,
} from '~/utils/crucible-helpers';
import { abbreviateNumber } from '~/utils/number-helpers';

type CrucibleCardData = {
  id: number;
  name: string;
  status: CrucibleStatus;
  nsfwLevel: number;
  startAt: Date | null;
  endAt: Date | null;
  entryFee: number;
  seededPrizePool: number;
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
  paidEntryCount: number;
  judging?: CrucibleJudgingStatus;
};

export function CrucibleCard({ data }: { data: CrucibleCardData }) {
  const {
    id,
    name,
    status,
    startAt,
    endAt,
    entryFee,
    seededPrizePool,
    user,
    image,
    _count,
    paidEntryCount,
    judging,
  } = data;
  const entryCount = _count.entries ?? 0;
  const prizePool = getCrucibleTotalPrizePool({ entryFee, paidEntryCount, seededPrizePool });

  const now = useMemo(() => new Date(), []);

  const statusBadge = getCrucibleStatusBadge(status, { startAt, endAt }, now);
  const judgingBadge = getCrucibleJudgingBadge(judging);

  return (
    <AspectRatioImageCard
      href={getCrucibleUrl(id, name)}
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
      header={
        <div className="flex w-full items-center justify-end gap-1">
          {/* The countdown in the footer already says a running crucible is live. */}
          {statusBadge !== CRUCIBLE_STATUS_BADGES[CrucibleStatus.Active] && (
            <Badge
              className={cardClasses.chip}
              color={statusBadge.color}
              variant="filled"
              radius="xl"
              px={8}
              h={26}
              fw="bold"
            >
              {statusBadge.label}
            </Badge>
          )}
          {judgingBadge && (
            <Tooltip label={judgingBadge.label} withinPortal>
              <div
                role="img"
                aria-label={judgingBadge.label}
                className={clsx(
                  cardClasses.chip,
                  // The header slot is pointer-events: none; without this the tooltip never opens.
                  'pointer-events-auto flex size-[26px] items-center justify-center rounded-full border-2',
                  judgingBadge.kind === 'available'
                    ? 'border-green-5 text-green-4'
                    : 'border-white/35 text-white/70'
                )}
                style={{ backgroundColor: 'rgba(0, 0, 0, 0.31)' }}
              >
                {judgingBadge.kind === 'available' ? (
                  <IconGavel size={14} />
                ) : (
                  <IconCheck size={14} />
                )}
              </div>
            </Tooltip>
          )}
          <CrucibleContextMenu crucible={{ id, userId: user.id }} position="bottom-end" />
        </div>
      }
      footerGradient
      footer={
        <div className="flex w-full flex-col gap-2">
          <UserAvatarSimple {...user} />
          <div className="flex items-start justify-between gap-2">
            <Text size="xl" fw={700} lineClamp={2} lh={1.2}>
              {name}
            </Text>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <CurrencyBadge
              currency={Currency.BUZZ}
              type={CRUCIBLE_PRIZE_BUZZ_TYPE}
              unitAmount={prizePool}
              radius="xl"
              px={8}
              variant="filled"
              className={cardClasses.chip}
              style={{
                backgroundColor: 'rgba(0, 0, 0, 0.31)',
              }}
            />
            {status === CrucibleStatus.Active && endAt && new Date(endAt) > now && (
              <Text component="span" size="xs" fw={600} className="flex items-center gap-1">
                <IconHourglass size={14} />
                <DaysFromNow date={endAt} withoutSuffix /> left
              </Text>
            )}
            <Text component="span" size="xs" fw={600} className="flex items-center gap-1">
              <IconUsers size={14} />
              {abbreviateNumber(entryCount)} {entryCount === 1 ? 'entry' : 'entries'}
            </Text>
          </div>
        </div>
      }
    />
  );
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

          {/* Prize pool, countdown and entries */}
          <div className="flex items-center gap-3">
            <Skeleton height={26} width={80} radius="xl" />
            <Skeleton height={14} width={60} />
            <Skeleton height={14} width={70} />
          </div>
        </div>
      </div>
    </div>
  );
}
