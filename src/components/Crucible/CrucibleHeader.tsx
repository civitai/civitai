import { Avatar, Badge, Text, Title } from '@mantine/core';
import { IconClock, IconUsers, IconTrophy } from '@tabler/icons-react';
import clsx from 'clsx';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { CrucibleTimer } from '~/components/Crucible/CrucibleTimer';
import { Currency, CrucibleStatus } from '~/shared/utils/prisma/enums';
import { abbreviateNumber } from '~/utils/number-helpers';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { getInitials } from '~/utils/string-helpers';

export type CrucibleHeaderData = {
  id: number;
  name: string;
  description: string | null;
  status: CrucibleStatus;
  nsfwLevel: number;
  entryFee: number;
  endAt: Date | null;
  user: {
    id: number;
    username: string | null;
    deletedAt: Date | null;
    image: string | null;
  };
  image: {
    id: number;
    url: string;
    name: string | null;
    nsfwLevel: number;
    width: number | null;
    height: number | null;
  } | null;
  _count: {
    entries: number;
  };
};

type CrucibleHeaderProps = {
  crucible: CrucibleHeaderData;
  className?: string;
};

/**
 * CrucibleHeader - Hero section for crucible detail page
 *
 * Displays:
 * - Full-width background image with gradient overlay
 * - Crucible name, description, and status
 * - Creator info with avatar
 * - Countdown timer
 * - Prize pool and entry count stats
 * - NSFW level badge if applicable
 */
export function CrucibleHeader({ crucible, className }: CrucibleHeaderProps) {
  const { id, name, description, status, nsfwLevel, entryFee, endAt, user, image, _count } =
    crucible;
  const entryCount = _count.entries ?? 0;
  const prizePool = entryFee * entryCount;

  const hasEnded = status === CrucibleStatus.Completed || status === CrucibleStatus.Cancelled;

  // Status badge styling
  const getStatusBadge = () => {
    switch (status) {
      case CrucibleStatus.Active:
        return (
          <Badge color="blue" variant="filled" radius="xl" size="md" fw={600}>
            ACTIVE NOW
          </Badge>
        );
      case CrucibleStatus.Pending:
        return (
          <Badge color="blue" variant="filled" radius="xl" size="md" fw={600}>
            UPCOMING
          </Badge>
        );
      case CrucibleStatus.Completed:
        return (
          <Badge color="gray" variant="filled" radius="xl" size="md" fw={600}>
            COMPLETED
          </Badge>
        );
      case CrucibleStatus.Cancelled:
        return (
          <Badge color="red" variant="filled" radius="xl" size="md" fw={600}>
            CANCELLED
          </Badge>
        );
      default:
        return null;
    }
  };

  return (
    <div
      className={clsx('relative h-[350px] overflow-hidden sm:h-[500px]', className)}
      style={{
        background: !image ? 'linear-gradient(135deg, #1a1b1e 0%, #25262b 100%)' : undefined,
      }}
    >
      {/* Background image (uses crucible cover image) */}
      {image && (
        <div className="absolute inset-0">
          <EdgeMedia
            src={image.url}
            name={image.name}
            type="image"
            width={1600}
            className="size-full object-cover opacity-50"
            style={{ objectPosition: 'center' }}
          />
        </div>
      )}

      {/* Gradient overlay */}
      <div
        className="absolute inset-0"
        style={{
          background: 'linear-gradient(to bottom, rgba(26,27,30,0.1) 0%, rgba(26,27,30,0.8) 100%)',
        }}
      />

      {/* Content wrapper */}
      <div className="relative z-10 mx-auto flex h-full max-w-7xl items-end px-4">
        {/* Overlay card */}
        <div
          className="mb-8 max-w-xl rounded-xl border border-white/10 p-8"
          style={{
            background: 'rgba(37, 38, 43, 0.95)',
            backdropFilter: 'blur(10px)',
          }}
        >
          {/* Status badge */}
          <div className="mb-3">{getStatusBadge()}</div>

          {/* Title */}
          <Title order={1} className="mb-3 text-white" fw={700} size="h2">
            {name}
          </Title>

          {/* Description */}
          {description && (
            <ContentClamp maxHeight={72} className="mb-4">
              <Text size="sm" c="dimmed" lh={1.6}>
                {description}
              </Text>
            </ContentClamp>
          )}

          {/* Creator info with avatar */}
          <div className="flex items-center gap-3">
            <Avatar
              src={user.image}
              radius="xl"
              size={40}
              styles={{
                root: {
                  flexShrink: 0,
                },
                placeholder: {
                  background: 'linear-gradient(135deg, #7950f2 0%, #228be6 100%)',
                  color: 'white',
                  fontWeight: 600,
                  fontSize: 14,
                },
              }}
            >
              {user.username ? getInitials(user.username) : null}
            </Avatar>
            <div className="flex flex-col">
              <Text size="sm" fw={600} c="white" lh={1.3}>
                {user.deletedAt ? '[deleted]' : user.username}
              </Text>
              {!user.deletedAt && user.username && (
                <Text size="xs" c="dimmed" lh={1.3}>
                  @{user.username}
                </Text>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Stats bar - positioned at bottom outside the card */}
      <div className="absolute inset-x-0 bottom-0 z-10">
        <div className="mx-auto max-w-7xl px-4 pb-4">
          <div className="flex items-center gap-6">
            {/* Prize Pool */}
            <div className="flex items-center gap-2">
              <IconTrophy size={18} className="text-yellow-500" />
              <CurrencyBadge
                currency={Currency.BUZZ}
                unitAmount={prizePool}
                variant="transparent"
                size="lg"
                fw={700}
              />
            </div>

            {/* Entry count */}
            <div className="flex items-center gap-2">
              <IconUsers size={18} className="text-dimmed" />
              <Text size="sm" fw={600} c="white">
                {abbreviateNumber(entryCount)} {entryCount === 1 ? 'entry' : 'entries'}
              </Text>
            </div>

            {/* Timer */}
            {!hasEnded && endAt && (
              <div className="flex items-center gap-2">
                <IconClock size={18} className="text-dimmed" />
                <CrucibleTimer endAt={endAt} hasEnded={hasEnded} />
              </div>
            )}

            {/* NSFW Level badge */}
            {nsfwLevel > 1 && (
              <Badge color="red" variant="filled" radius="xl" size="sm">
                {getNsfwLabel(nsfwLevel)}
              </Badge>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Get NSFW label based on level
 * Based on browsingLevel.constants.ts patterns
 */
function getNsfwLabel(level: number): string {
  // Simplified NSFW labels based on common patterns
  if (level <= 1) return 'PG';
  if (level <= 2) return 'PG-13';
  if (level <= 4) return 'R';
  if (level <= 8) return 'X';
  return 'XXX';
}
