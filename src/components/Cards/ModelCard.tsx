import {
  Badge,
  getPrimaryShade,
  Group,
  Text,
  useComputedColorScheme,
  useMantineTheme,
} from '@mantine/core';
import {
  IconArchiveFilled,
  IconBolt,
  IconBookmark,
  IconDownload,
  IconLock,
  IconMessageCircle2,
} from '@tabler/icons-react';
import clsx from 'clsx';
import {
  InteractiveTipBuzzButton,
  useBuzzTippingStore,
} from '~/components/Buzz/InteractiveTipBuzzButton';
import cardClasses from '~/components/Cards/Cards.module.css';
import HoverActionButton from '~/components/Cards/components/HoverActionButton';
import { RemixButton } from '~/components/Cards/components/RemixButton';
import { useModelCardContext } from '~/components/Cards/ModelCardContext';
import { ModelCardContextMenu } from '~/components/Cards/ModelCardContextMenu';
import { AspectRatioImageCard } from '~/components/CardTemplates/AspectRatioImageCard';
import { CivitaiLinkManageButton } from '~/components/CivitaiLink/CivitaiLinkManageButton';
import { MetricSubscriptionProvider, useLiveMetrics } from '~/components/Metrics';
import type { UseQueryModelReturn } from '~/components/Model/model.utils';
import { ModelTypeBadge } from '~/components/Model/ModelTypeBadge/ModelTypeBadge';
import { ThumbsUpIcon } from '~/components/ThumbsIcon/ThumbsIcon';
import { UserAvatarSimple } from '~/components/UserAvatar/UserAvatarSimple';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { constants } from '~/server/common/constants';
import { Availability, ModelModifier } from '~/shared/utils/prisma/enums';
import { aDayAgo } from '~/utils/date-helpers';
import { abbreviateNumber } from '~/utils/number-helpers';
import { slugit } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

export function ModelCard({ data }: Props) {
  return (
    <MetricSubscriptionProvider entityType="Model" entityId={data.id}>
      <ModelCardContent data={data} />
    </MetricSubscriptionProvider>
  );
}

function ModelCardContent({ data }: Props) {
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');
  const image = data.images[0];
  const aspectRatio = image && image.width && image.height ? image.width / image.height : 1;

  const currentUser = useCurrentUser();
  const tippedAmount = useBuzzTippingStore({ entityType: 'Model', entityId: data.id });

  const { data: { Recommended: reviewedModels = [] } = { Recommended: [] } } =
    trpc.user.getEngagedModels.useQuery(undefined, {
      enabled: !!currentUser,
      cacheTime: Infinity,
      staleTime: Infinity,
    });
  const hasReview = reviewedModels.includes(data.id);

  const isNew = data.publishedAt && data.publishedAt > aDayAgo;
  const isUpdated =
    data.lastVersionAt &&
    data.publishedAt &&
    data.lastVersionAt > aDayAgo &&
    data.lastVersionAt.getTime() - data.publishedAt.getTime() > constants.timeCutOffs.updatedModel;
  const isEarlyAccess = data.earlyAccessDeadline && data.earlyAccessDeadline > new Date();
  const isArchived = data.mode === ModelModifier.Archived;

  const isPOI = data.poi;
  // Ensures we don't show both flags for the most part. But it makes sense something can be both.
  const isMinor = data.minor;
  const isNSFW = data.nsfw;
  const isPrivate = data.availability === Availability.Private;

  // Live metrics for model stats
  const liveMetrics = useLiveMetrics('Model', data.id, {
    downloadCount: data.rank?.downloadCount ?? 0,
    collectedCount: data.rank?.collectedCount ?? 0,
    commentCount: data.rank?.commentCount ?? 0,
    tippedAmountCount: data.rank?.tippedAmountCount ?? 0,
    thumbsUpCount: data.rank?.thumbsUpCount ?? 0,
    thumbsDownCount: data.rank?.thumbsDownCount ?? 0,
  });

  const thumbsUpCount = liveMetrics.thumbsUpCount;
  const thumbsDownCount = liveMetrics.thumbsDownCount;
  const totalCount = thumbsUpCount + thumbsDownCount;
  const positiveRating = totalCount > 0 ? thumbsUpCount / totalCount : 0;

  const { useModelVersionRedirect } = useModelCardContext();
  let href = `/models/${data.id}/${slugit(data.name)}`;
  if (useModelVersionRedirect) href += `?modelVersionId=${data.version.id}`;

  return (
    <AspectRatioImageCard
      href={href}
      cosmetic={data.cosmetic?.data}
      contentType="model"
      contentId={data.id}
      image={data.images[0]}
      onSite={!!data.version.trainingStatus}
      isRemix={!!data.images[0]?.remixOfId}
      header={
        <div className="flex w-full items-start justify-between">
          <div className="flex flex-wrap gap-1">
            {currentUser?.isModerator && isPOI && (
              <Badge
                className={clsx(cardClasses.infoChip, cardClasses.chip, cardClasses.forMod)}
                variant="light"
                radius="xl"
              >
                <Text c="white" size="xs" fw="bold">
                  POI
                </Text>
              </Badge>
            )}
            {currentUser?.isModerator && isMinor && (
              <Badge
                className={clsx(cardClasses.infoChip, cardClasses.chip, cardClasses.forMod)}
                variant="light"
                radius="xl"
              >
                <Text c="white" size="xs" fw="bold">
                  Minor
                </Text>
              </Badge>
            )}
            {currentUser?.isModerator && isNSFW && (
              <Badge
                className={clsx(cardClasses.infoChip, cardClasses.chip, cardClasses.forMod)}
                variant="light"
                radius="xl"
              >
                <Text c="white" size="xs" fw="bold">
                  NSFW
                </Text>
              </Badge>
            )}
            {isPrivate && (
              <Badge
                className={clsx(cardClasses.infoChip, cardClasses.chip)}
                variant="light"
                radius="xl"
              >
                <IconLock size={16} />
              </Badge>
            )}
            <ModelTypeBadge
              className={clsx(cardClasses.infoChip, cardClasses.chip)}
              type={data.type}
              baseModel={data.version.baseModel}
            />

            {(isNew || isUpdated || isEarlyAccess) && (
              <Badge
                className={cardClasses.chip}
                variant="filled"
                radius="xl"
                style={{
                  backgroundColor: isEarlyAccess
                    ? theme.colors.success[5]
                    : isUpdated
                    ? theme.colors.teal[5]
                    : theme.colors.blue[getPrimaryShade(theme, colorScheme)],
                }}
              >
                <Text c="white" size="xs" tt="capitalize">
                  {isEarlyAccess ? 'Early Access' : isUpdated ? 'Updated' : 'New'}
                </Text>
              </Badge>
            )}
            {isArchived && (
              <Badge
                className={clsx(cardClasses.infoChip, cardClasses.chip)}
                variant="light"
                radius="xl"
              >
                <IconArchiveFilled size={16} />
              </Badge>
            )}
          </div>
          <div className="flex flex-col items-center gap-2">
            <ModelCardContextMenu data={data} />
            <RemixButton type="modelVersion" id={data.version.id} canGenerate={data.canGenerate} />

            <CivitaiLinkManageButton
              modelId={data.id}
              modelName={data.name}
              modelType={data.type}
              hashes={data.hashes}
              noTooltip
              iconSize={16}
            >
              {({ color, onClick, icon, label }) => (
                <HoverActionButton
                  onClick={onClick}
                  label={label}
                  size={30}
                  color={color}
                  variant="filled"
                  keepIconOnHover
                >
                  {icon}
                </HoverActionButton>
              )}
            </CivitaiLinkManageButton>
          </div>
        </div>
      }
      footer={
        <div className="flex w-full flex-col items-start gap-1">
          <UserAvatarSimple {...data.user} />
          <Text className={cardClasses.dropShadow} size="xl" fw={700} lineClamp={3} lh={1.2}>
            {data.name}
          </Text>
          {data.rank && (
            <div className="flex flex-wrap items-center justify-between gap-1">
              {(!!liveMetrics.downloadCount ||
                !!liveMetrics.collectedCount ||
                !!liveMetrics.tippedAmountCount) && (
                <Badge
                  className={clsx(cardClasses.statChip, cardClasses.chip)}
                  classNames={{ label: 'flex flex-nowrap gap-2' }}
                  variant="light"
                  radius="xl"
                >
                  <Group gap={2}>
                    <IconDownload size={14} strokeWidth={2.5} />
                    <Text size="xs" lh={1} fw="bold">
                      {abbreviateNumber(liveMetrics.downloadCount)}
                    </Text>
                  </Group>
                  <Group gap={2}>
                    <IconBookmark size={14} strokeWidth={2.5} />
                    <Text size="xs" lh={1} fw="bold">
                      {abbreviateNumber(liveMetrics.collectedCount)}
                    </Text>
                  </Group>
                  <Group gap={2}>
                    <IconMessageCircle2 size={14} strokeWidth={2.5} />
                    <Text size="xs" lh={1} fw="bold">
                      {abbreviateNumber(liveMetrics.commentCount)}
                    </Text>
                  </Group>
                  {!isPOI && (
                    <InteractiveTipBuzzButton
                      toUserId={data.user.id}
                      entityType={'Model'}
                      entityId={data.id}
                    >
                      <Group gap={2}>
                        <IconBolt size={14} strokeWidth={2.5} />
                        <Text size="xs" lh={1} fw="bold" tt="uppercase">
                          {abbreviateNumber(liveMetrics.tippedAmountCount + tippedAmount)}
                        </Text>
                      </Group>
                    </InteractiveTipBuzzButton>
                  )}
                </Badge>
              )}
              {!data.locked && !!thumbsUpCount && (
                <Badge
                  className={clsx(cardClasses.statChip, cardClasses.chip)}
                  pl={6}
                  pr={8}
                  data-reviewed={hasReview}
                  radius="xl"
                  title={`${Math.round(positiveRating * 100)}% of reviews are positive`}
                  classNames={{ label: 'gap-2 flex items-center' }}
                >
                  <Text c={hasReview ? 'success.5' : 'yellow.8'} mt={2} lh={1} span>
                    <ThumbsUpIcon size={20} filled={hasReview} strokeWidth={2.5} />
                  </Text>
                  <Text fz={16} fw={500} lh={1} span>
                    {abbreviateNumber(thumbsUpCount)}
                  </Text>
                </Badge>
              )}
            </div>
          )}
        </div>
      }
    />
  );
}

type Props = { data: UseQueryModelReturn[number]; forceInView?: boolean };
