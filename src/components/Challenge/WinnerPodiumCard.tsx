import { useState } from 'react';
import { Group, Text, useComputedColorScheme } from '@mantine/core';
import { IconCrown, IconPhotoOff, IconSparkles, IconTrophy } from '@tabler/icons-react';
import Link from 'next/link';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { JudgeScoreBadge } from '~/components/Image/JudgeScoreBadge/JudgeScoreBadge';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import type { JudgeInfo } from '~/components/Image/Providers/ImagesProvider';
import { Currency, MediaType } from '~/shared/utils/prisma/enums';
import type { ProfileImage } from '~/server/selectors/image.selector';
import type { UserWithCosmetics } from '~/server/selectors/user.selector';
import type { JudgeScore } from '~/server/games/daily-challenge/daily-challenge.utils';

export type WinnerPodiumData = {
  place: number;
  userId: number;
  username: string;
  imageId: number | null;
  imageUrl: string | null;
  imageNsfwLevel?: number | null;
  imageHash?: string | null;
  buzzAwarded: number;
  reason?: string | null;
  judgeScore?: JudgeScore | null;
  profilePicture?: ProfileImage | null;
  cosmetics?: UserWithCosmetics['cosmetics'] | null;
};

export const placeConfig = {
  1: {
    label: '1st Place',
    shortLabel: '1st',
    gradient: 'from-yellow-400 via-amber-500 to-orange-500',
    border: 'border-yellow-500/50',
    icon: IconCrown,
    iconColor: 'text-yellow-500',
    bgGlow: 'shadow-yellow-500/20',
  },
  2: {
    label: '2nd Place',
    shortLabel: '2nd',
    gradient: 'from-slate-300 via-gray-400 to-slate-500',
    border: 'border-slate-400/50',
    icon: IconTrophy,
    iconColor: 'text-slate-400',
    bgGlow: 'shadow-slate-500/20',
  },
  3: {
    label: '3rd Place',
    shortLabel: '3rd',
    gradient: 'from-amber-600 via-orange-700 to-amber-800',
    border: 'border-orange-700/50',
    icon: IconTrophy,
    iconColor: 'text-orange-700',
    bgGlow: 'shadow-orange-700/20',
  },
} as const;

export function WinnerPodiumCard({
  winner,
  isFirst,
  className = '',
  isMobile = false,
  compact = false,
  judgeInfo,
}: {
  winner: WinnerPodiumData;
  isFirst: boolean;
  className?: string;
  isMobile?: boolean;
  compact?: boolean;
  judgeInfo?: JudgeInfo;
}) {
  const [reasonExpanded, setReasonExpanded] = useState(false);
  const colorScheme = useComputedColorScheme('dark');
  const isDark = colorScheme === 'dark';
  const config = placeConfig[winner.place as 1 | 2 | 3] ?? placeConfig[3];
  const PlaceIcon = config.icon;

  // Compact: flex-based sizing for podium effect; Mobile: full width; Desktop: fixed widths for podium effect
  const widthClass = compact
    ? isFirst
      ? 'flex-[1.25]'
      : 'flex-1'
    : isMobile
    ? 'w-full'
    : isFirst
    ? 'w-80'
    : 'w-64';

  return (
    <div
      className={`flex min-w-0 flex-col overflow-hidden rounded-xl border-2 ${config.border} ${
        isDark ? 'bg-dark-6' : 'bg-white'
      } ${widthClass} ${isFirst ? 'shadow-xl' : ''} ${config.bgGlow} shadow-lg ${className}`}
    >
      {/* Place Header with Gradient */}
      <div
        className={`bg-gradient-to-r ${config.gradient} ${compact ? 'px-2 py-1.5' : 'px-4 py-2.5'}`}
      >
        <Group justify="space-between" wrap="nowrap" gap="xs">
          <Group gap={compact ? 4 : 6} wrap="nowrap">
            <PlaceIcon
              size={compact ? 16 : isMobile ? 20 : isFirst ? 24 : 18}
              className="text-white"
            />
            <Text
              fw={700}
              c="white"
              size={compact ? 'xs' : isMobile || isFirst ? 'md' : 'sm'}
              className="whitespace-nowrap"
            >
              {compact ? config.shortLabel : config.label}
            </Text>
          </Group>
          {!compact && (
            <CurrencyBadge
              currency={Currency.BUZZ}
              unitAmount={winner.buzzAwarded}
              size="sm"
              style={{ background: 'rgba(255,255,255,0.2)', color: 'white' }}
            />
          )}
        </Group>
      </div>

      {/* Winner Image */}
      {winner.imageId && winner.imageUrl ? (
        <div
          className={`relative w-full overflow-hidden ${
            compact
              ? isFirst
                ? 'aspect-[5/6]'
                : 'aspect-square'
              : isFirst
              ? 'aspect-square'
              : 'aspect-[4/3]'
          }`}
        >
          <ImageGuard2
            image={{
              id: winner.imageId,
              nsfwLevel: winner.imageNsfwLevel ?? 0,
              url: winner.imageUrl,
            }}
          >
            {(safe) => (
              <>
                <Link href={`/images/${winner.imageId}`} className="block size-full">
                  {safe ? (
                    <EdgeMedia2
                      src={winner.imageUrl!}
                      type={MediaType.image}
                      imageId={winner.imageId!}
                      width={450}
                      className="size-full object-cover transition-transform duration-300 hover:scale-105"
                    />
                  ) : (
                    <MediaHash hash={winner.imageHash ?? null} width={450} height={450} />
                  )}
                </Link>
                <div className="absolute left-2 top-2 z-10 flex items-center gap-1">
                  <ImageGuard2.BlurToggle radius="xl" h={26} style={{ pointerEvents: 'auto' }} />
                  {safe && winner.judgeScore && (
                    <JudgeScoreBadge
                      score={winner.judgeScore}
                      imageId={winner.imageId!}
                      judgeInfo={judgeInfo}
                      size={compact ? 'xs' : 'sm'}
                    />
                  )}
                </div>
              </>
            )}
          </ImageGuard2>
        </div>
      ) : (
        <div
          className={`relative flex w-full items-center justify-center overflow-hidden bg-gray-100 dark:bg-dark-5 ${
            compact
              ? isFirst
                ? 'aspect-[5/6]'
                : 'aspect-square'
              : isFirst
              ? 'aspect-square'
              : 'aspect-[4/3]'
          }`}
        >
          <div className="flex flex-col items-center gap-1 text-gray-400 dark:text-dark-3">
            <IconPhotoOff size={compact ? 24 : 36} stroke={1.5} />
            <Text size={compact ? 'xs' : 'sm'} c="dimmed">
              Image removed
            </Text>
          </div>
        </div>
      )}

      {/* Winner Info */}
      <div className={`flex flex-1 flex-col ${compact ? 'gap-1 p-2' : 'gap-3 p-4'}`}>
        {/* Username + Avatar */}
        <Link href={`/user/${winner.username}`}>
          <Group gap={compact ? 4 : 'xs'} wrap="nowrap">
            <UserAvatar
              user={{
                id: winner.userId,
                username: winner.username,
                profilePicture: winner.profilePicture ?? undefined,
                cosmetics: winner.cosmetics ?? undefined,
              }}
              size={compact ? 'xs' : 'sm'}
              includeAvatar
              withUsername={false}
            />
            <Text
              fw={600}
              size={compact ? 'xs' : isFirst ? 'md' : 'sm'}
              className="hover:underline"
              lineClamp={1}
            >
              {winner.username}
            </Text>
            {isFirst && !compact && <IconCrown size={16} className={config.iconColor} />}
          </Group>
        </Link>

        {/* Judge's Reason — hidden in compact mode */}
        {!compact && winner.reason && (
          <div
            className={`rounded-lg p-3 ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}
            style={{ borderLeft: `3px solid var(--mantine-color-blue-5)` }}
          >
            <Text size="xs" c="dimmed" mb={4}>
              <IconSparkles size={12} className="mr-1 inline" />
              Judge&apos;s Note
            </Text>
            <Text
              size="xs"
              style={{ fontStyle: 'italic', lineHeight: 1.6 }}
              lineClamp={reasonExpanded ? undefined : 3}
            >
              &ldquo;{winner.reason}&rdquo;
            </Text>
            {winner.reason.length > 120 && (
              <Text
                size="xs"
                c="blue"
                className="mt-2 cursor-pointer hover:underline"
                onClick={() => setReasonExpanded(!reasonExpanded)}
              >
                {reasonExpanded ? 'Show less' : 'Read full note'}
              </Text>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
