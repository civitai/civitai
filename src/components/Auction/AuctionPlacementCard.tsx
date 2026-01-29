import type { GroupProps, HighlightProps } from '@mantine/core';
import {
  Badge,
  Button,
  Divider,
  Group,
  Highlight,
  Skeleton,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
  useMantineTheme,
} from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import {
  IconCircle,
  IconCrown,
  IconEye,
  IconPlayerPauseFilled,
  IconPlayerPlayFilled,
  IconPlus,
  IconRepeat,
  IconStarFilled,
  IconTrash,
  IconUser,
} from '@tabler/icons-react';
import clsx from 'clsx';
import produce from 'immer';
import React, { useEffect, useRef, useState } from 'react';
import { useInView } from 'react-intersection-observer';
import { hasNSFWWords } from '~/components/Auction/auction.utils';
import { useAuctionContext } from '~/components/Auction/AuctionProvider';
import { usePurchaseBid } from '~/components/Auction/AuctionUtils';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import cardClasses from '~/components/Cards/Cards.module.css';
import { CosmeticCard } from '~/components/CardTemplates/CosmeticCard';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollAreaContext';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useBrowsingSettings } from '~/providers/BrowserSettingsProvider';
import type {
  GetAuctionBySlugReturn,
  GetMyBidsReturn,
  GetMyRecurringBidsReturn,
} from '~/server/services/auction.service';
import type { GenerationResource } from '~/shared/types/generation.types';
import type { ImagesForModelVersions } from '~/server/services/image.service';
import { getHasExplicitBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { Currency } from '~/shared/utils/prisma/enums';
import { formatDate } from '~/utils/date-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { formatCurrencyForDisplay } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

type ModelData = GetAuctionBySlugReturn['bids'][number];
type AuctionBaseData = GetAuctionBySlugReturn['auctionBase'];
type ModelMyBidData = GetMyBidsReturn[number];
type ModelMyRecurringBidData = GetMyRecurringBidsReturn[number];

const IMAGE_HEIGHT = 100;

const PositionData = ({
  position,
  aboveThreshold,
}: {
  position: number;
  aboveThreshold: boolean;
}) => {
  const theme = useMantineTheme();

  const isTop3 = !!position && aboveThreshold && position <= 3;
  const iconColor = [
    theme.colors.yellow[5], // Gold
    theme.colors.gray[5], // Silver
    theme.colors.orange[5], // Bronze
  ][position - 1];

  return (
    <>
      {isTop3 ? (
        <IconCrown
          size={60}
          color={iconColor}
          className="absolute left-1/2 top-[35%] -translate-x-1/2 -translate-y-1/2 opacity-30"
          style={{ fill: iconColor }}
        />
      ) : (
        <IconCircle
          size={60}
          stroke={0.5}
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 opacity-30"
        />
      )}
      <Text size="lg" fw="bold">
        {position || '-'}
      </Text>
    </>
  );
};

const SectionPosition = ({
  position,
  aboveThreshold,
  slugHref,
}: {
  position: number;
  aboveThreshold: boolean;
  slugHref?: AuctionBaseData;
}) => {
  const mobile = useIsMobile({ breakpoint: 'md' });

  const px = mobile ? 16 : 40;
  const mr = mobile ? -8 : -16;

  const el = (
    <Stack align="center" gap={0} className="relative md:w-[100px]" px={px} mr={mr}>
      <PositionData position={position} aboveThreshold={aboveThreshold} />
    </Stack>
  );

  if (!slugHref) return el;

  return (
    <Link href={`/auctions/${slugHref.slug}`}>
      <Tooltip
        label={
          <Stack className="text-center" gap={4}>
            <Text>Position: {position || 'N/A'}</Text>
            <Text>Go to {slugHref.name}</Text>
          </Stack>
        }
        withinPortal
      >
        {el}
      </Tooltip>
    </Link>
  );
};

const SectionModelImage = ({ image }: { image: ImagesForModelVersions | undefined }) => {
  return (
    <div className="relative h-[100px]">
      {image ? (
        <ImageGuard2 image={image} explain={false}>
          {(safe) => (
            <>
              <ImageGuard2.BlurToggle className="absolute left-2 top-2 z-10" />
              {!safe ? (
                !image.hash ? (
                  <Skeleton
                    animate={false}
                    width={`${IMAGE_HEIGHT}px`}
                    height={`${IMAGE_HEIGHT}px`}
                  />
                ) : (
                  <div
                    style={{
                      height: `${IMAGE_HEIGHT}px`,
                      width: `${IMAGE_HEIGHT}px`,
                    }}
                  >
                    <MediaHash
                      {...image}
                      // style={{
                      //   height: `${IMAGE_HEIGHT}px`,
                      //   width: `${IMAGE_HEIGHT}px`,
                      // }}
                    />
                  </div>
                )
              ) : (
                <EdgeMedia2
                  src={image.url}
                  name={image.name ?? image.id.toString()}
                  alt={image.name ?? undefined}
                  type={image.type}
                  width={IMAGE_HEIGHT}
                  // height={IMAGE_HEIGHT}
                  placeholder="empty"
                  style={{
                    objectFit: 'cover',
                    height: `${IMAGE_HEIGHT}px`,
                    width: `${IMAGE_HEIGHT}px`,
                  }}
                />
              )}
            </>
          )}
        </ImageGuard2>
      ) : (
        <Skeleton animate={false} width={`${IMAGE_HEIGHT}px`} height={`${IMAGE_HEIGHT}px`} />
      )}
    </div>
  );
};

const useHideNsfwText = () => {
  const blurNsfw = useBrowsingSettings((x) => x.blurNsfw);
  const browsingLevel = useBrowsingLevelDebounced();
  const hasExplicit = getHasExplicitBrowsingLevel(browsingLevel);
  return !hasExplicit || blurNsfw;
};

const OverflowTooltip = ({
  label,
  searchText,
  ...highlightProps
}: { label: string; searchText: string } & Omit<HighlightProps, 'highlight' | 'children'>) => {
  const textElementRef = useRef<HTMLDivElement>(null);
  const [isOverflown, setIsOverflown] = useState(false);

  // TODO this doesnt appear to listen for changes when resizing
  useEffect(() => {
    const element = textElementRef.current;
    const compare = element
      ? element.offsetWidth < element.scrollWidth || element.offsetHeight < element.scrollHeight
      : false;
    setIsOverflown(compare);
  }, []);

  return (
    <Tooltip label={label} disabled={!isOverflown} withinPortal multiline>
      <Highlight
        ref={textElementRef}
        className="min-w-0 max-w-[min(400px,80vw)] truncate"
        highlight={searchText}
        {...highlightProps}
      >
        {label}
      </Highlight>
    </Tooltip>
  );
};

const SectionModelInfo = ({
  entityData,
  searchText,
}: {
  entityData: ModelData['entityData'];
  searchText: string;
}) => {
  const isMobile = useIsMobile();
  const shouldHide = useHideNsfwText();
  const blurNsfw =
    shouldHide && (hasNSFWWords(entityData?.name) || hasNSFWWords(entityData?.model?.name));
  const [hideText, setHideText] = useState(blurNsfw);

  // state isn't being updated if entityData is initially undefined or the blurLevels change
  useEffect(() => {
    setHideText(blurNsfw);
  }, [blurNsfw]);

  const El = (
    <Stack gap={8} justify="space-around">
      <Stack gap={0}>
        {!hideText ? (
          <>
            <OverflowTooltip
              label={entityData?.model?.name ?? '(Unknown Model)'}
              searchText={searchText}
              size="lg"
              fw={500}
              fz={isMobile ? 'sm' : undefined}
            />
            <OverflowTooltip
              label={entityData?.name ?? '(Unknown Version)'}
              searchText={searchText}
              size="sm"
              color="dimmed"
            />
          </>
        ) : (
          <div className="flex">
            <Button
              leftSection={<IconEye size={14} strokeWidth={2.5} />}
              onClick={() => setHideText(false)}
              size="xs"
              variant="outline"
            >
              Show model info
            </Button>
          </div>
        )}
      </Stack>
      {/* TODO highlight username */}
      {!!entityData?.model?.user && (
        <UserAvatar
          withUsername
          size="sm"
          user={entityData.model.user}
          avatarProps={{ size: 18 }}
        />
      )}
    </Stack>
  );

  if (hideText) return <div>{El}</div>;

  return (
    <Link
      href={!!entityData ? `/models/${entityData.model.id}?modelVersionId=${entityData.id}` : '/'}
    >
      {El}
    </Link>
  );
};

const SectionBidInfo = ({
  amount,
  position,
  aboveThreshold,
  currencyTooltip,
  top,
  right,
  bottom,
  rightProps,
  slugHref,
}: {
  amount: number;
  position?: number;
  aboveThreshold: boolean;
  currencyTooltip?: string;
  top?: React.ReactNode;
  right?: React.ReactNode;
  bottom?: React.ReactNode;
  rightProps?: GroupProps;
  slugHref?: AuctionBaseData;
}) => {
  const mobile = useIsMobile({ breakpoint: 'md' });

  return (
    <Stack
      py="sm"
      px="xs"
      align="center"
      gap="sm"
      className={
        mobile
          ? 'w-full border-t border-solid border-t-gray-4 dark:border-t-dark-4'
          : 'ml-[-16px] w-[140px]'
      }
      style={{
        flexGrow: 1,
        flexDirection: mobile ? 'row-reverse' : undefined,
        justifyContent: mobile ? 'space-between' : undefined,
      }}
    >
      {top}
      <Group wrap="nowrap" gap="sm" {...rightProps}>
        <Tooltip label={currencyTooltip} disabled={!currencyTooltip}>
          <CurrencyBadge
            currency={Currency.BUZZ}
            unitAmount={amount}
            displayCurrency={false}
            radius="sm"
            size="xl"
            iconProps={{
              size: 14,
            }}
            style={{
              fontSize: '1.25rem',
            }}
            asCounter={true}
          />
        </Tooltip>
        {right}
      </Group>
      <Group>
        {mobile && position && (
          <SectionPosition
            position={position}
            slugHref={slugHref}
            aboveThreshold={aboveThreshold}
          />
        )}
        {bottom}
      </Group>
    </Stack>
  );
};

export const ModelMyBidCard = ({
  data,
  searchText,
}: {
  data: ModelMyBidData;
  searchText: string;
}) => {
  const mobile = useIsMobile({ breakpoint: 'md' });
  const { handleBuy, createLoading } = usePurchaseBid();
  const queryUtils = trpc.useUtils();

  const { mutate: deleteBid } = trpc.auction.deleteBid.useMutation({
    onSuccess: () => {
      showSuccessNotification({
        message: 'Bid deleted!',
      });

      queryUtils.auction.getBySlug.setData(
        { slug: data.auction.auctionBase.slug },
        produce((old) => {
          if (!old) return;
          const ob = old.bids.find((o) => o.entityId === data.entityId);
          if (ob) {
            ob.totalAmount -= data.amount;
            ob.count -= 1;
            old.bids = old.bids
              .filter((b) => b.totalAmount > 0)
              .sort((a, b) => b.totalAmount - a.totalAmount || b.count - a.count)
              .map((b, idx) => ({
                ...b,
                position: idx + 1,
              }));
          }
        })
      );
      queryUtils.auction.getMyBids.setData(undefined, (old) => {
        if (!old) return old;
        return old.filter((o) => o.id !== data.id);
      });
    },
    onError(error) {
      showErrorNotification({
        title: 'Failed to delete bid',
        error: new Error(error.message),
      });
    },
  });

  const handleDelete = () => {
    openConfirmModal({
      title: 'Delete bid',
      children: 'Are you sure you want to delete this bid?',
      centered: true,
      labels: { confirm: 'Delete', cancel: 'No, keep it' },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        deleteBid({ bidId: data.id });
      },
    });
  };

  return (
    <CosmeticCard className="group hover:bg-gray-2 dark:hover:bg-dark-5">
      <Stack gap={0}>
        <Group className="gap-y-2 max-md:flex-col">
          {!mobile && (
            <SectionPosition
              position={data.position}
              aboveThreshold={data.aboveThreshold}
              slugHref={data.auction.auctionBase}
            />
          )}
          <Group className="flex gap-y-2 py-2 max-md:w-full max-md:px-2 md:flex-[10]">
            <SectionModelImage image={data.entityData?.image} />
            <SectionModelInfo entityData={data.entityData} searchText={searchText} />
          </Group>

          {!mobile && <Divider orientation="vertical" />}

          <SectionBidInfo
            amount={data.amount}
            position={data.position}
            aboveThreshold={data.aboveThreshold}
            slugHref={data.auction.auctionBase}
            currencyTooltip={`Total: ⚡${formatCurrencyForDisplay(
              data.totalAmount,
              Currency.BUZZ
            )} (${Math.floor((data.amount / data.totalAmount) * 100)}%)`}
            top={
              <>
                {!mobile && (
                  <Text size="xs" c="dimmed" title={data.createdAt.toISOString()}>
                    {formatDate(data.createdAt)}
                  </Text>
                )}

                {data.isActive && (
                  <Group className="absolute right-1 top-1">
                    <Tooltip
                      className={!mobile ? 'opacity-0 group-hover:opacity-100' : ''}
                      label="Cancel"
                    >
                      <LegacyActionIcon
                        size="sm"
                        color="red"
                        variant="filled"
                        onClick={handleDelete}
                      >
                        <IconTrash size={16} />
                      </LegacyActionIcon>
                    </Tooltip>
                  </Group>
                )}
              </>
            }
            bottom={!data.isActive && data.isRefunded && !mobile && <Badge>Refunded</Badge>}
            right={
              mobile && (
                <Group>
                  {!data.isActive && data.isRefunded && <Badge>Refunded</Badge>}
                  <Text size="xs" c="dimmed" title={data.createdAt.toISOString()}>
                    {formatDate(data.createdAt)}
                  </Text>
                </Group>
              )
            }
            rightProps={{ className: 'max-md:flex-row-reverse' }}
          />
        </Group>
        {!!data.additionalPriceNeeded && data.isActive && (
          <>
            <Divider />
            <Group p="sm" justify="flex-end" w="100%">
              <Text>{`⚡${formatCurrencyForDisplay(
                data.additionalPriceNeeded,
                Currency.BUZZ
              )} more needed to place in the top ${data.auction.quantity}`}</Text>
              <BuzzTransactionButton
                loading={createLoading}
                disabled={createLoading}
                label={'Bid'}
                buzzAmount={data.additionalPriceNeeded}
                onPerformTransaction={() =>
                  handleBuy({
                    bidPrice: data.additionalPriceNeeded,
                    auctionId: data.auction.id,
                    modelId: data.entityId,
                    // onSuccess: () => {
                    //   // redirect TODO
                    // },
                  })
                }
                size="xs"
              />
            </Group>
          </>
        )}
      </Stack>
    </CosmeticCard>
  );
};

export const ModelMyRecurringBidCard = ({
  data,
  searchText,
}: {
  data: ModelMyRecurringBidData;
  searchText: string;
}) => {
  const mobile = useIsMobile({ breakpoint: 'md' });
  const queryUtils = trpc.useUtils();

  const { mutate: deleteRecurringBid } = trpc.auction.deleteRecurringBid.useMutation({
    onSuccess: () => {
      showSuccessNotification({
        message: 'Recurring bid deleted!',
      });

      queryUtils.auction.getMyRecurringBids.setData(undefined, (old) => {
        if (!old) return old;
        return old.filter((o) => o.id !== data.id);
      });
    },
    onError(error) {
      showErrorNotification({
        title: 'Failed to delete recurring bid',
        error: new Error(error.message),
      });
    },
  });
  const { mutate: togglePauseRecurringBid } = trpc.auction.togglePauseRecurringBid.useMutation({
    onSuccess: (res) => {
      showSuccessNotification({
        message: `Recurring bid ${res.isPaused ? 'paused' : 'resumed'}!`,
      });

      queryUtils.auction.getMyRecurringBids.setData(
        undefined,
        produce((old) => {
          if (!old) return;
          const ob = old.find((o) => o.id === res.id);
          if (ob) {
            ob.isPaused = res.isPaused;
          }
        })
      );
    },
    onError(error) {
      showErrorNotification({
        title: 'Failed to toggle pause for recurring bid',
        error: new Error(error.message),
      });
    },
  });

  const handleDelete = () => {
    openConfirmModal({
      title: 'Delete bid',
      children: 'Are you sure you want to delete this recurring bid?',
      centered: true,
      labels: { confirm: 'Delete', cancel: 'No, keep it' },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        deleteRecurringBid({ bidId: data.id });
      },
    });
  };

  const handleTogglePause = () => {
    openConfirmModal({
      title: `${data.isPaused ? 'Resume' : 'Pause'} bid`,
      children: `Are you sure you want to ${
        data.isPaused ? 'resume' : 'temporarily pause'
      } this recurring bid?`,
      centered: true,
      labels: { confirm: 'Yes', cancel: 'No' },
      confirmProps: { color: data.isPaused ? 'green' : 'orange' },
      onConfirm: () => {
        togglePauseRecurringBid({ bidId: data.id });
      },
    });
  };

  return (
    <CosmeticCard className="group hover:bg-gray-2 dark:hover:bg-dark-5">
      <Stack gap={0}>
        <Group className="gap-y-2 max-md:flex-col">
          <Group className="flex gap-y-2 p-2 max-md:w-full md:flex-[10]">
            <SectionModelImage image={data.entityData?.image} />
            <SectionModelInfo entityData={data.entityData} searchText={searchText} />
          </Group>

          {!mobile && <Divider orientation="vertical" />}

          <SectionBidInfo
            amount={data.amount}
            aboveThreshold={false}
            top={
              <Group gap={4} className="absolute right-1 top-1 z-10">
                <Tooltip
                  className={!mobile ? 'opacity-0 group-hover:opacity-100' : ''}
                  label={data.isPaused ? 'Resume' : 'Pause'}
                >
                  <LegacyActionIcon
                    size="sm"
                    color={data.isPaused ? 'green' : 'orange'}
                    variant="filled"
                    onClick={handleTogglePause}
                  >
                    {data.isPaused ? (
                      <IconPlayerPlayFilled size={16} />
                    ) : (
                      <IconPlayerPauseFilled size={16} />
                    )}
                  </LegacyActionIcon>
                </Tooltip>
                <Tooltip
                  className={!mobile ? 'opacity-0 group-hover:opacity-100' : ''}
                  label="Cancel"
                >
                  <LegacyActionIcon size="sm" color="red" variant="filled" onClick={handleDelete}>
                    <IconTrash size={16} />
                  </LegacyActionIcon>
                </Tooltip>
              </Group>
            }
            bottom={
              <Group gap="xs">
                <IconBadge
                  size="lg"
                  icon={<IconRepeat size={16} />}
                  tooltip="Recurs every day until"
                >
                  {!!data.endAt ? formatDate(data.endAt) : 'Forever'}
                </IconBadge>
                {data.isPaused && (
                  <Tooltip label="Paused">
                    <ThemeIcon variant="light" radius="xl" size="md">
                      <IconPlayerPauseFilled size={16} />
                    </ThemeIcon>
                  </Tooltip>
                )}
              </Group>
            }
          />
        </Group>
      </Stack>
    </CosmeticCard>
  );
};

export const ModelPlacementCard = ({
  data,
  aboveThreshold,
  addBidFn,
  searchText,
  canBid,
}: {
  data: ModelData;
  aboveThreshold: boolean;
  addBidFn: (r: GenerationResource) => void;
  searchText: string;
  canBid: boolean;
}) => {
  const mobile = useIsMobile({ breakpoint: 'md' });
  const currentUser = useCurrentUser();
  const { selectedAuction, justBid, setJustBid } = useAuctionContext();
  const animatedRef = useRef<HTMLDivElement>(null);
  const node = useScrollAreaRef();
  const { ref: viewRef, inView } = useInView({ root: node?.current, rootMargin: '1800px 0px' });

  const { data: myBidData = [] } = trpc.auction.getMyBids.useQuery(undefined, {
    enabled: !!currentUser,
  });

  const isRecentlyBid =
    !!justBid &&
    !!selectedAuction &&
    selectedAuction.id === justBid.auctionId &&
    data.entityId === justBid.entityId;

  const myBid = myBidData.find(
    (bid) => bid.entityId === data.entityId && selectedAuction?.id === bid.auction.id
  );

  useEffect(() => {
    const handleAnimationEnd = () => setJustBid(undefined);

    const element = animatedRef.current;
    if (element) {
      element.addEventListener('animationend', handleAnimationEnd);
    }

    return () => {
      if (element) {
        element.removeEventListener('animationend', handleAnimationEnd);
      }
    };
  }, [setJustBid]);

  // TODO scroll to animatedRef on success

  return (
    <div
      className={clsx({
        [cardClasses.winnerFirst]: aboveThreshold && data.position === 1,
        [cardClasses.winnerSecond]: aboveThreshold && data.position === 2,
        [cardClasses.winnerThird]: aboveThreshold && data.position === 3,
        'before:blur-sm': aboveThreshold && !!data.position && data.position <= 3,
      })}
      ref={viewRef}
    >
      <CosmeticCard
        className={clsx(
          'group transition-opacity duration-300 ease-in-out hover:bg-gray-2 dark:hover:bg-dark-5 ',
          {
            'animate-glowPulse': isRecentlyBid,
            'invisible opacity-0': !inView,
          }
        )}
        ref={animatedRef}
      >
        <Group className="gap-y-2 max-md:flex-col">
          {!mobile && <SectionPosition position={data.position} aboveThreshold={aboveThreshold} />}
          <Group className="flex gap-y-2 py-2 max-md:w-full max-md:px-2 md:flex-[10]">
            <div className="flex w-full min-w-0 gap-4">
              <div className="shrink-0">
                <SectionModelImage image={data.entityData?.image} />
              </div>
              <div className="min-w-0 grow">
                <SectionModelInfo entityData={data.entityData} searchText={searchText} />
              </div>
            </div>
          </Group>

          {!mobile && <Divider orientation="vertical" />}

          <SectionBidInfo
            amount={data.totalAmount}
            position={data.position}
            aboveThreshold={aboveThreshold}
            right={
              !!data.entityData && canBid ? (
                <Tooltip label="Support this model" position="top" withinPortal>
                  <LegacyActionIcon
                    size="lg"
                    variant="light"
                    color="blue"
                    onClick={() =>
                      data.entityData
                        ? addBidFn({
                            // TODO make a discriminator so we dont have to do this
                            ...data.entityData,
                            strength: -1,
                            minStrength: -1,
                            maxStrength: -1,
                            trainedWords: [],
                            canGenerate: true,
                            hasAccess: true,
                          })
                        : undefined
                    }
                  >
                    <IconPlus size={16} />
                  </LegacyActionIcon>
                </Tooltip>
              ) : undefined
            }
            bottom={
              <Group wrap="nowrap" gap={4}>
                <IconUser size={14} />
                <Text size="sm">{`${data.count} Bid${data.count !== 1 ? 's' : ''}`}</Text>
                {!!myBid && (
                  <Tooltip
                    label={`You bid ⚡${formatCurrencyForDisplay(myBid.amount, Currency.BUZZ)}`}
                  >
                    <IconStarFilled size={14} color="gold" />
                  </Tooltip>
                )}
              </Group>
            }
          />
        </Group>
      </CosmeticCard>
    </div>
  );
};

// export const ModelPlacementCardMemo = memo(ModelPlacementCard);
