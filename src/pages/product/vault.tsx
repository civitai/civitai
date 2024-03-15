import {
  Card,
  Container,
  Title,
  Text,
  Button,
  Stack,
  Center,
  Loader,
  Alert,
  Tabs,
  List,
  ThemeIcon,
  Group,
  createStyles,
  Flex,
} from '@mantine/core';
import { trpc } from '~/utils/trpc';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { SubscribeButton } from '~/components/Stripe/SubscribeButton';
import { PlanCard } from '~/components/Stripe/PlanCard';
import { ManageSubscriptionButton } from '~/components/Stripe/ManageSubscriptionButton';
import {
  IconCalendarDue,
  IconCircleCheck,
  IconExclamationMark,
  IconHeartHandshake,
} from '@tabler/icons-react';
import { DonateButton } from '~/components/Stripe/DonateButton';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { PlanBenefitList } from '~/components/Stripe/PlanBenefitList';
import { joinRedirectReasons, JoinRedirectReason } from '~/utils/join-helpers';
import { useRouter } from 'next/router';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { ContainerGrid } from '~/components/ContainerGrid/ContainerGrid';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { Meta } from '~/components/Meta/Meta';
import { NextLink } from '@mantine/next';

export default function CivitaiVault() {
  const router = useRouter();
  const { classes, cx } = useStyles();
  const currentUser = useCurrentUser();
  const isMember = currentUser?.isMember;
  const buttonData = {
    text: isMember ? 'Go to my Vault' : 'Become a member',
    href: isMember ? '/user/vault' : '/pricing',
  };

  return (
    <>
      <Meta
        title="Civitai Vault | Store your favorite models forever"
        description="Civitai Vault is a place to store your favorite models forever. Even if a model is removed from the site, you can still access it here."
      />
      <Container size="lg" mb="lg">
        <Stack>
          <Group>
            <Stack spacing={4}>
              <Title align="center" className={classes.title}>
                Civitai Vault
              </Title>
              <Text align="center" className={classes.introText} sx={{ lineHeight: 1.25 }}>
                ❤️ Civitai Vault is only available to members
              </Text>
            </Stack>
            <Button
              variant="filled"
              color="blue"
              size="lg"
              radius="xl"
              fullWidth
              component={NextLink}
              href={buttonData.href}
              rel="nofollow noreferrer"
            >
              {buttonData.text}
            </Button>{' '}
          </Group>
        </Stack>
      </Container>
    </>
  );
}

const useStyles = createStyles((theme) => ({
  cta: {
    height: 52,
  }
  heroTitle: {
    fontSize: 32,
    fontWeight: 700,
    color: theme.colorScheme === 'dark' ? '#fff' : theme.colors.gray[9],
    [containerQuery.largerThan('md')]: {
      fontSize: 40,
    },
  },
  heroText: {
    fontSize: 14,
    fontWeight: 500,
  },
  heading: {
    fontSize: 24,
    fontWeight: 700,
    color: theme.colorScheme === 'dark' ? '#fff' : theme.colors.gray[9],
  },
  copy: {
    fontSize: 16,
    fontWeight: 500,
  },
  videoBorder: {
    borderRadius: 12,
    width: '100%',
    border: '1px solid #2D2E32',
    borderBottom: 'none',
  },
  gradientContainer: {
    position: 'relative',
    marginBottom: 24,
  },
  gradientBox: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'linear-gradient(180deg, rgba(26, 27, 30, 0.00) 50%, #1A1B1E 100%)',
  },
}));
