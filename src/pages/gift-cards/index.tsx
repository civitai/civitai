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
import { getEnabledVendors, getVendorById, getDefaultVendor } from './vendors';
import type { Vendor, BuzzCard, Membership } from './vendors';
import classes from './index.module.scss';

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
          <div>
            <Group justify="space-between" align="flex-start" wrap="wrap">
              <div>
                <Title order={1} mb="md">
                  Gift Cards & Memberships
                </Title>
                <Text color="dimmed" size="lg">
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
                    <Card shadow="sm" padding="lg" radius="md" withBorder className={classes.card}>
                      <Text fw={700} size="lg" ta="center">
                        {formatBuzzAmount(card.amount)} Buzz
                      </Text>
                      <Card.Section p="sm">
                        <UnstyledButton
                          component="a"
                          href={card.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ display: 'block' }}
                        >
                          <Image
                            src={card.image}
                            alt={`${formatBuzzAmount(card.amount)} Buzz Gift Card`}
                            height={200}
                            fit="contain"
                            style={{ cursor: 'pointer' }}
                          />
                        </UnstyledButton>
                      </Card.Section>
                      <Stack mt="md" gap="sm">
                        {card.price && (
                          <Text size="xl" fw={700} c="blue" ta="center">
                            ${card.price}
                          </Text>
                        )}
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
                      </Stack>
                    </Card>
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
                    <Card
                      shadow="sm"
                      padding="lg"
                      radius="md"
                      withBorder
                      className={classes.membershipCard}
                    >
                      <Text fw={700} size="lg" ta="center">
                        {membership.tier} Membership
                      </Text>
                      <Card.Section p="sm">
                        <UnstyledButton
                          component="a"
                          href={membership.durations[0]?.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ display: 'block' }}
                        >
                          <Image
                            src={membership.image}
                            alt={`${membership.tier} Membership`}
                            height={200}
                            fit="contain"
                            style={{ cursor: 'pointer' }}
                          />
                        </UnstyledButton>
                      </Card.Section>
                      <Stack mt="md" gap="md">
                        <Group gap="xs" grow>
                          {membership.durations.map((duration) => (
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
                          ))}
                        </Group>
                      </Stack>
                    </Card>
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
