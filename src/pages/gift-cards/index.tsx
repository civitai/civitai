import {
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
import { IconExternalLink } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { Meta } from '~/components/Meta/Meta';
import { PromoNotification } from '~/components/PromoNotification/PromoNotification';
import { getEnabledVendors, getVendorById, getDefaultVendor } from '~/utils/gift-cards/vendors';
import type { Vendor, BuzzCard, Membership } from '~/utils/gift-cards/vendors';
import classes from './index.module.scss';

// Reusable gift card component
interface GiftCardItemProps {
  title: string;
  image: string;
  imageAlt: string;
  primaryUrl: string;
  price?: number;
  className?: string;
  actions: React.ReactNode;
  type?: 'buzz' | 'membership';
}

const GiftCardItem = ({
  title,
  image,
  imageAlt,
  primaryUrl,
  price,
  className,
  actions,
  type,
}: GiftCardItemProps) => {
  const isMembership = type === 'membership';

  return (
    <Card
      shadow="lg"
      padding="lg"
      radius="md"
      withBorder
      className={`${className ?? ''} ${classes.giftCardEnhanced}`}
      style={{
        position: 'relative',
        transition: 'all 0.3s ease',
        overflow: 'hidden',
      }}
    >
      {/* Subtle top accent */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: '3px',
          background:
            'linear-gradient(90deg, var(--mantine-color-blue-6), var(--mantine-color-cyan-5), var(--mantine-color-violet-6))',
        }}
      />

      <Stack gap="md">
        <Text
          fw={600}
          size="lg"
          ta="center"
          style={{
            color: 'var(--mantine-color-text)',
          }}
        >
          {title}
        </Text>

        <Card.Section p="sm">
          <UnstyledButton
            component="a"
            href={primaryUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'block',
            }}
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

        <Stack gap="sm">
          {price && (
            <Text
              size="xl"
              fw={700}
              ta="center"
              style={{
                background:
                  'linear-gradient(135deg, var(--mantine-color-blue-4), var(--mantine-color-cyan-4))',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                backgroundClip: 'text',
                filter: 'drop-shadow(0 1px 2px rgba(0, 0, 0, 0.3))',
              }}
            >
              ${price}
            </Text>
          )}
          {actions}
        </Stack>
      </Stack>
    </Card>
  );
};

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

  // Handle type filter changes
  const handleTypeChange = (value: string) => {
    const newQuery = { ...router.query };
    if (value === 'all') {
      delete newQuery.type;
    } else {
      newQuery.type = value;
    }

    router.push(
      {
        pathname: '/gift-cards',
        query: newQuery,
      },
      undefined,
      { shallow: true }
    );
  };

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

              <Stack gap="sm" align="flex-end">
                {/* Controls Row */}
                <Group gap="xl" wrap="nowrap">
                  {/* Type Selector */}
                  <Stack gap="xs">
                    <Text size="xs" c="dimmed" fw={700}>
                      Show
                    </Text>
                    <SegmentedControl
                      value={typeFilter || 'all'}
                      onChange={handleTypeChange}
                      data={[
                        { label: 'All', value: 'all' },
                        { label: 'Buzz Cards', value: 'buzz' },
                        { label: 'Memberships', value: 'memberships' },
                      ]}
                      size="sm"
                    />
                  </Stack>

                  {/* Vendor Selector */}
                  <Stack gap="xs" align="center">
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
                        size="sm"
                      />
                    ) : (
                      <Select
                        value={selectedVendor.id}
                        onChange={(value) => value && handleVendorChange(value)}
                        data={enabledVendors.map((v) => ({
                          label: v.displayName,
                          value: v.id,
                        }))}
                        size="sm"
                        style={{ width: 180 }}
                      />
                    )}
                  </Stack>
                </Group>
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
                      type="buzz"
                      actions={
                        <Button
                          component="a"
                          href={card.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          rightSection={<IconExternalLink size={16} />}
                          fullWidth
                          size="md"
                          style={{
                            background:
                              'linear-gradient(135deg, var(--mantine-color-yellow-5), var(--mantine-color-orange-6))',
                            border: 'none',
                            boxShadow: '0 2px 8px rgba(255, 193, 7, 0.3)',
                            transition: 'all 0.2s ease',
                          }}
                        >
                          Buy Now
                        </Button>
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
                      type="membership"
                      actions={
                        <Group gap="xs" grow>
                          {membership.durations.map((duration) => (
                            <Button
                              key={duration.months}
                              component="a"
                              href={duration.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              rightSection={<IconExternalLink size={16} />}
                              size="sm"
                              style={{
                                background:
                                  'linear-gradient(135deg, var(--mantine-color-violet-6), var(--mantine-color-indigo-6))',
                                border: 'none',
                                boxShadow: '0 2px 8px rgba(139, 69, 219, 0.3)',
                                transition: 'all 0.2s ease',
                              }}
                            >
                              {duration.months} Month{duration.months > 1 ? 's' : ''}
                              {duration.price && ` - $${duration.price}`}
                            </Button>
                          ))}
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
