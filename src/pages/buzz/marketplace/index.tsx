import { Card, Container, Stack, Text, Title } from '@mantine/core';
import { BuyBuzz } from '~/components/Marketplace/BuyBuzz';
import { ListBuzzSale } from '~/components/Marketplace/ListBuzzSale';
import { MarketplaceOverview } from '~/components/Marketplace/MarketplaceOverview';
import { MarketplaceProvider } from '~/components/Marketplace/MarketplaceProvider';
import { SellerListings } from '~/components/Marketplace/SellerListings';
import { Meta } from '~/components/Meta/Meta';
import { env } from '~/env/client';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({
  resolver: async () => {
    // Do something server-side if needed
    return { props: {} };
  },
});

export default function MarketplacePage() {
  return (
    <MarketplaceProvider>
      <Meta
        title="Buzz Marketplace | Civitai"
        description="Explore the latest marketplace trends and insights on Civitai."
        links={
          env.NEXT_PUBLIC_BASE_URL
            ? [{ rel: 'canonical', href: `${env.NEXT_PUBLIC_BASE_URL}/buzz/marketplace` }]
            : undefined
        }
      />
      <Container size="xl" py="lg">
        <Stack gap="xl">
          <MarketplaceOverview />
          <div
            className="grid grid-cols-1 gap-6 md:grid-cols-3"
            role="region"
            aria-label="Marketplace actions"
          >
            <ListBuzzSale />
            <BuyBuzz />
            <SellerListings />
          </div>
        </Stack>
      </Container>
    </MarketplaceProvider>
  );
}
