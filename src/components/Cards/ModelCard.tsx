import {
  Badge,
  getPrimaryShade,
  Text,
  Tooltip,
  useComputedColorScheme,
  useMantineTheme,
} from '@mantine/core';
import { memo, useMemo } from 'react';
import {
  IconArchiveFilled,
  IconBolt,
  IconClockDollar,
  IconLockDollar,
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
import { useModelCardContext, useModelSaleBadge } from '~/components/Cards/ModelCardContext';
import {
  SaleDiscountLabel,
  saleDiscountText,
} from '~/components/Model/ModelVersions/ModelVersionSaleBadge';
import { NextLink } from '~/components/NextLink/NextLink';
import { ModelCardContextMenu } from '~/components/Cards/ModelCardContextMenu';
import { getCardBaseModels, getModelRecency } from '~/components/Cards/model-card.utils';
import { AspectRatioImageCard } from '~/components/CardTemplates/AspectRatioImageCard';
import { CivitaiLinkManageButton } from '~/components/CivitaiLink/CivitaiLinkManageButton';
import { useElementInView } from '~/components/IntersectionObserver/ElementInView';
import { AnimatedCount, Metrics } from '~/components/Metrics';
import { HiddenMetricNotice } from '~/components/Model/HiddenMetricNotice';
import type { UseQueryModelReturn } from '~/components/Model/model.utils';
import type { HiddenModelMetrics } from '~/server/utils/model-metric-privacy';
import { ModelTypeBadge } from '~/components/Model/ModelTypeBadge/ModelTypeBadge';
import { ThumbsUpIcon } from '~/components/ThumbsIcon/ThumbsIcon';
import { UserAvatarSimple } from '~/components/UserAvatar/UserAvatarSimple';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useEngagedModelMembership } from '~/hooks/useEngagedModelMembership';
import { Availability, ModelModifier } from '~/shared/utils/prisma/enums';
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

export const ModelCard = memo(function ModelCard({ data }: Props) {
  return <ModelCardContent data={data} />;
});

const accessChipStyles = { label: { display: 'flex', alignItems: 'center', gap: 4 } } as const;

/**
 * A link, not a labelled `div`: the card header is `pointer-events: none` so its chips fall through
 * to the image link, and making this one hit-testable — which it must be, or the tooltip's trigger
 * is never reached — took that away. An anchor gives the click back.
 *
 * `pointer-events-auto` is load-bearing: the header is `pointer-events: none` and the `.chip` this
 * card uses never turns it back on, so without it the chip takes neither the hover nor the click.
 *
 * The name comes from ARIA because the content is an abstract glyph, and a merged discount has to
 * ride in the name too: `aria-label` overrides the subtree, so the drawn "20% off" reaches no
 * screen reader on its own.
 */
function AccessChip({
  label,
  icon,
  href,
  sale,
}: {
  label: string;
  icon: React.ReactNode;
  href: string;
  sale?: Parameters<typeof SaleDiscountLabel>[0]['sale'];
}) {
  const theme = useMantineTheme();
  // `circle` sizes the width from the badge size while `.chip` pins height at 26px, so both axes
  // are set here.
  // Green rather than the `success` teal, which sits close enough to the recency chip's blue at
  // chip size to read as one colour.
  const style = {
    backgroundColor: theme.colors.green[7],
    ...(sale ? { paddingInline: 8 } : { width: 26, height: 26, padding: 0 }),
  };

  return (
    <Tooltip
      label={label}
      position="right"
      withinPortal
      withArrow
      openDelay={0}
      zIndex={10000}
      // No `touch`: the chip is a link, so a tap navigates before the label can be read. Hover and
      // focus are the two that reach anyone.
      events={{ hover: true, focus: true, touch: false }}
    >
      <Badge
        component={NextLink}
        href={href}
        className={clsx(cardClasses.chip, 'pointer-events-auto')}
        variant="filled"
        radius="xl"
        data-status-badge="access"
        aria-label={sale ? `${label}, ${saleDiscountText(sale)}` : label}
        {...(sale ? {} : { circle: true })}
        styles={accessChipStyles}
        style={style}
      >
        {icon}
        {sale && (
          <Text c="white" size="xs" tt="capitalize">
            <SaleDiscountLabel sale={sale} />
          </Text>
        )}
      </Badge>
    </Tooltip>
  );
}

function ModelCardContent({ data }: Props) {
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');

  const currentUser = useCurrentUser();

  const { isNew, isUpdated } = getModelRecency(data);
  const isEarlyAccess = data.earlyAccessDeadline && data.earlyAccessDeadline > new Date();
  // Any live gate. `isEarlyAccess` stays a client-side deadline check because a search document can
  // be 15 minutes stale; this flag covers the gates with no deadline to check — permanent ones, and
  // timed ones whose end date was never materialized.
  const isPaidAccess = !!data.hasActivePaidAccess;
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

  const recencyBadgeStyle = useMemo(
    () => ({ backgroundColor: theme.colors.blue[getPrimaryShade(theme, colorScheme)] }),
    [theme, colorScheme]
  );

  const { useModelVersionRedirect, activeBaseModels, salesByModelId, hasSaleProvider } =
    useModelCardContext();
  // Absent until the batched lookup lands, so the badge appears a beat after the card — deliberate: a
  // sale is worth an extra request, not a slower feed.
  // The feed passes a map down; surfaces that cannot ask for their own. `hasSaleProvider` is set by the
  // provider itself, so a card does not fire its own query during the render before the map resolves —
  // reading `!!salesByModelId` fired every card once on first paint and the requests were already gone
  // by the time the flag flipped.
  const ownSale = useModelSaleBadge(data.id, !!hasSaleProvider);
  const sale = salesByModelId?.[data.id] ?? ownSale;

  const cardBaseModels = getCardBaseModels(
    data as Parameters<typeof getCardBaseModels>[0],
    activeBaseModels
  );
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

  // The search doc carries images for the newest version of each base model, but
  // images[0] is always the latest version's cover — show the matched version's
  // cover instead when a base-model filter is active. The feed type omits
  // modelVersionId (its images are already the matched version's), so it falls back.
  const image =
    (activeBaseModels?.length
      ? data.images.find(
          (i) => (i as { modelVersionId?: number }).modelVersionId === targetVersionId
        )
      : undefined) ?? data.images[0];

  return (
    <AspectRatioImageCard
      impression={{ entityType: 'Model', entityId: data.id }}
      href={href}
      cosmetic={data.cosmetic?.data}
      contentType="model"
      contentId={data.id}
      image={image}
      alt={data.name}
      onSite={!!data.version.trainingStatus}
      isRemix={!!image?.remixOfId}
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

            {sale && !isPaidAccess && !isEarlyAccess && (
              <Badge className={cardClasses.chip} variant="filled" radius="xl" color="green">
                <Text c="white" size="xs" tt="capitalize">
                  <SaleDiscountLabel sale={sale} />
                </Text>
              </Badge>
            )}

            {(isNew || isUpdated) && (
              <Badge
                className={cardClasses.chip}
                variant="filled"
                radius="xl"
                data-status-badge="recency"
                style={recencyBadgeStyle}
              >
                <Text c="white" size="xs" tt="capitalize">
                  {isUpdated ? 'Updated' : 'New'}
                </Text>
              </Badge>
            )}
            {isEarlyAccess ? (
              <AccessChip
                label="Early Access"
                icon={<IconClockDollar size={16} color="white" />}
                href={href}
                sale={sale}
              />
            ) : isPaidAccess ? (
              <AccessChip
                label="Paid"
                icon={<IconLockDollar size={16} color="white" />}
                href={href}
                sale={sale}
              />
            ) : null}
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
            <RemixButton id={data.version.id} canGenerate={data.canGenerate} />

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
  const { isEngaged } = useEngagedModelMembership(data.id);
  const hasReview = isEngaged('Recommended');
  const isPOI = data.poi;
  const hiddenMetrics = (data as { hiddenMetrics?: HiddenModelMetrics }).hiddenMetrics;

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
    <Metrics entityType="Model" entityId={data.id} initial={baseMetrics} useLive={inView !== false}>
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
                    {hiddenMetrics?.downloads ? (
                      <HiddenMetricNotice size={12} />
                    ) : (
                      <AnimatedCount value={m.downloadCount} />
                    )}
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
                        {hiddenMetrics?.buzz ? (
                          <HiddenMetricNotice size={12} />
                        ) : (
                          <AnimatedCount value={m.tippedAmountCount + tippedAmount} />
                        )}
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

type Props = { data: UseQueryModelReturn[number]; forceInView?: boolean };
