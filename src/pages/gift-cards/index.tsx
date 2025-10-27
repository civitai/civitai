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
import { IconExternalLink, IconCheck, IconBolt, IconBuildingStore, IconArrowRight } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { Meta } from '~/components/Meta/Meta';
import { PromoNotification } from '~/components/PromoNotification/PromoNotification';
import { KinguinCheckout } from '~/components/KinguinCheckout';
import { useKinguinSDK } from '~/hooks/useKinguinSDK';
import { getEnabledVendors, getVendorById, getDefaultVendor } from '~/utils/gift-cards/vendors';
import type { Vendor, BuzzCard, Membership } from '~/utils/gift-cards/vendors';
import { NextLink } from '~/components/NextLink/NextLink';
import classes from './index.module.scss';

// Kinguin utility moved to KinguinCheckout component

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

  // Kinguin checkout states
  const [showKinguinCheckout, setShowKinguinCheckout] = useState(false);
  const [kinguinProductUrl, setKinguinProductUrl] = useState<string>('');
  const [kinguinProductName, setKinguinProductName] = useState<string>('');

  // Load Kinguin SDK when vendor is Kinguin
  const kinguinSDK = useKinguinSDK(selectedVendor?.id === 'kinguin');

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
      // Close Kinguin checkout if switching vendors
      if (showKinguinCheckout) {
        closeKinguinCheckout();
      }

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

  // Kinguin checkout handlers
  const handleKinguinPurchase = (productUrl: string, productName: string) => {
    setKinguinProductUrl(productUrl);
    setKinguinProductName(productName);
    setShowKinguinCheckout(true);
  };

  const closeKinguinCheckout = () => {
    setShowKinguinCheckout(false);
    setKinguinProductUrl('');
    setKinguinProductName('');
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
                <Title order={1} mb="sm">
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

          {/* Purchase Success Notification */}
          {purchaseSuccess && !showKinguinCheckout && (
            <Alert
              icon={<IconCheck size={16} />}
              title="Purchase Successful!"
              color="green"
              mb="xl"
            >
              Your gift card purchase has been completed successfully. You should receive your gift
              card code via email shortly.
            </Alert>
          )}

          {/* Kinguin Checkout View */}
          {showKinguinCheckout ? (
            <KinguinCheckout
              productUrl={kinguinProductUrl}
              productName={kinguinProductName}
              onClose={closeKinguinCheckout}
              sdkLoaded={kinguinSDK.sdkLoaded}
              sdkError={kinguinSDK.sdkError}
              kinguinCheckoutSDK={kinguinSDK.kinguinCheckoutSDK}
            />
          ) : (
            <>
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
                            selectedVendor.id === 'kinguin' ? (
                              <Button
                                onClick={() =>
                                  handleKinguinPurchase(
                                    card.url,
                                    `${formatBuzzAmount(card.amount)} Buzz`
                                  )
                                }
                                fullWidth
                                size="md"
                                className={classes.buzzButton}
                              >
                                Buy Now
                              </Button>
                            ) : (
                              <Button
                                component="a"
                                href={card.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                rightSection={<IconExternalLink size={16} />}
                                fullWidth
                                size="md"
                                className={classes.buzzButton}
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
                          type="membership"
                          actions={
                            <Group gap="xs" grow>
                              {membership.durations.map((duration) => {
                                const productName = `${membership.tier} Membership - ${
                                  duration.months
                                } Month${duration.months > 1 ? 's' : ''}`;
                                return selectedVendor.id === 'kinguin' ? (
                                  <Button
                                    key={duration.months}
                                    onClick={() => handleKinguinPurchase(duration.url, productName)}
                                    size="sm"
                                    className={classes.membershipButton}
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
                                    rightSection={<IconExternalLink size={16} />}
                                    size="sm"
                                    className={classes.membershipButton}
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
            </>
          )}

          {/* Wholesale Program Callout */}
          {!showKinguinCheckout && <WholesaleCallout />}
        </Stack>
      </Container>
    </>
  );
}

// Wholesale Program Callout Component
const WholesaleCallout = () => {
  return (
    <Card
      shadow="lg"
      padding="xl"
      radius="md"
      withBorder
      mt="xl"
      className={classes.wholesaleCallout}
    >
      <Grid align="center">
        <Grid.Col span={{ base: 12, md: 8 }}>
          <Stack gap="md">
            <Group gap="md">
              <div className={classes.wholesaleIconWrapper}>
                <IconBuildingStore size={32} />
              </div>
              <Stack gap={4}>
                <Title order={2} className={classes.wholesaleTitle}>
                  Run a Store? Sell Buzz Gift Cards
                </Title>
                <Text size="lg" c="dimmed">
                  Join our Wholesale Program and offer Buzz gift cards to your customers
                </Text>
              </Stack>
            </Group>
            <Group gap="xl" ml={60}>
              <Group gap="xs">
                <IconBolt size={20} className={classes.wholesaleHighlight} />
                <Text size="sm" fw={500}>
                  Up to 15% discount
                </Text>
              </Group>
              <Group gap="xs">
                <IconCheck size={20} className={classes.wholesaleHighlight} />
                <Text size="sm" fw={500}>
                  Featured on gift cards page
                </Text>
              </Group>
              <Group gap="xs">
                <IconCheck size={20} className={classes.wholesaleHighlight} />
                <Text size="sm" fw={500}>
                  Marketing support
                </Text>
              </Group>
            </Group>
          </Stack>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 4 }}>
          <Stack gap="sm" className={classes.wholesaleCTAWrapper}>
            <Button
              component={NextLink}
              href="/buzz-wholesale"
              size="lg"
              rightSection={<IconArrowRight size={20} />}
              className={classes.wholesaleCTA}
            >
              Learn More
            </Button>
            <Text size="xs" c="dimmed" className={classes.wholesaleCTAText}>
              Perfect for retailers, resellers, and online stores
            </Text>
          </Stack>
        </Grid.Col>
      </Grid>
    </Card>
  );
};
