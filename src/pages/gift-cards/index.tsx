import {
  Alert,
  Button,
  Card,
  Container,
  Grid,
  Group,
  Image,
  SegmentedControl,
  Select,
  Stack,
  Text,
  Title,
  UnstyledButton,
} from '@mantine/core';
import { IconExternalLink, IconCheck } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { Meta } from '~/components/Meta/Meta';
import { PromoNotification } from '~/components/PromoNotification/PromoNotification';
import { getEnabledVendors, getVendorById, getDefaultVendor } from '~/utils/gift-cards/vendors';
import type { Vendor, BuzzCard, Membership } from '~/utils/gift-cards/vendors';
import classes from './index.module.scss';

// Utility function to extract Kinguin product ID from URL
function extractKinguinProductId(url: string): string | null {
  try {
    const match = url.match(/category\/(\d+)\//); 
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// Helper to create purchase URL for different vendors
function createPurchaseUrl(vendor: Vendor, url: string, productName: string): string {
  if (vendor.id === 'kinguin') {
    const productId = extractKinguinProductId(url);
    if (productId) {
      return `/purchase/kinguin?productId=${productId}&productType=gift-card&productName=${encodeURIComponent(productName)}`;
    }
  }
  return url;
}

// Reusable gift card component
interface GiftCardItemProps {
  title: string;
  image: string;
  imageAlt: string;
  primaryUrl: string;
  price?: number;
  className?: string;
  actions: React.ReactNode;
}

const GiftCardItem = ({
  title,
  image,
  imageAlt,
  primaryUrl,
  price,
  className,
  actions,
}: GiftCardItemProps) => (
  <Card shadow="sm" padding="lg" radius="md" withBorder className={className}>
    <Text fw={700} size="lg" ta="center">
      {title}
    </Text>
    <Card.Section p="sm">
      <UnstyledButton
        component="a"
        href={primaryUrl}
        target="_blank"
        rel="noopener noreferrer"
        style={{ display: 'block' }}
      >
        <Image
          src={image}
          alt={imageAlt}
          height={200}
          fit="contain"
          style={{ cursor: 'pointer' }}
        />
      </UnstyledButton>
    </Card.Section>
    <Stack mt="md" gap="sm">
      {price && (
        <Text size="xl" fw={700} c="blue" ta="center">
          ${price}
        </Text>
      )}
      {actions}
    </Stack>
  </Card>
);

export default function GiftCardsPage() {
  const router = useRouter();
  const [selectedVendor, setSelectedVendor] = useState<Vendor | undefined>();
  const enabledVendors = getEnabledVendors();

  // Handle vendor selection from URL
  useEffect(() => {
    const vendorParam = router.query.vendor as string | undefined;
    if (vendorParam) {
      const vendor = getVendorById(vendorParam);
      if (vendor && vendor.enabled) {
        setSelectedVendor(vendor);
        return;
      }
    }
    // Set default vendor if no valid vendor in URL
    setSelectedVendor(getDefaultVendor());
  }, [router.query.vendor]);

  // Update URL when vendor changes
  const handleVendorChange = (vendorId: string) => {
    const vendor = getVendorById(vendorId);
    if (vendor && vendor.enabled) {
      setSelectedVendor(vendor);
      router.push(
        {
          pathname: '/gift-cards',
          query: { ...router.query, vendor: vendorId },
        },
        undefined,
        { shallow: true }
      );
    }
  };

  // Check if we should show sections based on query params
  const typeFilter = router.query.type as string | undefined;
  const showBuzzCards = !typeFilter || typeFilter === 'buzz';
  const showMemberships = !typeFilter || typeFilter === 'memberships';

  // Check for purchase success
  const purchaseSuccess = router.query.purchase === 'success';

  if (!selectedVendor) {
    return (
      <>
        <Meta
          title="Gift Cards | Civitai"
          description="Purchase Civitai Buzz gift cards and membership packages"
        />
        <Container size="xl" py="xl">
          <Title order={1} mb="lg">
            Gift Cards & Memberships
          </Title>
          <Text>No vendors available at this time.</Text>
        </Container>
      </>
    );
  }

  const formatBuzzAmount = (amount: number) => {
    if (amount >= 1000) {
      return `${amount / 1000}K`;
    }
    return amount.toString();
  };

  return (
    <>
      <Meta
        title="Gift Cards | Civitai"
        description="Purchase Civitai Buzz gift cards and membership packages"
      />
      <Container size="xl" py="xl">
        <Stack gap="xl">
          <div className={classes.headerSection}>
            <Group justify="space-between" align="flex-start" wrap="wrap">
              <div>
                <Title order={1} mb="md">
                  Gift Cards & Memberships
                </Title>
                <Text c="dimmed" size="lg">
                  Purchase Buzz gift cards and membership packages from our trusted vendors
                </Text>
              </div>

              {/* Vendor Selector */}
              <Stack gap="xs" align="flex-end">
                <Text size="xs" c="dimmed" fw={700}>
                  Vendor
                </Text>
                {enabledVendors.length <= 3 ? (
                  <SegmentedControl
                    value={selectedVendor.id}
                    onChange={handleVendorChange}
                    data={enabledVendors.map((v) => ({
                      label: v.displayName,
                      value: v.id,
                    }))}
                  />
                ) : (
                  <Select
                    value={selectedVendor.id}
                    onChange={(value) => value && handleVendorChange(value)}
                    data={enabledVendors.map((v) => ({
                      label: v.displayName,
                      value: v.id,
                    }))}
                    style={{ width: 200 }}
                  />
                )}
              </Stack>
            </Group>
            
            {/* Promo Notification - positioned absolutely on desktop, normal flow on mobile */}
            {selectedVendor.promo && (
              <div className={classes.promoNotification}>
                <PromoNotification
                  vendorId={selectedVendor.id}
                  vendorName={selectedVendor.displayName}
                  promo={selectedVendor.promo}
                />
              </div>
            )}
          </div>

          {/* Purchase Success Notification */}
          {purchaseSuccess && (
            <Alert icon={<IconCheck size={16} />} title="Purchase Successful!" color="green" mb="xl">
              Your gift card purchase has been completed successfully. You should receive your gift card code via email shortly.
            </Alert>
          )}

          {/* Buzz Gift Cards Section */}
          {showBuzzCards && selectedVendor.products.buzzCards.length > 0 && (
            <div>
              <Title order={2} mb="lg">
                Buzz Gift Cards
              </Title>
              <Grid gutter="lg">
                {selectedVendor.products.buzzCards.map((card) => (
                  <Grid.Col key={card.amount} span={{ base: 12, sm: 6, md: 4 }}>
                    <GiftCardItem
                      title={`${formatBuzzAmount(card.amount)} Buzz`}
                      image={card.image}
                      imageAlt={`${formatBuzzAmount(card.amount)} Buzz Gift Card`}
                      primaryUrl={card.url}
                      price={card.price}
                      className={classes.card}
                      actions={
                        selectedVendor.id === 'kinguin' ? (
                          <Button
                            component="a"
                            href={createPurchaseUrl(selectedVendor, card.url, `${formatBuzzAmount(card.amount)} Buzz`)}
                            fullWidth
                          >
                            Buy Now
                          </Button>
                        ) : (
                          <Button
                            component="a"
                            href={card.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            rightIcon={<IconExternalLink size={16} />}
                            fullWidth
                          >
                            Buy Now
                          </Button>
                        )
                      }
                    />
                  </Grid.Col>
                ))}
              </Grid>
            </div>
          )}

          {/* Memberships Section */}
          {showMemberships && selectedVendor.products.memberships.length > 0 && (
            <div>
              <Title order={2} mb="lg">
                Membership Packages
              </Title>
              <Grid gutter="lg">
                {selectedVendor.products.memberships.map((membership) => (
                  <Grid.Col key={membership.tier} span={{ base: 12, md: 4 }}>
                    <GiftCardItem
                      title={`${membership.tier} Membership`}
                      image={membership.image}
                      imageAlt={`${membership.tier} Membership`}
                      primaryUrl={membership.durations[0]?.url}
                      className={classes.membershipCard}
                      actions={
                        <Group gap="xs" grow>
                          {membership.durations.map((duration) => {
                            const productName = `${membership.tier} Membership - ${duration.months} Month${duration.months > 1 ? 's' : ''}`;
                            return selectedVendor.id === 'kinguin' ? (
                              <Button
                                key={duration.months}
                                component="a"
                                href={createPurchaseUrl(selectedVendor, duration.url, productName)}
                              >
                                {duration.months} Month{duration.months > 1 ? 's' : ''}
                                {duration.price && ` - $${duration.price}`}
                              </Button>
                            ) : (
                              <Button
                                key={duration.months}
                                component="a"
                                href={duration.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                rightIcon={<IconExternalLink size={16} />}
                              >
                                {duration.months} Month{duration.months > 1 ? 's' : ''}
                                {duration.price && ` - $${duration.price}`}
                              </Button>
                            );
                          })}
                        </Group>
                      }
                    />
                  </Grid.Col>
                ))}
              </Grid>
            </div>
          )}
        </Stack>
      </Container>
    </>
  );
}
