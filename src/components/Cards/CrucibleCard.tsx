import { Badge, Skeleton, Text } from '@mantine/core';
import { IconCheck, IconClockHour4, IconFlame, IconGavel } from '@tabler/icons-react';
import React, { useMemo } from 'react';
import { AspectRatioImageCard } from '~/components/CardTemplates/AspectRatioImageCard';
import cardClasses from '~/components/Cards/Cards.module.css';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { UserAvatarSimple } from '~/components/UserAvatar/UserAvatarSimple';
import { CrucibleContextMenu } from '~/components/Crucible/CrucibleContextMenu';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import type { CrucibleJudgingStatus } from '~/server/schema/crucible.schema';
import { Currency, CrucibleStatus } from '~/shared/utils/prisma/enums';
import {
  CRUCIBLE_PRIZE_BUZZ_TYPE,
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
        <div className="flex w-full items-center justify-between gap-1">
          {judgingBadge ? (
            <Badge
              className={cardClasses.chip}
              color={judgingBadge.color}
              variant="filled"
              radius="xl"
              px={8}
              h={26}
              fw="bold"
              leftSection={
                judgingBadge.kind === 'available' ? <IconGavel size={14} /> : <IconCheck size={14} />
              }
            >
              {judgingBadge.label}
            </Badge>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-1">
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
            <CrucibleContextMenu crucible={{ id, userId: user.id }} position="bottom-end" />
          </div>
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
          <div className="flex items-center justify-between gap-2">
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

          {/* Prize pool and countdown */}
          <div className="flex items-center justify-between gap-2">
            <Skeleton height={26} width={80} radius="xl" />
            <Skeleton height={26} width={70} radius="xl" />
          </div>

          {/* Entries */}
          <Skeleton height={26} width={80} radius="xl" />
        </div>
      </div>
    </div>
  );
}
