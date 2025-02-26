import {
  Badge,
  Button,
  ButtonProps,
  Center,
  Checkbox,
  Divider,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  Title,
  Tooltip,
  useMantineTheme,
} from '@mantine/core';
import { DatePicker } from '@mantine/dates';
import { IconAlertCircle, IconCalendar, IconLayoutSidebarLeftExpand } from '@tabler/icons-react';
import dayjs from 'dayjs';
import React, { useMemo, useState } from 'react';
import { useInView } from 'react-intersection-observer';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { ModelPlacementCard } from '~/components/Auction/AuctionPlacementCard';
import { useAuctionContext } from '~/components/Auction/AuctionProvider';
import { geModelTypesForAuction, usePurchaseBid } from '~/components/Auction/auctionUtils';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { CosmeticCard } from '~/components/CardTemplates/CosmeticCard';
import { Countdown } from '~/components/Countdown/Countdown';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { ResourceSelect } from '~/components/ImageGeneration/GenerationForm/ResourceSelect';
import { useIsMobile } from '~/hooks/useIsMobile';
import { NumberInputWrapper } from '~/libs/form/components/NumberInputWrapper';
import { constants } from '~/server/common/constants';
import type { GenerationResource } from '~/server/services/generation/generation.service';
import { Currency } from '~/shared/utils/prisma/enums';
import { formatDate } from '~/utils/date-helpers';
import { asOrdinal } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

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

export const AuctionInfo = () => {
  const mobile = useIsMobile();
  const theme = useMantineTheme();
  // const placeBidRef = useRef<HTMLDivElement>(null);
  const { ref: placeBidRef, inView: placeBidInView } = useInView();
  const { selectedAuction, selectedModel, validAuction, setSelectedModel, drawerToggle } =
    useAuctionContext();

  const {
    data: auctionData,
    // isLoading: isLoadingAuctionData,
    isInitialLoading: isInitialLoadingAuctionData,
    isRefetching: isRefetchingAuctionData,
    isError: isErrorAuctionData,
    refetch: refetchAuction,
  } = trpc.auction.getBySlug.useQuery(
    { slug: selectedAuction?.auctionBase?.slug ?? '' },
    { enabled: validAuction && !!selectedAuction?.auctionBase?.slug }
  );

  const isLoadingAuctionData = isInitialLoadingAuctionData || isRefetchingAuctionData;

  const [bidPrice, setBidPrice] = useState(auctionData?.minPrice);
  const [isRecurring, setIsRecurring] = useState(false);
  const [recurUntil, setRecurUntil] = useState<Date | 'forever'>('forever');

  const { handleBuy, createLoading } = usePurchaseBid();

  const bidsAbove = auctionData?.bids?.length
    ? auctionData.bids.filter((b) => b.totalAmount >= auctionData.minPrice)
    : [];
  const bidsBelow = auctionData?.bids?.length
    ? auctionData.bids.filter((b) => b.totalAmount < auctionData.minPrice)
    : [];

  const getPosFromBid = (n: number) => {
    return !auctionData?.bids?.length
      ? 1
      : auctionData.bids.find((b) => n > b.totalAmount)?.position ?? -1;
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

  return (
    <Stack w="100%" spacing="sm">
      {/*<Group className="sticky top-0 right-0">*/}
      <Group position="right">
        <Button className="sm:hidden" onClick={drawerToggle} variant="default">
          <Group spacing={4}>
            <IconLayoutSidebarLeftExpand />
            All Auctions
          </Group>
        </Button>
        <Button onClick={() => refetchAuction()}>Refresh</Button>
      </Group>
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

          <Paper
            shadow="xs"
            radius="sm"
            w="fit-content"
            px="md"
            py="xs"
            className="cursor-default bg-gray-0 dark:bg-dark-6"
          >
            <Group spacing="sm" className="max-sm:justify-between max-sm:gap-1">
              <Group spacing="sm" className="max-sm:w-full">
                <Badge w={70}>
                  <Text>Spots</Text>
                </Badge>

                {auctionData ? <Text>{auctionData.quantity}</Text> : <Loader variant="dots" />}
              </Group>

              <Divider orientation="vertical" />

              <Tooltip label={`Minimum buzz cost to place.`}>
                <Group spacing="sm" className="max-sm:w-full">
                  <Badge w={70}>
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
                      <Text>
                        Start: {formatDate(auctionData.startAt, 'MMM DD, YYYY h:mm:ss a')}
                      </Text>
                      <Text>End: {formatDate(auctionData.endAt, 'MMM DD, YYYY h:mm:ss a')}</Text>
                    </Stack>
                  ) : undefined
                }
              >
                <Group spacing="sm" className="max-sm:w-full">
                  <Badge w={70}>
                    <Text>Ends In</Text>
                    {/* todo does this say ended when its over? */}
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
          <Stack>
            <Title order={5}>Place Bid</Title>
            <CosmeticCard>
              <Group m="sm" className="max-sm:flex-col">
                {/* TODO handle other auction types */}
                <ResourceSelect
                  buttonLabel="Select model"
                  options={{
                    resources: geModelTypesForAuction(auctionData?.auctionBase),
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
                  }}
                  buttonProps={{
                    fullWidth: mobile,
                  }}
                  groupPosition={!mobile ? 'left' : 'apart'}
                />

                {!mobile && <Divider orientation="vertical" />}

                <Stack spacing={4} className="max-sm:w-full">
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
                        onClick={() => {
                          const topBid =
                            bidsAbove.length > 0
                              ? bidsAbove.length >= (auctionData?.quantity ?? 1)
                                ? bidsAbove[bidsAbove.length - 1].totalAmount + 1
                                : auctionData?.minPrice ?? 1
                              : auctionData?.minPrice ?? 1;
                          setBidPrice(topBid);
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
                  // error={hasIssue ? 'Error computing cost' : undefined}
                  className={validBid ? 'animate-[wiggle_1.5s_ease-in-out_4.5]' : ''}
                  size="md"
                  priceReplacement={
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
          </Stack>

          <Divider />

          {/* View bids */}
          <Title order={5}>Active Bids</Title>
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
              {bidsAbove.length ? (
                bidsAbove.map((b) => (
                  <ModelPlacementCard key={b.entityId} data={b} addBidFn={addBidFn} />
                ))
              ) : (
                <Center>
                  <Text>No bids meeting minimum threshold.</Text>
                </Center>
              )}
              {bidsBelow.length > 0 && (
                <>
                  <Divider label="Below Threshold" labelPosition="center" />
                  {bidsBelow.map((b) => (
                    <ModelPlacementCard key={b.entityId} data={b} addBidFn={addBidFn} />
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
