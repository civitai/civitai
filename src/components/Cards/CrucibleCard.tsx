import { Badge, Text } from '@mantine/core';
import { IconClockHour4 } from '@tabler/icons-react';
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
  endAt: Date;
  entryFee: number;
  user: {
    id: number;
    username: string | null;
    deletedAt: Date | null;
    image: string | null;
  };
  image?: {
    id: number;
    url: string;
    type: string;
    name?: string | null;
    metadata: MixedObject | null;
    nsfwLevel?: number;
    userId?: number;
    user?: { id: number };
    width?: number | null;
    height?: number | null;
    thumbnailUrl?: string | null;
  } | null;
  _count?: {
    entries: number;
  };
};

export function CrucibleCard({ data }: { data: CrucibleCardData }) {
  const { id, name, status, endAt, entryFee, user, image, _count } = data;
  const entryCount = _count?.entries ?? 0;

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
              type: image.type as any,
              name: image.name,
              metadata: image.metadata,
              nsfwLevel: image.nsfwLevel,
              userId: image.userId,
              user: image.user,
              width: image.width,
              height: image.height,
              thumbnailUrl: image.thumbnailUrl,
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
            {status !== CrucibleStatus.Completed && status !== CrucibleStatus.Cancelled && (
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
          <div className="flex items-center gap-2">
            <Badge
              className={cardClasses.chip}
              style={{
                backgroundColor: 'rgba(0, 0, 0, 0.31)',
              }}
              radius="xl"
              px={8}
              variant="filled"
            >
              <Text size="xs" fw="bold">
                {abbreviateNumber(entryCount)} {entryCount === 1 ? 'entry' : 'entries'}
              </Text>
            </Badge>
          </div>
        </div>
      }
    />
  );
}
