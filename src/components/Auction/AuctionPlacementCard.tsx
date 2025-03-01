import {
  ActionIcon,
  Badge,
  Button,
  Divider,
  Group,
  GroupProps,
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
import { useAuctionContext } from '~/components/Auction/AuctionProvider';
import { usePurchaseBid } from '~/components/Auction/AuctionUtils';
import { useBrowsingLevelContext } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { CosmeticCard } from '~/components/CardTemplates/CosmeticCard';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsMobile } from '~/hooks/useIsMobile';
import type {
  GetAuctionBySlugReturn,
  GetMyBidsReturn,
  GetMyRecurringBidsReturn,
} from '~/server/services/auction.service';
import type { GenerationResource } from '~/server/services/generation/generation.service';
import type { ImagesForModelVersions } from '~/server/services/image.service';
import { Flags } from '~/shared/utils';
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

const PositionData = ({ position }: { position: number }) => {
  const theme = useMantineTheme();

  const isTop3 = !!position && position <= 3;
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
      <Text size="lg" weight="bold">
        {position}
      </Text>
    </>
  );
};

const SectionPosition = ({
  position,
  slugHref,
}: {
  position: number;
  slugHref?: AuctionBaseData;
}) => {
  const mobile = useIsMobile({ breakpoint: 'xs' });

  const px = mobile ? 16 : 40;
  const mr = mobile ? -8 : -16;

  const el = (
    <Stack align="center" spacing={0} className="relative" px={px} mr={mr}>
      <PositionData position={position} />
    </Stack>
  );

  if (!slugHref) return el;

  return (
    <Link
      href={`/auctions/${slugHref.slug}`}
      // className="flex flex-[10]"
    >
      <Tooltip label={`Go to ${slugHref.name}`} withinPortal>
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
                  <MediaHash
                    {...image}
                    // style={{
                    //   height: `${IMAGE_HEIGHT}px`,
                    //   width: `${IMAGE_HEIGHT}px`,
                    // }}
                  />
                )
              ) : (
                <EdgeMedia
                  src={image.url}
                  name={image.name ?? image.id.toString()}
                  alt={image.name ?? undefined}
                  type={image.type}
                  width={IMAGE_HEIGHT}
                  height={IMAGE_HEIGHT}
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

const SectionModelInfo = ({ entityData }: { entityData: ModelData['entityData'] }) => {
  const { blurLevels } = useBrowsingLevelContext();
  const blurNsfw = !!entityData ? Flags.hasFlag(blurLevels, entityData.nsfwLevel) : false;
  const [hideText, setHideText] = useState(blurNsfw);

  const El = (
    <Stack spacing={8} justify="space-around">
      <Stack spacing={0}>
        {!hideText ? (
          <>
            <Text
              size="lg"
              fw={500}
              sx={{
                textOverflow: 'ellipsis',
                maxWidth: 'min(400px, 80vw)',
                overflow: 'hidden',
                whiteSpace: 'nowrap',
                minWidth: 0,
              }}
            >
              {entityData?.model?.name ?? '(Unknown Model)'}
            </Text>
            <Text
              size="sm"
              color="dimmed"
              sx={{
                textOverflow: 'ellipsis',
                maxWidth: 'min(400px, 80vw)',
                overflow: 'hidden',
                whiteSpace: 'nowrap',
                minWidth: 0,
              }}
            >
              {entityData?.name ?? '(Unknown Version)'}
            </Text>
          </>
        ) : (
          <div className="flex flex-[10]">
            <Button
              leftIcon={<IconEye size={14} strokeWidth={2.5} />}
              onClick={() => setHideText(false)}
              size="xs"
              variant="outline"
            >
              Show model info
            </Button>
          </div>
        )}
      </Stack>
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

  if (hideText) return <div className="flex flex-[10] py-2">{El}</div>;

  return (
    <Link
      href={!!entityData ? `/models/${entityData.model.id}?modelVersionId=${entityData.id}` : '/'}
      className="flex flex-[10] py-2"
    >
      {El}
    </Link>
  );
};

const SectionBidInfo = ({
  amount,
  position,
  currencyTooltip,
  top,
  right,
  bottom,
  rightProps,
  slugHref,
}: {
  amount: number;
  position?: number;
  currencyTooltip?: string;
  top?: React.ReactNode;
  right?: React.ReactNode;
  bottom?: React.ReactNode;
  rightProps?: GroupProps;
  slugHref?: AuctionBaseData;
}) => {
  const mobile = useIsMobile({ breakpoint: 'xs' });

  return (
    <Stack
      py="sm"
      px="xs"
      w={140}
      align="center"
      spacing="sm"
      className={
        mobile ? 'border-t border-solid border-t-gray-4 dark:border-t-dark-4' : 'ml-[-16px]'
      }
      sx={{
        flexGrow: 1,
        flexDirection: mobile ? 'row-reverse' : undefined,
        justifyContent: mobile ? 'space-between' : undefined,
      }}
    >
      {top}
      <Group noWrap spacing="sm" {...rightProps}>
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
            sx={{
              fontSize: '1.25rem',
            }}
          />
        </Tooltip>
        {right}
      </Group>
      <Group>
        {mobile && position && <SectionPosition position={position} slugHref={slugHref} />}
        {bottom}
      </Group>
    </Stack>
  );
};

export const ModelMyBidCard = ({ data }: { data: ModelMyBidData }) => {
  const mobile = useIsMobile({ breakpoint: 'xs' });
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
              .sort((a, b) => b.totalAmount - a.totalAmount || b.count - a.count);
            ob.position = old.bids.findIndex((o) => o.entityId === data.entityId) + 1;
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
      <Stack spacing={0}>
        <Group className="gap-y-2">
          {!mobile && (
            <SectionPosition position={data.position} slugHref={data.auction.auctionBase} />
          )}
          <SectionModelImage image={data.entityData?.image} />
          <SectionModelInfo entityData={data.entityData} />

          {!mobile && <Divider orientation="vertical" />}

          <SectionBidInfo
            amount={data.amount}
            position={data.position}
            slugHref={data.auction.auctionBase}
            currencyTooltip={`Total: ⚡${formatCurrencyForDisplay(
              data.totalAmount,
              Currency.BUZZ
            )} (${Math.floor((data.amount / data.totalAmount) * 100)}%)`}
            top={
              <>
                <Text size="xs" color="dimmed" title={data.createdAt.toISOString()}>
                  {formatDate(data.createdAt)}
                </Text>

                {data.isActive && (
                  <Group className="absolute right-1 top-1">
                    <Tooltip
                      className={!mobile ? 'opacity-0 group-hover:opacity-100' : ''}
                      label="Cancel"
                    >
                      <ActionIcon size="sm" color="red" variant="filled" onClick={handleDelete}>
                        <IconTrash size={16} />
                      </ActionIcon>
                    </Tooltip>
                  </Group>
                )}
              </>
            }
            bottom={!data.isActive && data.isRefunded && <Badge>Refunded</Badge>}
            // rightProps={{ className: 'max-sm:-order-1' }}
          />
        </Group>
        {!!data.additionalPriceNeeded && data.isActive && (
          <>
            <Divider />
            <Group p="sm" position="right" w="100%">
              <Text>{`⚡${formatCurrencyForDisplay(
                data.additionalPriceNeeded,
                Currency.BUZZ
              )} more needed to place in the top ${data.auction.quantity}`}</Text>
              <BuzzTransactionButton
                loading={createLoading}
                disabled={createLoading}
                label={'Bid'}
                buzzAmount={data.additionalPriceNeeded}
                transactionType="Default"
                onPerformTransaction={() =>
                  handleBuy({
                    bidPrice: data.additionalPriceNeeded,
                    auctionId: data.auction.id,
                    modelId: data.entityId,
                    // onSuccess: () => {
                    //   // redirect
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

export const ModelMyRecurringBidCard = ({ data }: { data: ModelMyRecurringBidData }) => {
  const mobile = useIsMobile({ breakpoint: 'xs' });
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
      <Stack spacing={0}>
        <Group className="gap-y-2">
          <SectionModelImage image={data.entityData?.image} />
          <SectionModelInfo entityData={data.entityData} />

          {!mobile && <Divider orientation="vertical" />}

          <SectionBidInfo
            amount={data.amount}
            top={
              <Group spacing={4} className="absolute right-1 top-1 z-10">
                <Tooltip
                  className={!mobile ? 'opacity-0 group-hover:opacity-100' : ''}
                  label={data.isPaused ? 'Resume' : 'Pause'}
                >
                  <ActionIcon
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
                  </ActionIcon>
                </Tooltip>
                <Tooltip
                  className={!mobile ? 'opacity-0 group-hover:opacity-100' : ''}
                  label="Cancel"
                >
                  <ActionIcon size="sm" color="red" variant="filled" onClick={handleDelete}>
                    <IconTrash size={16} />
                  </ActionIcon>
                </Tooltip>
              </Group>
            }
            bottom={
              <Group spacing="xs">
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
  addBidFn,
}: {
  data: ModelData;
  addBidFn: (r: GenerationResource) => void;
}) => {
  const mobile = useIsMobile({ breakpoint: 'xs' });
  const currentUser = useCurrentUser();
  const { selectedAuction, justBid, setJustBid } = useAuctionContext();
  const animatedRef = useRef<HTMLDivElement>(null);

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
    <CosmeticCard
      className={clsx('group hover:bg-gray-2 dark:hover:bg-dark-5', {
        'animate-glowPulse': isRecentlyBid,
      })}
      ref={animatedRef}
    >
      <Group className="gap-y-2">
        {!mobile && <SectionPosition position={data.position} />}
        <SectionModelImage image={data.entityData?.image} />
        <SectionModelInfo entityData={data.entityData} />

        {!mobile && <Divider orientation="vertical" />}

        <SectionBidInfo
          amount={data.totalAmount}
          position={data.position}
          right={
            !!data.entityData ? (
              <Tooltip label="Support this model" position="top" withinPortal>
                <ActionIcon
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
                          covered: true,
                        })
                      : undefined
                  }
                >
                  <IconPlus size={16} />
                </ActionIcon>
              </Tooltip>
            ) : undefined
          }
          bottom={
            <Group noWrap spacing={4}>
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
  );
};
