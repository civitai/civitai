import { Badge, Button, Container, Text, Title } from '@mantine/core';
import { IconArrowLeft, IconUsers } from '@tabler/icons-react';
import clsx from 'clsx';
import { NavigateBack } from '~/components/BackButton/BackButton';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { CrucibleTimer } from '~/components/Crucible/CrucibleTimer';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { Currency, CrucibleStatus } from '~/shared/utils/prisma/enums';
import { abbreviateNumber } from '~/utils/number-helpers';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { CrucibleUserLink } from '~/components/Crucible/CrucibleUserLink';
import {
  getCrucibleRatingLabel,
  getCrucibleStatusBadge,
  getCrucibleTotalPrizePool,
} from '~/utils/crucible-helpers';
import { NsfwLevel } from '~/server/common/enums';
import type { SimpleUser } from '~/server/selectors/user.selector';

export type CrucibleHeaderData = {
  id: number;
  name: string;
  description: string | null;
  status: CrucibleStatus;
  nsfwLevel: number;
  entryFee: number;
  seededPrizePool: number;
  endAt: Date | null;
  user: SimpleUser;
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
  const {
    id,
    name,
    description,
    status,
    nsfwLevel,
    entryFee,
    seededPrizePool,
    endAt,
    user,
    image,
    _count,
  } = crucible;
  const entryCount = _count.entries ?? 0;
  const prizePool = getCrucibleTotalPrizePool({ entryFee, entryCount, seededPrizePool });

  const statusBadge = getCrucibleStatusBadge(status, endAt);

  return (
    <div
      className={clsx('relative flex min-h-[350px] overflow-hidden sm:min-h-[500px]', className)}
      style={{
        background: !image ? 'linear-gradient(135deg, #1a1b1e 0%, #25262b 100%)' : undefined,
      }}
    >
      {/* Background image (uses crucible cover image) */}
      {image && (
        <div className="absolute inset-0 overflow-hidden">
          <EdgeMedia
            src={image.url}
            name={image.name}
            type="image"
            width={450}
            className="size-full scale-110 object-cover opacity-40 blur-2xl"
            // EdgeImage caps maxWidth at the requested width, which left a bare strip on wide screens.
            style={{ maxWidth: 'none' }}
          />
          <EdgeMedia
            src={image.url}
            name={image.name}
            type="image"
            width={1600}
            className="absolute inset-0 size-full object-contain opacity-70"
            style={{ maxWidth: 'none' }}
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

      <Container
        size="xl"
        className="relative z-10 flex w-full flex-col justify-between gap-6 pt-4"
      >
        <NavigateBack url="/crucibles">
          {({ onClick }) => (
            <Button
              variant="light"
              color="gray"
              size="compact-sm"
              leftSection={<IconArrowLeft size={16} />}
              onClick={onClick}
              className="self-start"
            >
              Back
            </Button>
          )}
        </NavigateBack>

        <div
          className="mb-8 max-w-xl rounded-xl border border-white/10 p-5 sm:p-8"
          style={{
            background: 'rgba(37, 38, 43, 0.95)',
            backdropFilter: 'blur(10px)',
          }}
        >
          {/* Status badge */}
          <div className="mb-3">
            <Badge
              color={statusBadge.color}
              variant="filled"
              radius="xl"
              size="md"
              fw={600}
              tt="uppercase"
            >
              {statusBadge.label}
            </Badge>
          </div>

          {/* Title */}
          <Title order={1} className="mb-3 text-white [overflow-wrap:anywhere]" fw={700} size="h2">
            {name}
          </Title>

          {/* Description */}
          {description && (
            <ContentClamp maxHeight={72} className="mb-4">
              <Text size="sm" c="dimmed" lh={1.6} className="[overflow-wrap:anywhere]">
                {description}
              </Text>
            </ContentClamp>
          )}

          <CrucibleUserLink user={user}>
            <UserAvatar user={user} avatarSize={40} size="lg" withHoverCard={false} />
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
          </CrucibleUserLink>

          <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-white/10 pt-4">
            <div className="flex items-center gap-2">
              <CurrencyBadge
                currency={Currency.BUZZ}
                unitAmount={prizePool}
                variant="transparent"
                size="lg"
                fw={700}
              />
            </div>

            <div className="flex items-center gap-2">
              <IconUsers size={18} className="text-dimmed" />
              <Text size="sm" fw={600} c="white">
                {abbreviateNumber(entryCount)} {entryCount === 1 ? 'entry' : 'entries'}
              </Text>
            </div>

            {status === CrucibleStatus.Active && endAt && <CrucibleTimer endAt={endAt} />}

            {nsfwLevel > NsfwLevel.PG && (
              <Badge
                color={nsfwLevel & ~(NsfwLevel.PG | NsfwLevel.PG13) ? 'red' : 'yellow'}
                variant="filled"
                radius="xl"
                size="sm"
              >
                {getCrucibleRatingLabel(nsfwLevel)}
              </Badge>
            )}
          </div>
        </div>
      </Container>
    </div>
  );
}
