import {
  Box,
  Container,
  Divider,
  Drawer,
  Group,
  MantineSize,
  NavLink,
  Skeleton,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import { InferGetServerSidePropsType } from 'next';
import { usePathname } from 'next/navigation';
import { useRouter } from 'next/router';
import React, { useEffect } from 'react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { AuctionInfo } from '~/components/Auction/AuctionInfo';
import { AuctionMyBids } from '~/components/Auction/AuctionMyBids';
import { MY_BIDS, useAuctionContext } from '~/components/Auction/AuctionProvider';
import { ContainerGrid } from '~/components/ContainerGrid/ContainerGrid';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { Meta } from '~/components/Meta/Meta';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';
import { useTourContext } from '~/components/Tours/ToursProvider';
import { env } from '~/env/client';
import { useIsMobile } from '~/hooks/useIsMobile';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { trpc } from '~/utils/trpc';

type QueryData = {
  slug?: string[];
};

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  useSession: true,
  resolver: async ({ ssg, features, ctx, session }) => {
    if (!features?.auctions) return { notFound: true };

    let auctionName: string | null = null;
    let valid = true;

    if (ssg) {
      await ssg.auction.getAll.prefetch();
      const { slug } = ctx.query as QueryData;
      if (slug && slug.length) {
        const sSlug = slug[0];
        if (sSlug !== MY_BIDS) {
          // await ssg.auction.getBySlug.prefetch({ slug: sSlug });
          try {
            const res = await ssg.auction.getBySlug.fetch({ slug: sSlug });
            await ssg.auction.getMyBids.prefetch();
            auctionName = res?.auctionBase?.name ?? null;
          } catch {
            valid = false;
          }
        } else {
          if (!session) {
            return {
              redirect: {
                destination: getLoginLink({ returnUrl: ctx.resolvedUrl }),
                permanent: false,
              },
            };
          }
          await ssg.auction.getMyBids.prefetch();
          await ssg.auction.getMyRecurringBids.prefetch();

          auctionName = 'My Bids';
        }
      }
    }

    return { props: { auctionName, valid } };
  },
});

export default function Auctions({
  auctionName,
  valid,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const router = useRouter();
  const { slug: initialSlug } = router.query as QueryData;
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
  const isMobile = useIsMobile();

  const {
    data: auctions = [],
    isLoading: isLoadingAuctions,
    isError: isErrorAuctions,
  } = trpc.auction.getAll.useQuery();

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
  }, [slug, auctions.length]);

  useEffect(() => {
    if (valid !== validAuction) {
      setValidAuction(valid);
    }
  }, [valid]);

  useEffect(() => {
    if (!running) runTour({ key: 'auction', step: 0 });
  }, []);

  const navLinks = (itemSize?: MantineSize) => (
    <Stack>
      <NavLink
        p={itemSize}
        label={<Text weight={500}>My Bids</Text>}
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
                <Group position="apart">
                  <Text weight={500} className="shrink basis-2/3">
                    {a.auctionBase.name}
                  </Text>
                  <Tooltip label="Min bid currently required to place">
                    <CurrencyBadge
                      currency="BUZZ"
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
        title={`Auction${auctionName ? `: ${auctionName}` : 's'} | Civitai`}
        description="View and participate in auctions for featured spots on Civitai."
        links={[{ href: `${env.NEXT_PUBLIC_BASE_URL}/${pathname}`, rel: 'canonical' }]}
        deIndex={slug === MY_BIDS}
      />
      <Container size="lg" h="100%" data-tour="auction:start">
        <ContainerGrid gutter="xl" my="sm" h="100%">
          {!isMobile && (
            <ContainerGrid.Col xs={12} sm={4} className="max-sm:hidden">
              <Box
                maw={300}
                w="100%"
                h="100%"
                mah="calc(100dvh - var(--header-height) - var(--footer-height) - 24px)"
                className="sticky top-4 overflow-auto border-r border-r-gray-3 dark:border-r-dark-4"
                pt="lg"
              >
                {navLinks()}
              </Box>
            </ContainerGrid.Col>
          )}

          <ContainerGrid.Col xs={12} sm={8} display="flex" sx={{ justifyContent: 'center' }}>
            {slug !== MY_BIDS ? <AuctionInfo /> : <AuctionMyBids />}
          </ContainerGrid.Col>
        </ContainerGrid>
      </Container>
      <Drawer
        opened={drawerIsOpen}
        onClose={drawerClose}
        size="90%"
        position="bottom"
        styles={{
          drawer: {
            maxHeight: 'calc(100dvh - var(--header-height))',
            overflowY: 'auto',
          },
          body: { padding: 16, paddingTop: 0, overflowY: 'auto' },
          header: { padding: '4px 8px' },
          closeButton: { height: 32, width: 32, '& > svg': { width: 24, height: 24 } },
        }}
        title={
          <Text size="lg" weight={500}>
            Auctions
          </Text>
        }
      >
        <ScrollArea>{navLinks('md')}</ScrollArea>
      </Drawer>
    </>
  );
}
