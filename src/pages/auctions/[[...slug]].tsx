import type { MantineSize } from '@mantine/core';
import {
  Box,
  Container,
  Divider,
  Drawer,
  Group,
  NavLink,
  Skeleton,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import type { InferGetServerSidePropsType } from 'next';
import { usePathname } from 'next/navigation';
import { useRouter } from 'next/router';
import React, { useEffect } from 'react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { AuctionInfo } from '~/components/Auction/AuctionInfo';
import { AuctionMyBids } from '~/components/Auction/AuctionMyBids';
import { MY_BIDS, useAuctionContext } from '~/components/Auction/AuctionProvider';
import { useAuctionTopicListener } from '~/components/Auction/AuctionUtils';
import { ContainerGrid2 } from '~/components/ContainerGrid/ContainerGrid';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { Meta } from '~/components/Meta/Meta';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';
import { useTourContext } from '~/components/Tours/ToursProvider';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { getAuctionNameBySlug } from '~/server/services/auction.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { trpc } from '~/utils/trpc';

type AuctionQueryData = {
  slug?: string[];
  d?: string | string[];
};

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features, ctx, session }) => {
    if (!features?.auctions) return { notFound: true };

    const { slug } = ctx.query as AuctionQueryData;
    if (slug?.[0] === MY_BIDS && !session) {
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.resolvedUrl }),
          permanent: false,
        },
      };
    }

    // Only the name, so link unfurls carry the auction. Everything the page renders is
    // fetched client-side.
    const auctionName =
      slug?.[0] && slug[0] !== MY_BIDS ? await getAuctionNameBySlug(slug[0]) : null;

    return { props: { auctionName } };
  },
});

export default function Auctions({
  auctionName,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const router = useRouter();
  const { slug: initialSlug } = router.query as AuctionQueryData;
  const slug = initialSlug && initialSlug.length ? initialSlug[0] : undefined;
  const {
    selectedAuction,
    setSelectedAuction,
    validAuction,
    setValidAuction,
    chooseAuction,
    drawerClose,
    drawerIsOpen,
  } = useAuctionContext();
  const pathname = usePathname();
  const { runTour, running } = useTourContext();
  const isMobile = useIsMobile({ breakpoint: 'md' });
  const features = useFeatureFlags();
  useAuctionTopicListener(selectedAuction?.id);

  const {
    data: auctions = [],
    isLoading: isLoadingAuctions,
    isError: isErrorAuctions,
  } = trpc.auction.getAll.useQuery();

  const getDocTitle = () => {
    const name = selectedAuction?.auctionBase?.name ?? auctionName;
    return `Auction${slug === MY_BIDS ? ': My Bids' : name ? `: ${name}` : 's'} | Civitai`;
  };

  // TODO fix hitting /auctions when none are available
  useEffect(() => {
    const selected = !!slug
      ? slug === MY_BIDS
        ? undefined
        : auctions.find((a) => a.auctionBase.slug === slug)
      : auctions[0];
    if (selectedAuction?.id !== selected?.id) {
      setSelectedAuction(selected);
    }
    document.title = getDocTitle();
  }, [slug, auctions.length]);

  // A slug that matches no active auction is only knowable once the list has loaded.
  // Derived rather than latched: the set of active slugs turns over daily without the
  // count changing, and getAll is cached for 30s, so a freshly-opened auction can be
  // absent from the first response and present in the next one.
  const isValidSlug =
    isLoadingAuctions ||
    isErrorAuctions ||
    !slug ||
    slug === MY_BIDS ||
    auctions.some((a) => a.auctionBase.slug === slug);

  useEffect(() => {
    if (isValidSlug !== validAuction) setValidAuction(isValidSlug);
  }, [isValidSlug, validAuction, setValidAuction]);

  useEffect(() => {
    if (!running) runTour({ key: 'auction', step: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const navLinks = (itemSize?: MantineSize) => (
    <Stack>
      <NavLink
        p={itemSize}
        label={
          <Text fw={500} inherit>
            My Bids
          </Text>
        }
        onClick={() => {
          chooseAuction(undefined);
        }}
        active={slug === MY_BIDS}
        className={
          'hover:border-r-2 hover:border-solid hover:border-r-gray-4 data-[active]:border-r-2 data-[active]:border-solid data-[active]:border-r-blue-3 hover:dark:border-r-gray-6'
        }
      />
      <Divider />
      <Skeleton visible={isLoadingAuctions} animate data-tour="auction:nav">
        {isErrorAuctions ? (
          <AlertWithIcon icon={<IconAlertCircle />} color="red" iconColor="red">
            <Text>There was an error fetching auctions.</Text>
          </AlertWithIcon>
        ) : !isLoadingAuctions && auctions.length === 0 ? (
          <Text>No auctions today!</Text>
        ) : (
          auctions.map((a) => (
            <NavLink
              key={a.id}
              p={itemSize}
              label={
                <Group justify="space-between">
                  <Text fw={500} className="shrink basis-2/3" inherit>
                    {a.auctionBase.name}
                  </Text>
                  <Tooltip label="Min bid currently required to place">
                    <CurrencyBadge
                      currency="BUZZ"
                      type={features.isGreen ? 'green' : 'yellow'}
                      unitAmount={a.lowestBidRequired}
                      displayCurrency={false}
                      radius="md"
                      size="sm"
                      iconProps={{
                        size: 11,
                      }}
                    />
                  </Tooltip>
                </Group>
              }
              onClick={() => {
                chooseAuction(a);
              }}
              active={selectedAuction?.id === a.id}
              className={
                'border-r-2 border-solid border-r-transparent hover:border-r-gray-4 data-[active]:!border-r-blue-3 hover:dark:border-r-gray-6 '
              }
            />
          ))
        )}
      </Skeleton>
    </Stack>
  );

  return (
    <>
      <Meta
        title={getDocTitle()}
        description="View and participate in auctions for featured spots on Civitai."
        canonical={pathname}
        deIndex={slug === MY_BIDS}
      />
      <Container size="xl" h="100%" data-tour="auction:start">
        <ContainerGrid2
          gutter="xl"
          className="my-3 h-full"
          classNames={{ container: 'h-full', inner: 'h-full' }}
        >
          {!isMobile && (
            <ContainerGrid2.Col span={{ base: 12, sm: 4 }}>
              <Box
                maw={330}
                w="100%"
                h="100%"
                mah="calc(100dvh - var(--header-height) - var(--footer-height) - 24px)"
                className="sticky top-4 overflow-auto border-r border-r-gray-3 dark:border-r-dark-4"
                pt="lg"
              >
                {navLinks()}
              </Box>
            </ContainerGrid2.Col>
          )}

          <ContainerGrid2.Col
            span={{ base: 12, sm: 8 }}
            display="flex"
            style={{ justifyContent: 'center' }}
          >
            {slug !== MY_BIDS ? <AuctionInfo /> : <AuctionMyBids />}
          </ContainerGrid2.Col>
        </ContainerGrid2>
      </Container>
      <Drawer
        opened={drawerIsOpen}
        onClose={drawerClose}
        size="90%"
        position="bottom"
        styles={{
          content: {
            maxHeight: 'calc(100dvh - var(--header-height))',
            overflowY: 'auto',
          },
          body: { padding: 16, paddingTop: 0, overflowY: 'auto' },
          header: { padding: '6px 16px' },
          close: { height: 32, width: 32, '& > svg': { width: 24, height: 24 } },
        }}
        title={
          <Text size="lg" fw={500}>
            Auctions
          </Text>
        }
      >
        <ScrollArea>{navLinks('md')}</ScrollArea>
      </Drawer>
    </>
  );
}
