import {
  Alert,
  Box,
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
import {
  IconExternalLink,
  IconCheck,
  IconBolt,
  IconBuildingStore,
  IconArrowRight,
  IconAlertTriangle,
} from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { Meta } from '~/components/Meta/Meta';
import { PromoNotification } from '~/components/PromoNotification/PromoNotification';
import { KinguinCheckout } from '~/components/KinguinCheckout';
import { useKinguinSDK } from '~/hooks/useKinguinSDK';
import type { Vendor } from '~/utils/gift-cards/vendors';
import { NextLink } from '~/components/NextLink/NextLink';
import { getVendorDiscount } from '~/utils/gift-cards/discount-utils';
import { GIFT_CARD_DISCLAIMER } from '~/utils/gift-cards/constants';
import { trpc } from '~/utils/trpc';
import { Countdown } from '~/components/Countdown/Countdown';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getEnabledVendorsServer } from '~/server/services/gift-card-vendors.service';
import classes from './index.module.scss';

// Kinguin utility moved to KinguinCheckout component

// Reusable gift card component
interface GiftCardItemProps {
  title: string;
  image: string;
  imageAlt: string;
  primaryUrl: string;
  discountPercentage?: number;
  className?: string;
  actions: React.ReactNode;
  type?: 'buzz' | 'membership';
}

const GiftCardItem = ({
  title,
  image,
  imageAlt,
  primaryUrl,
  discountPercentage,
  className,
  actions,
  type,
}: GiftCardItemProps) => {
  const isMembership = type === 'membership';
  const hasDiscount = !!discountPercentage;

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
            className="relative block"
          >
            {/* Slanted corner discount banner - positioned over top left of image */}
            {hasDiscount && (
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: 150,
                  height: 150,
                  overflow: 'hidden',
                  zIndex: 2,
                  pointerEvents: 'none',
                }}
              >
                <div
                  style={{
                    position: 'absolute',
                    top: 35,
                    left: -45,
                    width: 180,
                    padding: '10px 0',
                    background: 'linear-gradient(135deg, #ff6b1a 0%, #8b2fc9 100%)',
                    transform: 'rotate(-45deg)',
                    textAlign: 'center',
                    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
                  }}
                >
                  <Text
                    size="sm"
                    fw={700}
                    c="white"
                    style={{
                      textShadow: '0 1px 2px rgba(0, 0, 0, 0.4)',
                      letterSpacing: '0.5px',
                    }}
                  >
                    {discountPercentage}% OFF
                  </Text>
                </div>
              </div>
            )}
            <Image
              src={image}
              alt={imageAlt}
              height={200}
              fit="contain"
              style={{ cursor: 'pointer' }}
            />
          </UnstyledButton>
        </Card.Section>

        <Stack gap="sm">{actions}</Stack>
      </Stack>
    </Card>
  );
};

interface GiftCardsPageProps {
  enabledVendors: Vendor[];
}

export const getServerSideProps = createServerSideProps<GiftCardsPageProps>({
  useSession: true,
  resolver: async ({ session }) => {
    const enabledVendors = await getEnabledVendorsServer(session?.user?.id);

    return {
      props: {
        enabledVendors,
      },
    };
  },
});

export default function GiftCardsPage({ enabledVendors }: GiftCardsPageProps) {
  const router = useRouter();
  const [selectedVendor, setSelectedVendor] = useState<Vendor | undefined>();
  const { data: kinguinPaymentWarning } = trpc.system.getDbKV.useQuery({
    key: 'kinguinPaymentWarning',
  });
  const showKinguinPaymentWarning = !!kinguinPaymentWarning;

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
      const vendor = enabledVendors.find((v) => v.id === vendorParam);
      if (vendor) {
        setSelectedVendor(vendor);
        return;
      }
    }
    // Set default vendor if no valid vendor in URL
    setSelectedVendor(enabledVendors[0]);
  }, [router.query.vendor, enabledVendors]);

  // Update URL when vendor changes
  const handleVendorChange = (vendorId: string) => {
    const vendor = enabledVendors.find((v) => v.id === vendorId);
    if (vendor) {
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
                <Group gap="md" wrap="wrap">
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
                  <Stack gap="xs">
                    <Text size="xs" c="dimmed" fw={700}>
                      Vendor
                    </Text>
                    {enabledVendors.length <= 3 ? (
                      <SegmentedControl
                        value={selectedVendor.id}
                        onChange={handleVendorChange}
                        data={enabledVendors.map((v) => ({
                          label: v.badge ? (
                            <Group gap={6} wrap="nowrap" align="center">
                              <span>{v.displayName}</span>
                              <Box className={classes.newVendorDot} />
                            </Group>
                          ) : (
                            v.displayName
                          ),
                          value: v.id,
                        }))}
                        size="sm"
                      />
                    ) : (
                      <Select
                        value={selectedVendor.id}
                        onChange={(value) => value && handleVendorChange(value)}
                        data={enabledVendors.map((v) => ({
                          label: v.badge ? `${v.displayName} •` : v.displayName,
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

          {/* Discount Banner */}
          {(() => {
            const discountInfo = getVendorDiscount(selectedVendor);
            return discountInfo.isActive && discountInfo.title && discountInfo.description ? (
              <Alert
                variant="filled"
                title={discountInfo.title}
                styles={{
                  root: {
                    background: 'linear-gradient(135deg, #ff6b1a 0%, #8b2fc9 100%)',
                    borderColor: '#ff8c42',
                  },
                  title: {
                    color: 'white',
                  },
                }}
              >
                <Stack gap="xs">
                  <Text size="sm" c="white">
                    {discountInfo.description}
                  </Text>
                  {selectedVendor.discount?.endDate && (
                    <Text size="sm" c="white" fw={600}>
                      Time remaining:{' '}
                      <Countdown endTime={selectedVendor.discount.endDate} format="short" />
                    </Text>
                  )}
                </Stack>
              </Alert>
            ) : null;
          })()}

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

          {/* Payment Method Warning */}
          {!showKinguinCheckout && selectedVendor.id === 'kinguin' && showKinguinPaymentWarning && (
            <Alert icon={<IconAlertTriangle size={30} />} color="red" radius="md">
              <Text>
                Due to current technical limitations on Kinguin, Credit Cards, and some other
                payment methods, are temporarily unavailable for Civitai Gift Cards.{' '}
                <Text component={NextLink} href="/purchase/buzz" c="blue" td="underline" inherit>
                  Alternative Buzz purchase options
                </Text>{' '}
                remain available. We&apos;re working with Kinguin to restore full payment support.
              </Text>
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
                    {selectedVendor.products.buzzCards.map((card) => {
                      const discountInfo = getVendorDiscount(selectedVendor);
                      return (
                        <Grid.Col key={card.amount} span={{ base: 12, sm: 6, md: 4 }}>
                          <GiftCardItem
                            title={`${formatBuzzAmount(card.amount)} Buzz`}
                            image={card.image}
                            imageAlt={`${formatBuzzAmount(card.amount)} Buzz Gift Card`}
                            primaryUrl={card.url}
                            discountPercentage={
                              discountInfo.isActive ? discountInfo.percentage : undefined
                            }
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
                      );
                    })}
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
                    {selectedVendor.products.memberships.map((membership) => {
                      const discountInfo = getVendorDiscount(selectedVendor);

                      return (
                        <Grid.Col key={membership.tier} span={{ base: 12, md: 4 }}>
                          <GiftCardItem
                            title={`${membership.tier} Membership`}
                            image={membership.image}
                            imageAlt={`${membership.tier} Membership`}
                            primaryUrl={membership.durations[0]?.url}
                            discountPercentage={
                              discountInfo.isActive ? discountInfo.percentage : undefined
                            }
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
                                      onClick={() =>
                                        handleKinguinPurchase(duration.url, productName)
                                      }
                                      size="sm"
                                      className={classes.membershipButton}
                                    >
                                      {duration.months} Month{duration.months > 1 ? 's' : ''}
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
                                    </Button>
                                  );
                                })}
                              </Group>
                            }
                          />
                        </Grid.Col>
                      );
                    })}
                  </Grid>
                </div>
              )}
            </>
          )}

          {/* Wholesale Program Callout */}
          {!showKinguinCheckout && <WholesaleCallout />}

          {/* Disclaimer */}
          {!showKinguinCheckout && (
            <Text size="xs" c="dimmed" ta="center" mt="md">
              {GIFT_CARD_DISCLAIMER.purchase} By purchasing, you agree to our{' '}
              <Text
                component={NextLink}
                href={GIFT_CARD_DISCLAIMER.termsUrl}
                size="xs"
                c="blue"
                td="underline"
              >
                {GIFT_CARD_DISCLAIMER.termsLinkText}
              </Text>
              .
            </Text>
          )}
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
      {/* New Plans Badge */}
      <div className={classes.newPlansBadge}>
        <Text size="xs" fw={700} c="white">
          New Plans Available
        </Text>
      </div>

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
            <Group gap="xl" ml={60} wrap="wrap">
              <Group gap="xs">
                <IconBolt size={20} className={classes.wholesaleHighlight} />
                <Text size="sm" fw={500}>
                  Starting at just $1k/month
                </Text>
              </Group>
              <Group gap="xs">
                <IconBolt size={20} className={classes.wholesaleHighlight} />
                <Text size="sm" fw={500}>
                  Up to 10% discount
                </Text>
              </Group>
              <Group gap="xs">
                <IconCheck size={20} className={classes.wholesaleHighlight} />
                <Text size="sm" fw={500}>
                  Featured on gift cards page
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
