import {
  Container,
  Stack,
  Text,
  Title,
  Group,
  ThemeIcon,
  Button,
  Anchor,
  TextInput,
  Center,
  Loader,
  Divider,
} from '@mantine/core';
import {
  IconTicket,
  IconGift,
  IconBolt,
  IconCrown,
  IconRocket,
  IconUsers,
  IconPhoto,
} from '@tabler/icons-react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import React, { useEffect, useState } from 'react';
import { Meta } from '~/components/Meta/Meta';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { env } from '~/env/client';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { numberWithCommas } from '~/utils/number-helpers';
import { showNotification } from '@mantine/notifications';
import { trpc } from '~/utils/trpc';
import classes from '~/pages/redeem-code-improved.module.scss';

const RedeemCodeModal = dynamic(() =>
  import('~/components/RedeemableCode/RedeemCodeModal').then((x) => x.RedeemCodeModal)
);

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

const RedeemCodeCard = () => {
  const [code, setCode] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const redeemCodeMutation = trpc.redeemableCode.consume.useMutation({
    onSuccess: (result: { unitValue: number; type: string }) => {
      setCode('');
      setIsLoading(false);
      showNotification({
        title: '🎉 Code redeemed successfully!',
        message: `You received ${numberWithCommas(result.unitValue)} Buzz!`,
        color: 'green',
        autoClose: 5000,
      });
    },
    onError: (error: { message: string }) => {
      setIsLoading(false);
      showNotification({
        title: 'Failed to redeem code',
        message: error.message,
        color: 'red',
      });
    },
  });

  const handleRedeem = async () => {
    if (!code.trim()) {
      showNotification({
        title: 'Missing Code',
        message: 'Please enter a code to redeem',
        color: 'yellow',
      });
      return;
    }

    setIsLoading(true);
    redeemCodeMutation.mutate({ code: code.trim() });
  };

  const handleCodeChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    // Remove spaces and convert to uppercase automatically
    const cleanedCode = event.currentTarget.value.replace(/\s+/g, '').toUpperCase();
    setCode(cleanedCode);
  };

  const handleKeyPress = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' && !isLoading) {
      handleRedeem();
    }
  };

  return (
    <div className={classes.redeemSection}>
      <Group gap="lg" wrap="nowrap" align="flex-start">
        {/* Icon Section */}
        <div className={classes.iconSection}>
          <ThemeIcon
            size="xl"
            variant="gradient"
            gradient={{ from: 'yellow.4', to: 'orange.5' }}
            radius="md"
          >
            <IconTicket size={28} />
          </ThemeIcon>
        </div>

        {/* Content Section */}
        <div className={classes.contentSection}>
          <Stack gap="sm">
            <div>
              <Text size="xl" fw={700} className={classes.redeemTitle}>
                Redeem Your Code
              </Text>
              <Text size="sm" c="dimmed" className={classes.redeemDescription}>
                Enter your unique code to instantly receive rewards
              </Text>
            </div>

            <Group gap="sm" wrap="nowrap" className={classes.inputGroup}>
              <TextInput
                placeholder="BUZZ-CODE-HERE"
                value={code}
                onChange={handleCodeChange}
                onKeyPress={handleKeyPress}
                size="lg"
                disabled={isLoading}
                className={classes.codeInput}
                style={{ flex: 1 }}
                variant="filled"
              />

              <Button
                onClick={handleRedeem}
                loading={isLoading}
                size="lg"
                variant="gradient"
                gradient={{ from: 'yellow.4', to: 'orange.5' }}
                className={classes.redeemButton}
                px="xl"
                radius="md"
              >
                {isLoading ? <Loader size="sm" color="white" /> : 'Redeem'}
              </Button>
            </Group>

            <Text size="xs" c="dimmed" className={classes.helpText}>
              Case-insensitive • Spaces auto-removed • Instant processing
            </Text>
          </Stack>
        </div>
      </Group>
    </div>
  );
};

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
            Purchase redeemable codes for Buzz or Memberships from our store
          </Text>
          <Group gap="sm">
            <Button
              component="a"
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
              href="#store" // Will be updated with actual store URL
              variant="outline"
              color="gray"
              size="sm"
              leftSection={<IconGift size={16} />}
            >
              Gift Codes
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
                <IconCrown fill="currentColor" size={20} />
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

  // Handle direct redemption from URL parameters
  useEffect(() => {
    if (!query?.code || typeof window === 'undefined') return;
    dialogStore.trigger({
      id: 'redeem-code',
      component: RedeemCodeModal,
      props: { code: query.code as string },
    });
  }, [query.code]);

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
            <RedeemCodeCard />

            {/* Info Alert */}
            <Text size="sm" c="dimmed" ta="center" className={classes.infoText}>
              Codes are processed instantly • Supports both Buzz credits and Membership rewards
            </Text>

            <Divider className={classes.subtleDivider} />

            {/* Benefits Section */}
            <BenefitsSection />

            <Divider className={classes.subtleDivider} />

            {/* Purchase Options */}
            <PurchaseOptionsCard />

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
