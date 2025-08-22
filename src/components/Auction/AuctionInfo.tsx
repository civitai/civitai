import type { ButtonProps } from '@mantine/core';
import {
  Badge,
  Button,
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
  useComputedColorScheme,
  useMantineTheme,
} from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
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
import dayjs from '~/shared/utils/dayjs';
import { useRouter } from 'next/router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useInView } from 'react-intersection-observer';
import * as z from 'zod';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { getModelTypesForAuction } from '~/components/Auction/auction.utils';
import { AuctionFiltersDropdown } from '~/components/Auction/AuctionFiltersDropdown';
import { ModelPlacementCard } from '~/components/Auction/AuctionPlacementCard';
import { useAuctionContext } from '~/components/Auction/AuctionProvider';
import { AuctionViews, usePurchaseBid } from '~/components/Auction/AuctionUtils';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { CosmeticCard } from '~/components/CardTemplates/CosmeticCard';
import { Countdown } from '~/components/Countdown/Countdown';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { HelpButton } from '~/components/HelpButton/HelpButton';
import { ResourceSelect } from '~/components/ImageGeneration/GenerationForm/ResourceSelect';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { useSignalContext } from '~/components/Signals/SignalsProvider';
import { useTourContext } from '~/components/Tours/ToursProvider';
import { useIsMobile } from '~/hooks/useIsMobile';
import { NumberInputWrapper } from '~/libs/form/components/NumberInputWrapper';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useFiltersContext } from '~/providers/FiltersProvider';
import type { BaseModel } from '~/shared/constants/base-model.constants';
import { constants } from '~/server/common/constants';
import { SignalTopic } from '~/server/common/enums';
import type { GetAuctionBySlugReturn } from '~/server/services/auction.service';
import type { GenerationResource } from '~/server/services/generation/generation.service';
import { getBaseModelGenerationConfig } from '~/shared/constants/base-model.constants';
import { AuctionType, Currency, ModelType } from '~/shared/utils/prisma/enums';
import { formatDate } from '~/utils/date-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { asOrdinal } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';

const auctionQuerySchema = z.object({ d: z.coerce.number().max(0).optional() });
type AuctionQuerySchema = z.infer<typeof auctionQuerySchema>;

const allCheckpointBaseModels = new Set(
  getBaseModelGenerationConfig().flatMap(({ supportMap }) =>
    (supportMap.get(ModelType.Checkpoint) ?? []).map((x) => x.baseModel)
  )
);

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
        size="compact-sm"
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
  d,
}:
  | {
      showHistory: true;
      d: number;
      refreshFunc: () => unknown;
    }
  | {
      showHistory: false;
      d?: undefined;
      refreshFunc?: () => unknown;
    }) => {
  const features = useFeatureFlags();
  const { runTour } = useTourContext();
  const { drawerToggle, selectedAuction } = useAuctionContext();
  const { connected, registeredTopics } = useSignalContext();
  const router = useRouter();
  const ref = useRef<HTMLButtonElement>(null);

  const realD = d ?? 0;
  const today = dayjs.utc();
  const dToDayjs = today.add(realD, 'day');
  const dToDate = dToDayjs.toDate();

  // TODO maybe get oldest dates for all auctions (or all valid dates), set minDate
  const minDate = dayjs.utc('2025-03-10');

  const navigateDate = (newD: number) => {
    const { d: currentD, ...queryRest } = router.query as AuctionQuerySchema;
    return router.push(
      {
        query: {
          ...queryRest,
          ...(currentD !== newD && newD < 0 ? { d: newD } : undefined),
        },
      },
      undefined,
      { shallow: true }
    );
  };

  // {/*<Group className="sticky top-0 right-0">*/}

  return (
    <Group justify="space-between" className="max-sm:justify-center">
      <Group justify="flex-end">
        {showHistory && (
          <Tooltip label="View History">
            <Group gap={6}>
              <LegacyActionIcon
                variant="subtle"
                color="gray"
                disabled={dToDayjs.valueOf() <= minDate.valueOf()}
                className="disabled:opacity-50"
                onClick={() => {
                  navigateDate(realD - 1).catch();
                }}
              >
                <IconChevronLeft size={18} />
              </LegacyActionIcon>
              <DatePickerInput
                placeholder="View History"
                value={dToDate}
                ref={ref}
                onChange={(v) => {
                  const desired = !v ? 0 : dayjs.utc(v).diff(today, 'day');
                  navigateDate(desired).then(() => {
                    // nb: this is an incredibly stupid hack I have to do because mantine sucks
                    //     and won't update the value without a blur event
                    setTimeout(() => {
                      ref.current?.blur();
                    }, 1);
                  });
                }}
                minDate={minDate.toDate()}
                maxDate={today.toDate()}
                valueFormat={realD === 0 ? '[Today]' : undefined}
                classNames={{ input: 'text-center' }}
                radius="sm"
                leftSection={<IconCalendar size={14} />}
                w={165}
                size="xs"
                clearable
              />
              <LegacyActionIcon
                variant="subtle"
                color="gray"
                disabled={realD >= 0}
                className="disabled:opacity-50"
                onClick={() => {
                  navigateDate(realD + 1).catch();
                }}
              >
                <IconChevronRight size={18} />
              </LegacyActionIcon>
            </Group>
          </Tooltip>
        )}
      </Group>
      <Group justify="flex-end" className="max-sm:justify-center">
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
            <Text c="dimmed">
              <IconMoodSmile />
            </Text>
          </HoverCard.Target>
          <HoverCard.Dropdown maw="100%">
            <Stack gap="xs">
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
          <Group gap={4}>
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
  const colorScheme = useComputedColorScheme('dark');
  const { ref: placeBidRef, inView: placeBidInView } = useInView();
  const router = useRouter();
  const { selectedAuction, selectedModel, validAuction, setSelectedModel } = useAuctionContext();
  const { baseModels } = useFiltersContext((state) => state.auctions);

  const [searchText, setSearchText] = useState<string>('');
  const searchLower = searchText.toLowerCase();

  const parseResult = useMemo(() => {
    if (!router.isReady) return { d: undefined, hasError: false };
    const result = auctionQuerySchema.safeParse(router.query);
    if (result.success) {
      return { d: result.data.d, hasError: false };
    }
    return { d: undefined, hasError: true };
  }, [router.isReady, router.query]);

  const showParseError = useRef(true);
  const d = parseResult.hasError ? 0 : parseResult.d ?? 0;
  const canBid = d === 0;

  const {
    data: auctionData,
    // isLoading: isLoadingAuctionData,
    isInitialLoading: isInitialLoadingAuctionData,
    isRefetching: isRefetchingAuctionData,
    isError: isErrorAuctionData,
    refetch: refetchAuction,
  } = trpc.auction.getBySlug.useQuery(
    { slug: selectedAuction?.auctionBase?.slug ?? '', d },
    { enabled: validAuction && !!selectedAuction?.auctionBase?.slug }
  );

  const isLoadingAuctionData = isInitialLoadingAuctionData || isRefetchingAuctionData;
  const isCheckpointAuction = selectedAuction?.auctionBase?.slug === 'featured-checkpoints';

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

  const hasBaseModel = useCallback(
    (
      base: GetAuctionBySlugReturn['auctionBase'],
      d: GetAuctionBySlugReturn['bids'][number]['entityData']
    ) => {
      if (base.type === AuctionType.Model) {
        if (!baseModels || !baseModels.length) return true;
        if (!d?.baseModel) return false;
        return baseModels.includes(d.baseModel as BaseModel);
      }
      return true;
    },
    [baseModels]
  );

  const existingBaseModels = useMemo(
    () =>
      auctionData?.bids?.length
        ? [
            ...new Set(
              auctionData.bids
                .map((b) => b.entityData?.baseModel as BaseModel | undefined)
                .filter(isDefined)
            ),
          ]
        : ([] as BaseModel[]),
    [auctionData?.bids]
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
        ? bidsAbove.filter(
            (b) =>
              hasSearchText(auctionData.auctionBase, b.entityData) &&
              hasBaseModel(auctionData.auctionBase, b.entityData)
          )
        : [],
    [auctionData, bidsAbove, hasBaseModel, hasSearchText]
  );
  const filteredBidsBelow = useMemo(
    () =>
      bidsBelow.length > 0 && !!auctionData
        ? bidsBelow.filter(
            (b) =>
              hasSearchText(auctionData.auctionBase, b.entityData) &&
              hasBaseModel(auctionData.auctionBase, b.entityData)
          )
        : [],
    [auctionData, bidsBelow, hasBaseModel, hasSearchText]
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
    !allCheckpointBaseModels.has(selectedModel.baseModel as BaseModel);

  return (
    <Stack w="100%" gap="sm">
      <AuctionTopSection showHistory={true} refreshFunc={refetchAuction} d={d} />
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
            <Text size="md" c="dimmed" fs="italic">
              {auctionData.auctionBase.description}
            </Text>
          )}

          <Paper
            shadow="xs"
            radius="sm"
            className="w-full cursor-default bg-gray-0 px-4 py-2.5 dark:bg-dark-6"
            data-tour="auction:info"
          >
            <Group gap="sm" className="max-md:justify-between max-md:gap-1">
              <Tooltip label={`Maximum # of entities that can win.`}>
                <Group gap="sm" className="max-md:w-full">
                  <Badge className="max-md:w-[80px]">Spots</Badge>

                  {auctionData ? <Text>{auctionData.quantity}</Text> : <Loader type="dots" />}
                </Group>
              </Tooltip>

              <Divider orientation="vertical" />

              <Tooltip label={`Minimum Buzz cost to place.`}>
                <Group gap="sm" className="max-md:w-full">
                  <Badge className="max-md:w-[80px]">Min ⚡</Badge>

                  {auctionData ? (
                    <Text>{auctionData.minPrice.toLocaleString()}</Text>
                  ) : (
                    <Loader type="dots" />
                  )}
                </Group>
              </Tooltip>

              <Divider orientation="vertical" />

              <Tooltip
                label={
                  auctionData ? (
                    <Stack gap={4} align="end">
                      <Text>Winning resources will be featured:</Text>
                      <Text>
                        From: {formatDate(auctionData.validFrom, 'MMM DD, YYYY h:mm:ss a')}
                      </Text>
                      <Text>To: {formatDate(auctionData.validTo, 'MMM DD, YYYY h:mm:ss a')}</Text>
                    </Stack>
                  ) : undefined
                }
              >
                <Group gap="sm" className="max-md:w-full">
                  <Badge className="max-md:w-[80px]">Featured</Badge>

                  {auctionData ? (
                    <Text>
                      For {validFor} day{validFor !== 1 ? 's' : ''}
                    </Text>
                  ) : (
                    <Loader type="dots" />
                  )}
                </Group>
              </Tooltip>

              <Divider orientation="vertical" />

              <Tooltip
                label={
                  auctionData ? (
                    <Stack gap={4} align="end">
                      <Text>
                        Start: {formatDate(auctionData.startAt, 'MMM DD, YYYY h:mm:ss a')}
                      </Text>
                      <Text>End: {formatDate(auctionData.endAt, 'MMM DD, YYYY h:mm:ss a')}</Text>
                    </Stack>
                  ) : undefined
                }
              >
                <Group gap="sm" className="max-md:w-full">
                  <Badge className="max-md:w-[80px]">Ends In</Badge>

                  {auctionData ? (
                    <Countdown
                      endTime={auctionData.endAt}
                      refreshIntervalMs={1000}
                      format={mobile ? 'short' : 'long'}
                    />
                  ) : (
                    <Loader type="dots" />
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
                  color={colorScheme === 'dark' ? theme.colors.dark[7] : '#fff'}
                  opacity={0.85}
                />
                <Stack
                  align="center"
                  justify="center"
                  gap={2}
                  className="absolute inset-x-0 z-20 m-auto h-full"
                >
                  <Text fw={500}>Cannot bid on a past auction.</Text>
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
                  style={{
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

                <Stack gap={4} className="max-md:w-full">
                  <Group justify="space-between">
                    <Text size="xs">Bid:</Text>
                    <Group gap={4} justify="flex-end">
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
                    leftSection={<CurrencyIcon currency={Currency.BUZZ} size={18} />}
                    value={bidPrice}
                    min={1}
                    max={constants.buzz.maxChargeAmount}
                    onChange={(value) => {
                      setBidPrice(value ? Number(value) : undefined);
                    }}
                    step={100}
                    w={!mobile ? 170 : undefined}
                  />
                </Stack>

                <BuzzTransactionButton
                  loading={createLoading}
                  disabled={!validBid || createLoading}
                  label="Bid"
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
                  className={clsx('text-center max-md:w-full md:h-full md:w-[165px]', {
                    'animate-[wiggle_1.5s_ease-in-out_4.5]': validBid,
                  })}
                  classNames={{ label: 'flex gap-2 items-center justify-center' }}
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
                          variant={colorScheme === 'dark' ? 'filled' : 'light'}
                          color={validBid ? (colorScheme === 'dark' ? 'gray' : 'gray.8') : 'dark'}
                          radius="xl"
                        >
                          <Text fz={11}>{`Est: ${
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
            <Group justify="flex-end" align="center" gap={8}>
              <Checkbox
                label="Make this recurring until:"
                size="xs"
                checked={isRecurring}
                onChange={(e) => {
                  setIsRecurring(e.target.checked);
                }}
              />
              <DatePickerInput
                placeholder="Forever"
                value={recurUntil === 'forever' ? null : recurUntil}
                onChange={(date) => {
                  if (date) setIsRecurring(true);
                  setRecurUntil(date ?? 'forever');
                }}
                minDate={dayjs().add(1, 'day').toDate()}
                radius="sm"
                leftSection={<IconCalendar size={14} />}
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
          <Group justify="space-between">
            <Title order={5} data-tour="auction:bid-results">
              Active Bids
            </Title>
            <Group
              gap="xs"
              justify="space-between"
              className={
                isCheckpointAuction && auctionData?.auctionBase?.type === AuctionType.Model
                  ? 'max-xs:w-full'
                  : ''
              }
            >
              <TextInput
                leftSection={<IconSearch size={16} />}
                placeholder="Search items..."
                value={searchText}
                maxLength={150}
                className="grow"
                disabled={!auctionData?.bids || auctionData.bids.length === 0}
                onChange={(event) => setSearchText(event.currentTarget.value)}
                rightSection={
                  <LegacyActionIcon onClick={() => setSearchText('')} disabled={!searchText.length}>
                    <IconX size={16} />
                  </LegacyActionIcon>
                }
              />
              {isCheckpointAuction && auctionData?.auctionBase?.type === AuctionType.Model && (
                <AuctionFiltersDropdown baseModels={existingBaseModels} />
              )}
            </Group>
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
