import {
  Container,
  Stack,
  Text,
  Title,
  Group,
  ThemeIcon,
  Button,
  Anchor,
  Center,
  Divider,
} from '@mantine/core';
import {
  IconTicket,
  IconGift,
  IconBolt,
  IconRocket,
  IconUsers,
  IconPhoto,
  IconDiamond,
} from '@tabler/icons-react';
import { useRouter } from 'next/router';
import React from 'react';
import { Meta } from '~/components/Meta/Meta';
import { env } from '~/env/client';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { RedeemCodeCard } from '~/components/RedeemCode';
import classes from '~/pages/redeem-code.module.scss';
import { NextLink } from '~/components/NextLink/NextLink';
import { useLiveFeatureFlags } from '~/hooks/useLiveFeatureFlags';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features, session, ctx }) => {
    if (!features?.buzz) {
      return { notFound: true };
    }

    if (!session)
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.resolvedUrl }),
          permanent: false,
        },
      };
  },
});

const PurchaseOptionsCard = () => {
  return (
    <div className={classes.purchaseSection}>
      <Group gap="md" wrap="nowrap" className={classes.purchaseContent}>
        <ThemeIcon size="lg" variant="light" color="blue" radius="md">
          <IconBolt size={24} fill="currentColor" />
        </ThemeIcon>
        <div style={{ flex: 1 }}>
          <Text size="md" fw={600} mb={0}>
            Don&apos;t have a code yet?
          </Text>
          <Text size="sm" c="dimmed" mb="md">
            Purchase redeemable codes for Buzz or Memberships
          </Text>
          <Group gap="sm">
            <Button
              component={NextLink}
              href="/pricing"
              variant="light"
              color="blue"
              size="sm"
              leftSection={<IconBolt size={16} fill="currentColor" />}
            >
              View Pricing
            </Button>
            <Button
              component="a"
              href="/gift-cards"
              variant="outline"
              color="gray"
              size="sm"
              leftSection={<IconGift size={16} />}
            >
              Purchase Codes
            </Button>
          </Group>
        </div>
      </Group>
    </div>
  );
};

const BenefitsSection = () => {
  return (
    <div className={classes.benefitsSection}>
      <Stack gap="lg">
        <div style={{ textAlign: 'center' }}>
          <Title order={3} className={classes.sectionTitle} mb={0}>
            What Can You Redeem?
          </Title>
          <Text c="dimmed" size="sm">
            Our codes unlock different types of rewards
          </Text>
        </div>

        <div className={classes.benefitsGrid}>
          <div className={classes.benefitItem}>
            <Group gap="sm" wrap="nowrap">
              <ThemeIcon size="md" variant="light" color="yellow" radius="md">
                <IconBolt size={20} fill="currentColor" />
              </ThemeIcon>
              <div>
                <Text size="sm" fw={600} c="yellow.6">
                  Buzz Credits
                </Text>
                <Text size="xs" c="dimmed" lh={1.4}>
                  Generate images, access early models, train custom models
                </Text>
              </div>
            </Group>
          </div>

          <div className={classes.benefitItem}>
            <Group gap="sm" wrap="nowrap">
              <ThemeIcon size="md" variant="light" color="grape" radius="md">
                <IconDiamond fill="currentColor" size={20} />
              </ThemeIcon>
              <div>
                <Text size="sm" fw={600} c="grape.6">
                  Membership Access
                </Text>
                <Text size="xs" c="dimmed" lh={1.4}>
                  Premium features, priority support, exclusive content
                </Text>
              </div>
            </Group>
          </div>
        </div>

        <div className={classes.buzzFeatures}>
          <Text size="xs" c="dimmed" ta="center" mb="sm">
            With Buzz you can:
          </Text>
          <Group gap="lg" justify="center" wrap="wrap">
            <Group gap="xs" wrap="nowrap">
              <IconPhoto size={14} style={{ opacity: 0.7 }} />
              <Text size="xs" c="dimmed">
                Generate Images
              </Text>
            </Group>
            <Group gap="xs" wrap="nowrap">
              <IconRocket size={14} style={{ opacity: 0.7 }} />
              <Text size="xs" c="dimmed">
                Early Access
              </Text>
            </Group>
            <Group gap="xs" wrap="nowrap">
              <IconUsers size={14} style={{ opacity: 0.7 }} />
              <Text size="xs" c="dimmed">
                Train Models
              </Text>
            </Group>
          </Group>
        </div>
      </Stack>
    </div>
  );
};

export default function RedeemCodeImprovedPage() {
  const { query } = useRouter();
  const liveFeatures = useLiveFeatureFlags();

  return (
    <>
      <Meta
        title="Civitai | Redeem Buzz Code"
        description="Redeem your Buzz codes for rewards and exclusive perks on Civitai."
        links={
          env.NEXT_PUBLIC_BASE_URL
            ? [{ href: `${env.NEXT_PUBLIC_BASE_URL}/redeem-code`, rel: 'canonical' }]
            : undefined
        }
      />

      <div className={classes.wrapper}>
        <Container size="md">
          <Stack gap="xl" py="xl">
            {/* Hero Section */}
            <div className={classes.heroSection}>
              <Center>
                <Group mb={0}>
                  <ThemeIcon
                    size="2.8rem"
                    variant="gradient"
                    gradient={{ from: 'yellow.4', to: 'orange.5' }}
                    radius="md"
                  >
                    <IconTicket size={32} />
                  </ThemeIcon>
                  <Title order={1} className={classes.heroTitle} ta="center">
                    Time to get your perks!
                  </Title>
                </Group>
              </Center>

              <Text size="lg" c="dimmed" ta="center" className={classes.heroDescription}>
                Enter your code below to instantly get your Buzz or Membership. No wait time, no
                hassle.
              </Text>
            </div>

            {/* Main Redemption Card */}
            <RedeemCodeCard initialCode={query.code as string} />

            {/* Info Alert */}
            <Text size="sm" c="dimmed" ta="center" className={classes.infoText}>
              Codes are processed instantly • Supports both Buzz credits and Membership rewards
            </Text>

            <Divider className={classes.subtleDivider} />

            {/* Benefits Section */}
            <BenefitsSection />

            <Divider className={classes.subtleDivider} />

            {/* Purchase Options */}
            {liveFeatures.buzzGiftCards && <PurchaseOptionsCard />}

            {/* Footer Info */}
            <div className={classes.footerSection}>
              <Text ta="center" size="xs" c="dimmed">
                Need help?{' '}
                <Anchor href="/support" size="xs" className={classes.footerLink}>
                  Contact Support
                </Anchor>
                {' • '}
                <Anchor href="/pricing" size="xs" className={classes.footerLink}>
                  Learn about Memberships
                </Anchor>
              </Text>
            </div>
          </Stack>
        </Container>
      </div>
    </>
  );
}
