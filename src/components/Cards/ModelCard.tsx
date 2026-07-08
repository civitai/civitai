import {
  Badge,
  getPrimaryShade,
  Text,
  useComputedColorScheme,
  useMantineTheme,
} from '@mantine/core';
import { memo, useMemo } from 'react';
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
import { getCardBaseModels } from '~/components/Cards/model-card.utils';
import { AspectRatioImageCard } from '~/components/CardTemplates/AspectRatioImageCard';
import { CivitaiLinkManageButton } from '~/components/CivitaiLink/CivitaiLinkManageButton';
import { useElementInView } from '~/components/IntersectionObserver/ElementInView';
import { AnimatedCount, Metrics } from '~/components/Metrics';
import type { UseQueryModelReturn } from '~/components/Model/model.utils';
import { ModelTypeBadge } from '~/components/Model/ModelTypeBadge/ModelTypeBadge';
import { ThumbsUpIcon } from '~/components/ThumbsIcon/ThumbsIcon';
import { UserAvatarSimple } from '~/components/UserAvatar/UserAvatarSimple';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useReviewedModelIds } from '~/hooks/useReviewedModelIds';
import { constants } from '~/server/common/constants';
import { Availability, ModelModifier } from '~/shared/utils/prisma/enums';
import { aDayAgo } from '~/utils/date-helpers';
import { getModelUrl } from '~/utils/string-helpers';

function ModFlagBadge({ labels }: { labels: string[] }) {
  return (
    <Badge
      className={clsx(cardClasses.infoChip, cardClasses.chip, cardClasses.forMod)}
      variant="light"
      radius="xl"
    >
      {labels.join(' | ')}
    </Badge>
  );
}

export const ModelCard = memo(function ModelCard({ data, priority }: Props) {
  return <ModelCardContent data={data} priority={priority} />;
});

function ModelCardContent({ data, priority }: Props) {
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');

  const currentUser = useCurrentUser();

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

  const modFlagLabels: string[] = [];
  if (currentUser?.isModerator) {
    if (isPOI) modFlagLabels.push('POI');
    if (isMinor) modFlagLabels.push('Minor');
    if (isNSFW) modFlagLabels.push('NSFW');
  }

  const statusBadgeStyle = useMemo(
    () => ({
      backgroundColor: isEarlyAccess
        ? theme.colors.success[5]
        : isUpdated
        ? theme.colors.teal[5]
        : theme.colors.blue[getPrimaryShade(theme, colorScheme)],
    }),
    [isEarlyAccess, isUpdated, theme, colorScheme]
  );

  const { useModelVersionRedirect, activeBaseModels } = useModelCardContext();
  const cardBaseModels = getCardBaseModels(data as Parameters<typeof getCardBaseModels>[0], activeBaseModels);
  // In search, data.version is the primary version; data.versions[] carries all of
  // them, so link to the version that matched the active base-model filter. The feed
  // has no versions[] (data.version is already the matched one), so it falls back.
  const targetVersionId =
    (activeBaseModels?.length
      ? (data as { versions?: { id: number; baseModel: string }[] }).versions?.find((v) =>
          activeBaseModels.includes(v.baseModel)
        )?.id
      : undefined) ?? data.version.id;
  const href = useMemo(
    () =>
      getModelUrl({
        modelId: data.id,
        modelName: data.name,
        modelVersionId: useModelVersionRedirect ? targetVersionId : null,
      }),
    [data.id, data.name, targetVersionId, useModelVersionRedirect]
  );

  return (
    <AspectRatioImageCard
      href={href}
      priority={priority}
      cosmetic={data.cosmetic?.data}
      contentType="model"
      contentId={data.id}
      image={data.images[0]}
      alt={data.name}
      onSite={!!data.version.trainingStatus}
      isRemix={!!data.images[0]?.remixOfId}
      header={
        <div className="flex w-full items-start justify-between">
          <div className="flex flex-wrap gap-1">
            {modFlagLabels.length > 0 && <ModFlagBadge labels={modFlagLabels} />}
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
              baseModels={cardBaseModels}
            />

            {(isNew || isUpdated || isEarlyAccess) && (
              <Badge
                className={cardClasses.chip}
                variant="filled"
                radius="xl"
                style={statusBadgeStyle}
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
          {data.rank && <ModelCardStats data={data} />}
        </div>
      }
    />
  );
}

/**
 * Gated live-metrics render for the ModelCard footer stats. Lives inside the
 * AspectRatioCard's ElementInView subtree so it can read visibility context
 * and pass `useLive` into Metrics. Only subscribes + renders live values when
 * the card is visible; matches the old `MetricSubscriptionProvider` gating.
 */
function ModelCardStats({ data }: { data: Props['data'] }) {
  const inView = useElementInView();
  const tippedAmount = useBuzzTippingStore({ entityType: 'Model', entityId: data.id });
  const reviewedModelIds = useReviewedModelIds();
  const hasReview = reviewedModelIds.has(data.id);
  const isPOI = data.poi;

  const baseMetrics = useMemo(
    () => ({
      downloadCount: data.rank?.downloadCount ?? 0,
      collectedCount: data.rank?.collectedCount ?? 0,
      commentCount: data.rank?.commentCount ?? 0,
      tippedAmountCount: data.rank?.tippedAmountCount ?? 0,
      thumbsUpCount: data.rank?.thumbsUpCount ?? 0,
      thumbsDownCount: data.rank?.thumbsDownCount ?? 0,
    }),
    [data.rank]
  );

  return (
    <Metrics
      entityType="Model"
      entityId={data.id}
      initial={baseMetrics}
      useLive={inView !== false}
    >
      {(m) => {
        const totalCount = m.thumbsUpCount + m.thumbsDownCount;
        const positiveRating = totalCount > 0 ? m.thumbsUpCount / totalCount : 0;
        return (
          <div className="flex flex-wrap items-center justify-between gap-1">
            {(!!m.downloadCount || !!m.collectedCount || !!m.tippedAmountCount) && (
              <Badge
                className={clsx(cardClasses.statChip, cardClasses.chip)}
                classNames={{ label: 'flex flex-nowrap gap-2' }}
                variant="light"
                radius="xl"
              >
                <div className="flex items-center gap-0.5">
                  <IconDownload size={14} strokeWidth={2.5} />
                  <Text size="xs" lh={1} fw="bold">
                    <AnimatedCount value={m.downloadCount} />
                  </Text>
                </div>
                <div className="flex items-center gap-0.5">
                  <IconBookmark size={14} strokeWidth={2.5} />
                  <Text size="xs" lh={1} fw="bold">
                    <AnimatedCount value={m.collectedCount} />
                  </Text>
                </div>
                <div className="flex items-center gap-0.5">
                  <IconMessageCircle2 size={14} strokeWidth={2.5} />
                  <Text size="xs" lh={1} fw="bold">
                    <AnimatedCount value={m.commentCount} />
                  </Text>
                </div>
                {!isPOI && (
                  <InteractiveTipBuzzButton
                    toUserId={data.user.id}
                    entityType={'Model'}
                    entityId={data.id}
                  >
                    <div className="flex items-center gap-0.5">
                      <IconBolt size={14} strokeWidth={2.5} />
                      <Text size="xs" lh={1} fw="bold">
                        <AnimatedCount value={m.tippedAmountCount + tippedAmount} />
                      </Text>
                    </div>
                  </InteractiveTipBuzzButton>
                )}
              </Badge>
            )}
            {!data.locked && !!m.thumbsUpCount && (
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
                  <AnimatedCount value={m.thumbsUpCount} />
                </Text>
              </Badge>
            )}
          </div>
        );
      }}
    </Metrics>
  );
}

type Props = { data: UseQueryModelReturn[number]; forceInView?: boolean; priority?: boolean };
