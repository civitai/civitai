import {
  ActionIcon,
  Badge,
  Button,
  ButtonProps,
  Center,
  Checkbox,
  Divider,
  Group,
  HoverCard,
  Loader,
  Overlay,
  Paper,
  Stack,
  Text,
  TextInput,
  Title,
  Tooltip,
  useMantineTheme,
} from '@mantine/core';
import { DatePicker } from '@mantine/dates';
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconCalendar,
  IconChevronLeft,
  IconChevronRight,
  IconLayoutBottombarExpand,
  IconMoodSmile,
  IconPlugConnected,
  IconSearch,
  IconX,
} from '@tabler/icons-react';
import { clsx } from 'clsx';
import dayjs from 'dayjs';
import { useRouter } from 'next/router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useInView } from 'react-intersection-observer';
import { z } from 'zod';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { getModelTypesForAuction } from '~/components/Auction/auction.utils';
import { ModelPlacementCard } from '~/components/Auction/AuctionPlacementCard';
import { useAuctionContext } from '~/components/Auction/AuctionProvider';
import { AuctionViews, usePurchaseBid } from '~/components/Auction/AuctionUtils';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { CosmeticCard } from '~/components/CardTemplates/CosmeticCard';
import { Countdown } from '~/components/Countdown/Countdown';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { HelpButton } from '~/components/HelpButton/HelpButton';
import { ResourceSelect } from '~/components/ImageGeneration/GenerationForm/ResourceSelect';
import { useSignalContext } from '~/components/Signals/SignalsProvider';
import { useTourContext } from '~/components/Tours/ToursProvider';
import { useIsMobile } from '~/hooks/useIsMobile';
import { NumberInputWrapper } from '~/libs/form/components/NumberInputWrapper';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { constants } from '~/server/common/constants';
import { SignalTopic } from '~/server/common/enums';
import type { GetAuctionBySlugReturn } from '~/server/services/auction.service';
import type { GenerationResource } from '~/server/services/generation/generation.service';
import { baseModelResourceTypes } from '~/shared/constants/generation.constants';
import { AuctionType, Currency, ModelType } from '~/shared/utils/prisma/enums';
import { formatDate, stripTime } from '~/utils/date-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { asOrdinal } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';

const auctionQuerySchema = z.object({
  // slug: z.string().optional(),
  date: z.preprocess((val) => {
    if (Array.isArray(val)) val = val[0]; // Take only first
    // if (typeof val === 'string' || typeof val === 'number') return new Date(val);
    if (typeof val === 'string') return dayjs(val).startOf('day').toDate();
    return undefined;
  }, z.date().optional()),
});

const allCheckpointBaseModels = new Set(
  Object.values(baseModelResourceTypes)
    .flatMap((resources) =>
      resources
        .filter((resource) => resource.type === ModelType.Checkpoint)
        .map((resource) => resource.baseModels)
    )
    .flat()
) as Set<string>;

const QuickBid = ({
  label,
  onClick,
  children,
  ...buttonProps
}: ButtonProps & {
  label: string;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  children: React.ReactNode;
}) => {
  return (
    <Tooltip label={label} position="top" withinPortal>
      <Button
        variant="subtle"
        compact
        className="underline underline-offset-2"
        fz="xs"
        onClick={onClick}
        {...buttonProps}
      >
        {children}
      </Button>
    </Tooltip>
  );
};

export const AuctionTopSection = ({
  refreshFunc,
  showHistory = true,
  date,
}: {
  refreshFunc?: () => unknown;
  showHistory?: boolean;
  date?: Date;
}) => {
  const features = useFeatureFlags();
  const { runTour } = useTourContext();
  const { drawerToggle, selectedAuction } = useAuctionContext();
  const { connected, registeredTopics } = useSignalContext();
  const router = useRouter();
  const ref = useRef<HTMLInputElement>(null);

  const today = dayjs().startOf('day').toDate();

  // {/*<Group className="sticky top-0 right-0">*/}

  // TODO maybe get oldest dates for all auctions (or all valid dates), set minDate

  const navigateDate = (d: Date) => {
    const { date, ...queryRest } = router.query;
    router
      .push(
        {
          query: {
            ...queryRest,
            ...(d && d.getTime() !== today.getTime() ? { date: stripTime(d) } : undefined),
          },
        },
        undefined,
        { shallow: true }
      )
      .catch();
  };

  const minDate = new Date('2025-03-10');

  return (
    <Group position="apart" className="max-sm:justify-center">
      <Group position="left">
        {showHistory && (
          <Tooltip label="View History">
            <Group spacing={6}>
              <ActionIcon
                disabled={(date ?? today).getTime() <= minDate.getTime()}
                className="disabled:opacity-50"
                onClick={() => {
                  const d = dayjs(date ?? today)
                    .subtract(1, 'day')
                    .toDate();
                  navigateDate(d);
                }}
              >
                <IconChevronLeft size={18} />
              </ActionIcon>
              <DatePicker
                placeholder="View History"
                value={date}
                ref={ref}
                onChange={(v) => {
                  if (v !== date) {
                    const { date, ...queryRest } = router.query;
                    router
                      .push(
                        {
                          query: {
                            ...queryRest,
                            ...(v && v !== today ? { date: stripTime(v) } : undefined),
                          },
                        },
                        undefined,
                        { shallow: true }
                      )
                      .then(() => {
                        // nb: this is an incredibly stupid hack I have to do because mantine sucks
                        //     and won't update the value without a blur event
                        setTimeout(() => {
                          ref.current?.blur();
                        }, 1);
                      });
                  }
                }}
                minDate={minDate}
                maxDate={today}
                inputFormat={!date || date.getTime() === today.getTime() ? '[Today]' : undefined}
                classNames={{ input: 'text-center' }}
                radius="sm"
                icon={<IconCalendar size={14} />}
                w={165}
                size="xs"
              />
              <ActionIcon
                disabled={(date ?? today).getTime() >= today.getTime()}
                className="disabled:opacity-50"
                onClick={() => {
                  const d = dayjs(date ?? today)
                    .add(1, 'day')
                    .toDate();
                  navigateDate(d);
                }}
              >
                <IconChevronRight size={18} />
              </ActionIcon>
            </Group>
          </Tooltip>
        )}
      </Group>
      <Group position="right">
        {(!connected ||
          (selectedAuction?.id &&
            !registeredTopics.includes(`${SignalTopic.Auction}:${selectedAuction?.id}`))) && (
          <Tooltip label="Not connected. May not receive live updates.">
            <IconPlugConnected color="orangered" />
          </Tooltip>
        )}
        {features.appTour && (
          <HelpButton
            data-tour="auction:reset"
            tooltip="Need help? Start the tour!"
            onClick={() => {
              runTour({
                key: 'auction',
                step: 0,
                forceRun: true,
              });
            }}
          />
        )}
        <HoverCard withArrow width={380}>
          <HoverCard.Target>
            <Text color="dimmed">
              <IconMoodSmile />
            </Text>
          </HoverCard.Target>
          <HoverCard.Dropdown maw="100%">
            <Stack spacing="xs">
              <Text size="sm" align="center">
                Perks of Winning
              </Text>
              <Divider />
              {/* TODO change wording if more than just models */}
              <Stack>
                <Text size="sm">
                  <Badge mr="xs">Visibility</Badge>The model will be featured in all valid resource
                  selectors (generation, resource editing, etc.), and has a chance to be featured on
                  the front page (SFW only).
                </Text>
                <Text size="sm">
                  <Badge color="green" mr="xs">
                    Generation
                  </Badge>
                  Checkpoints will be enabled for use in generation.
                </Text>
              </Stack>
            </Stack>
          </HoverCard.Dropdown>
        </HoverCard>
        <AuctionViews />
        <Button
          className="md:hidden"
          onClick={drawerToggle}
          variant="default"
          data-tour="auction:nav"
        >
          <Group spacing={4}>
            <IconLayoutBottombarExpand size={18} />
            <Text>Auctions</Text>
          </Group>
        </Button>
        {!!refreshFunc && (
          <Button variant="light" onClick={() => refreshFunc()}>
            Refresh
          </Button>
        )}
      </Group>
    </Group>
  );
};

export const AuctionInfo = () => {
  const mobile = useIsMobile({ breakpoint: 'md' });
  const theme = useMantineTheme();
  const { ref: placeBidRef, inView: placeBidInView } = useInView();
  const router = useRouter();
  const { selectedAuction, selectedModel, validAuction, setSelectedModel } = useAuctionContext();

  const [searchText, setSearchText] = useState<string>('');
  const searchLower = searchText.toLowerCase();

  const parseResult = useMemo(() => {
    if (!router.isReady) return { date: undefined, hasError: false };
    const result = auctionQuerySchema.safeParse(router.query);
    if (result.success) return { date: result.data.date, hasError: false };
    return { date: undefined, hasError: true };
  }, [router.isReady, router.query]);

  const today = dayjs().startOf('day').toDate();
  const showParseError = useRef(true);
  const dateToUse = parseResult.hasError ? today : parseResult.date ?? today;
  const canBid = dateToUse.getTime() === today.getTime();

  const {
    data: auctionData,
    // isLoading: isLoadingAuctionData,
    isInitialLoading: isInitialLoadingAuctionData,
    isRefetching: isRefetchingAuctionData,
    isError: isErrorAuctionData,
    refetch: refetchAuction,
  } = trpc.auction.getBySlug.useQuery(
    { slug: selectedAuction?.auctionBase?.slug ?? '', date: dateToUse },
    { enabled: validAuction && !!selectedAuction?.auctionBase?.slug }
  );

  const isLoadingAuctionData = isInitialLoadingAuctionData || isRefetchingAuctionData;

  const [bidPrice, setBidPrice] = useState(auctionData?.minPrice);
  const [isRecurring, setIsRecurring] = useState(false);
  const [recurUntil, setRecurUntil] = useState<Date | 'forever'>('forever');

  const { handleBuy, createLoading } = usePurchaseBid();

  useEffect(() => {
    if (parseResult.hasError && showParseError.current) {
      showErrorNotification({
        error: new Error('The date provided is not valid. Defaulting to today.'),
      });
      showParseError.current = false;
    }
  }, [parseResult.hasError]);

  const hasSearchText = useCallback(
    (
      base: GetAuctionBySlugReturn['auctionBase'],
      d: GetAuctionBySlugReturn['bids'][number]['entityData']
    ) => {
      if (!searchLower || !searchLower.length) return true;
      if (base.type === AuctionType.Model) {
        return (
          (d?.name?.toLowerCase() ?? '').includes(searchLower) ||
          (d?.model?.name?.toLowerCase() ?? '').includes(searchLower) ||
          (d?.model?.user?.username?.toLowerCase() ?? '').includes(searchLower)
        );
      }
      return true;
    },
    [searchLower]
  );

  const bidsAbove = useMemo(
    () =>
      auctionData?.bids?.length
        ? auctionData.bids.filter(
            (b) => b.totalAmount >= auctionData.minPrice && b.position <= auctionData.quantity
          )
        : [],
    [auctionData]
  );
  const bidsBelow = useMemo(
    () =>
      auctionData?.bids?.length
        ? auctionData.bids.filter(
            (b) => b.totalAmount < auctionData.minPrice || b.position > auctionData.quantity
          )
        : [],
    [auctionData]
  );

  const filteredBidsAbove = useMemo(
    () =>
      bidsAbove.length > 0 && !!auctionData
        ? bidsAbove.filter((b) => hasSearchText(auctionData.auctionBase, b.entityData))
        : [],
    [auctionData, bidsAbove, hasSearchText]
  );
  const filteredBidsBelow = useMemo(
    () =>
      bidsBelow.length > 0 && !!auctionData
        ? bidsBelow.filter((b) => hasSearchText(auctionData.auctionBase, b.entityData))
        : [],
    [auctionData, bidsBelow, hasSearchText]
  );

  const getPosFromBid = (n: number) => {
    if (!auctionData) return -1;
    if (n < auctionData.minPrice) return -1;
    if (!bidsAbove.length) return 1;

    const bidAbove = bidsAbove.find((b) => n > b.totalAmount);
    if (bidAbove) return bidAbove.position;

    if (bidsAbove.length >= auctionData.quantity) return -1;

    return bidsAbove.length + 1;
  };
  const getPosStringFromBid = (n: number) => {
    const spot = getPosFromBid(n);
    if (spot === -1) return 'last';
    return asOrdinal(spot);
  };

  const validBid = !!bidPrice && bidPrice > 0 && !!selectedModel;
  const selectedModelBid = useMemo(
    () => auctionData?.bids?.find((b) => b.entityId === selectedModel?.id)?.totalAmount ?? 0,
    [auctionData?.bids, selectedModel?.id]
  );

  const addBidFn = (entity: GenerationResource) => {
    setSelectedModel(entity);

    if (!placeBidInView) {
      const elem = document.getElementById(`scroll-to-bid`);
      if (elem) elem.scrollIntoView({ behavior: 'smooth' });
    }
  };

  const validFor = auctionData
    ? dayjs(auctionData.validTo).diff(dayjs(auctionData.validFrom), 'day')
    : 'Unknown';

  const uniqueModelIds = useMemo(() => {
    if (!auctionData?.bids) return new Set<number>();
    return new Set(
      auctionData.bids
        .filter((b) => b.entityData?.id !== selectedModel?.id)
        .map((b) => b.entityData?.model?.id)
        .filter(isDefined)
    );
  }, [auctionData?.bids, selectedModel?.id]);

  const hasOtherVersions = selectedModel ? uniqueModelIds.has(selectedModel.model.id) : false;

  const checkpointUnavailable =
    selectedModel &&
    selectedModel.model.type === ModelType.Checkpoint &&
    !allCheckpointBaseModels.has(selectedModel.baseModel);

  return (
    <Stack w="100%" spacing="sm">
      <AuctionTopSection refreshFunc={refetchAuction} date={dateToUse} />
      {isErrorAuctionData ? (
        <Center>
          <AlertWithIcon icon={<IconAlertCircle />} color="red" iconColor="red">
            <Text>There was an error fetching the auction data. Please try again.</Text>
          </AlertWithIcon>
        </Center>
      ) : !validAuction ? (
        <Center>
          <AlertWithIcon icon={<IconAlertCircle />} color="yellow" iconColor="yellow">
            <Text>Invalid auction. Please select a valid one from the list.</Text>
          </AlertWithIcon>
        </Center>
      ) : (
        <Stack>
          <Title order={3}>{auctionData?.auctionBase?.name ?? 'Loading...'}</Title>
          {!!auctionData?.auctionBase?.description && (
            <Text size="md" color="dimmed" fs="italic">
              {auctionData.auctionBase.description}
            </Text>
          )}

          <Paper
            shadow="xs"
            radius="sm"
            w="fit-content"
            px="md"
            py="xs"
            className="w-full cursor-default bg-gray-0 dark:bg-dark-6"
            data-tour="auction:info"
          >
            <Group spacing="sm" className="max-md:justify-between max-md:gap-1">
              <Tooltip label={`Maximum # of entities that can win.`}>
                <Group spacing="sm" className="max-md:w-full">
                  <Badge className="max-md:w-[80px]">
                    <Text>Spots</Text>
                  </Badge>

                  {auctionData ? <Text>{auctionData.quantity}</Text> : <Loader variant="dots" />}
                </Group>
              </Tooltip>

              <Divider orientation="vertical" />

              <Tooltip label={`Minimum Buzz cost to place.`}>
                <Group spacing="sm" className="max-md:w-full">
                  <Badge className="max-md:w-[80px]">
                    <Text>Min ⚡</Text>
                  </Badge>

                  {auctionData ? (
                    <Text>{auctionData.minPrice.toLocaleString()}</Text>
                  ) : (
                    <Loader variant="dots" />
                  )}
                </Group>
              </Tooltip>

              <Divider orientation="vertical" />

              <Tooltip
                label={
                  auctionData ? (
                    <Stack spacing={4} align="end">
                      <Text>Winning resources will be featured:</Text>
                      <Text>
                        From: {formatDate(auctionData.validFrom, 'MMM DD, YYYY h:mm:ss a')}
                      </Text>
                      <Text>To: {formatDate(auctionData.validTo, 'MMM DD, YYYY h:mm:ss a')}</Text>
                    </Stack>
                  ) : undefined
                }
              >
                <Group spacing="sm" className="max-md:w-full">
                  <Badge className="max-md:w-[80px]">
                    <Text>Featured</Text>
                  </Badge>

                  {auctionData ? (
                    <Text>
                      For {validFor} day{validFor !== 1 ? 's' : ''}
                    </Text>
                  ) : (
                    <Loader variant="dots" />
                  )}
                </Group>
              </Tooltip>

              <Divider orientation="vertical" />

              <Tooltip
                label={
                  auctionData ? (
                    <Stack spacing={4} align="end">
                      <Text>
                        Start: {formatDate(auctionData.startAt, 'MMM DD, YYYY h:mm:ss a')}
                      </Text>
                      <Text>End: {formatDate(auctionData.endAt, 'MMM DD, YYYY h:mm:ss a')}</Text>
                    </Stack>
                  ) : undefined
                }
              >
                <Group spacing="sm" className="max-md:w-full">
                  <Badge className="max-md:w-[80px]">
                    <Text>Ends In</Text>
                  </Badge>

                  {auctionData ? (
                    <Countdown
                      endTime={auctionData.endAt}
                      refreshIntervalMs={1000}
                      format={mobile ? 'short' : 'long'}
                    />
                  ) : (
                    <Loader variant="dots" />
                  )}
                </Group>
              </Tooltip>
            </Group>
          </Paper>

          <Divider ref={placeBidRef} id="scroll-to-bid" />

          {/* Place Bid */}
          <Stack pos="relative">
            <Title order={5}>Place Bid</Title>
            {!canBid && (
              <>
                <Overlay
                  blur={1}
                  zIndex={11}
                  color={theme.colorScheme === 'dark' ? theme.colors.dark[7] : '#fff'}
                  opacity={0.85}
                />
                <Stack
                  align="center"
                  justify="center"
                  spacing={2}
                  className="absolute inset-x-0 z-20 m-auto h-full"
                >
                  <Text weight={500}>Cannot bid on a past auction.</Text>
                </Stack>
              </>
            )}
            <CosmeticCard data-tour="auction:bid" className="relative">
              <Group m="sm" className="max-md:flex-col md:flex-nowrap">
                {/* TODO handle other auction types */}
                <ResourceSelect
                  buttonLabel="Select model"
                  options={{
                    resources: getModelTypesForAuction(auctionData?.auctionBase),
                  }}
                  allowRemove={false}
                  selectSource="auction"
                  value={selectedModel}
                  onChange={(gVal) => {
                    if (gVal) {
                      setSelectedModel(gVal);
                    }
                  }}
                  sx={{
                    flexGrow: 1,
                    justifyItems: 'center',
                    display: 'grid', // for firefox
                  }}
                  buttonProps={{
                    fullWidth: mobile,
                  }}
                  groupPosition={!mobile ? 'left' : 'apart'}
                  showAsCheckpoint
                />

                {!mobile && <Divider orientation="vertical" />}

                <Stack spacing={4} className="max-md:w-full">
                  <Group position="apart">
                    <Text size="xs">Bid:</Text>
                    <Group spacing={4} position="right">
                      <QuickBid
                        label="Bid for the top spot"
                        disabled={
                          !!selectedModel?.id && selectedModel.id === bidsAbove?.[0]?.entityId
                        }
                        onClick={() => {
                          const topBid = Math.max(
                            1,
                            (bidsAbove?.[0]?.totalAmount ??
                              (auctionData ? auctionData.minPrice - 1 : 0)) -
                              selectedModelBid +
                              1
                          );
                          setBidPrice(topBid);
                        }}
                      >
                        {asOrdinal(1)}
                      </QuickBid>
                      <QuickBid
                        label="Bid for the last spot"
                        disabled={
                          !!selectedModel?.id &&
                          bidsAbove.map((b) => b.entityId).includes(selectedModel.id)
                        }
                        onClick={() => {
                          const topBid =
                            bidsAbove.length > 0
                              ? bidsAbove.length >= (auctionData?.quantity ?? 1)
                                ? bidsAbove[bidsAbove.length - 1].totalAmount + 1
                                : auctionData?.minPrice ?? 1
                              : auctionData?.minPrice ?? 1;
                          const requiredBid = topBid - selectedModelBid;
                          setBidPrice(requiredBid);
                        }}
                      >
                        Last
                      </QuickBid>
                      <QuickBid
                        label={`Add ${(10000).toLocaleString()} Buzz`}
                        onClick={() => {
                          setBidPrice((old) => (old ?? 0) + 10000);
                        }}
                      >
                        {`+10k`}
                      </QuickBid>
                    </Group>
                  </Group>
                  <NumberInputWrapper
                    // label="Buzz"
                    // labelProps={{ sx: { fontSize: 12, fontWeight: 590 } }}
                    placeholder="Enter Buzz..."
                    icon={<CurrencyIcon currency={Currency.BUZZ} size={18} />}
                    value={bidPrice}
                    min={1}
                    max={constants.buzz.maxChargeAmount}
                    onChange={(value) => {
                      setBidPrice(value);
                    }}
                    step={100}
                    w={!mobile ? 170 : undefined}
                  />
                </Stack>

                <BuzzTransactionButton
                  loading={createLoading}
                  disabled={!validBid || createLoading}
                  label={'Bid'}
                  buzzAmount={bidPrice ?? 0}
                  transactionType="Default"
                  onPerformTransaction={() =>
                    handleBuy({
                      bidPrice,
                      auctionId: selectedAuction?.id,
                      modelId: selectedModel?.id,
                      isRecurring,
                      recurUntil,
                    })
                  }
                  data-testid="place-bid-button"
                  // error={hasIssue ? 'Error computing cost' : undefined}
                  className={clsx('text-center max-md:w-full md:h-full md:w-[160px]', {
                    'animate-[wiggle_1.5s_ease-in-out_4.5]': validBid,
                  })}
                  size="md"
                  priceReplacement={
                    bidPrice && getPosFromBid(selectedModelBid + bidPrice) !== -1 ? (
                      <Tooltip
                        label={
                          validBid
                            ? `Bidding ${bidPrice.toLocaleString()} ⚡ will currently feature this model in the ~${getPosStringFromBid(
                                selectedModelBid + bidPrice
                              )} spot.`
                            : undefined
                        }
                        withinPortal
                      >
                        <Badge
                          variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
                          color={
                            validBid ? (theme.colorScheme === 'dark' ? 'gray' : 'gray.8') : 'dark'
                          }
                          radius="xl"
                          pl={8}
                          pr={12}
                        >
                          <Text>{`Est: ${
                            bidPrice ? getPosStringFromBid(selectedModelBid + bidPrice) : '?'
                          }`}</Text>
                        </Badge>
                      </Tooltip>
                    ) : (
                      <></>
                    )
                  }
                />
              </Group>
            </CosmeticCard>
            <Group position="right" align="center" spacing={8}>
              <Checkbox
                label="Make this recurring until:"
                size="xs"
                checked={isRecurring}
                onChange={(e) => {
                  setIsRecurring(e.target.checked);
                }}
              />
              <DatePicker
                placeholder="Forever"
                value={recurUntil === 'forever' ? null : recurUntil}
                onChange={(date) => {
                  if (date) setIsRecurring(true);
                  setRecurUntil(date ?? 'forever');
                }}
                minDate={dayjs().add(1, 'day').toDate()}
                radius="sm"
                icon={<IconCalendar size={14} />}
                w={165}
                size="xs"
              />
            </Group>
            {hasOtherVersions && (
              <AlertWithIcon
                icon={<IconAlertTriangle size={16} />}
                color="yellow"
                iconColor="yellow"
              >
                There are other versions of this model with active bids. Resource selectors will
                only show the top-level model.
              </AlertWithIcon>
            )}
            {checkpointUnavailable && (
              <AlertWithIcon
                icon={<IconAlertTriangle size={16} />}
                color="yellow"
                iconColor="yellow"
              >
                This checkpoint type ({selectedModel.baseModel}) is unavailable in the generator,
                but can still be featured.
              </AlertWithIcon>
            )}
          </Stack>

          <Divider />

          {/* View bids */}
          <Group position="apart">
            <Title order={5} data-tour="auction:bid-results">
              Active Bids
            </Title>
            <TextInput
              icon={<IconSearch size={16} />}
              placeholder="Filter items..."
              value={searchText}
              maxLength={150}
              disabled={!auctionData?.bids || auctionData.bids.length === 0}
              onChange={(event) => setSearchText(event.currentTarget.value)}
              rightSection={
                <ActionIcon onClick={() => setSearchText('')} disabled={!searchText.length}>
                  <IconX size={16} />
                </ActionIcon>
              }
            />
          </Group>
          {isLoadingAuctionData ? (
            <Center my="lg">
              <Loader />
            </Center>
          ) : !auctionData ? (
            <Center my="lg">
              <Text>Nothing here</Text>
            </Center>
          ) : !auctionData.bids.length ? (
            <Center>
              <Text>No bids yet. Be the first!</Text>
            </Center>
          ) : (
            <Stack>
              {filteredBidsAbove.length ? (
                filteredBidsAbove.map((b) => (
                  <ModelPlacementCard
                    key={b.entityId}
                    data={b}
                    aboveThreshold={true}
                    addBidFn={addBidFn}
                    searchText={searchText}
                    canBid={canBid}
                  />
                ))
              ) : (
                <Center>
                  <Text>No bids meeting minimum threshold.</Text>
                </Center>
              )}
              {filteredBidsBelow.length > 0 && (
                <>
                  <Divider label="Below Threshold" labelPosition="center" />
                  {filteredBidsBelow.map((b) => (
                    <ModelPlacementCard
                      key={b.entityId}
                      data={b}
                      aboveThreshold={false}
                      addBidFn={addBidFn}
                      searchText={searchText}
                      canBid={canBid}
                    />
                  ))}
                </>
              )}
            </Stack>
          )}
        </Stack>
      )}
    </Stack>
  );
};
