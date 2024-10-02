import {
  Box,
  Button,
  Container,
  createStyles,
  Group,
  Image,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { NextLink } from '@mantine/next';
import { IconCloudPlus, IconDownload, IconMapSearch, IconRadar2 } from '@tabler/icons-react';
import { Meta } from '~/components/Meta/Meta';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsMobile } from '~/hooks/useIsMobile';
import { containerQuery } from '~/utils/mantine-css-helpers';

export default function CivitaiVault() {
  const { classes, cx } = useStyles();
  const currentUser = useCurrentUser();
  const isMember = currentUser?.isMember;
  const buttonData = {
    text: isMember ? 'Go to my Vault' : 'Become a Supporter',
    href: isMember ? '/user/vault' : '/pricing',
  };
  const isMobile = useIsMobile();

  return (
    <>
      <Meta
        title="Civitai Vault | Store your favorite models forever"
        description="Civitai Vault is a place to store your favorite models forever. Even if a model is removed from the site, you can still access it here."
      />
      <Container size="md" mb="lg">
        <Stack spacing={40}>
          <Group position="apart">
            <Stack spacing={12}>
              <Title className={classes.heroTitle}>Civitai Vault</Title>
              {isMember ? (
                <Text className={classes.heroText} sx={{ lineHeight: 1.25 }}>
                  Keep Your Favorite Models Forever
                </Text>
              ) : (
                <Text className={classes.heroText} sx={{ lineHeight: 1.25 }}>
                  ❤️ Civitai Vault is only available to Supporters
                </Text>
              )}
            </Stack>
            <Button
              variant="filled"
              color="blue"
              size="lg"
              radius="xl"
              component={NextLink}
              href={buttonData.href}
              rel="nofollow noreferrer"
              fullWidth={isMobile}
            >
              {buttonData.text}
            </Button>
          </Group>
          <Box className={classes.gradientContainer}>
            <Image
              src="/images/product/vault/lp-main.png"
              alt="check out the vault"
              width="100%"
              height="auto"
            />
            <Box className={classes.gradientBox} />
          </Box>
          <Stack spacing={12}>
            <Title className={classes.heading3} order={3}>
              Keep Your Favorite Models Forever
            </Title>
            <Text>
              {`Civitai Vault is your secure, cloud-based storage solution for your most cherished AI models. Even if a creator removes a model, it remains safely stored in your personal vault. Free up valuable disk space and have peace of mind knowing your models are always accessible.`}
            </Text>
          </Stack>
          <Stack spacing={60}>
            <Group noWrap>
              <ThemeIcon size={72} variant="light" color="green" radius={1000}>
                <IconCloudPlus size={40} />
              </ThemeIcon>

              <Stack spacing={0}>
                <Title className={classes.heading4} order={4}>
                  Effortlessly Save Models
                </Title>
                <Text>
                  Seamlessly save any model to your vault. Your storage capacity is determined by
                  your Supporter tier, ensuring you have ample space for your collection.
                </Text>
              </Stack>
            </Group>
            <Group noWrap>
              <ThemeIcon size={72} variant="light" color="blue" radius={1000}>
                <IconMapSearch size={40} />
              </ThemeIcon>

              <Stack spacing={0}>
                <Title className={classes.heading4} order={4}>
                  Intuitive Organization Tools
                </Title>
                <Text>
                  Managing a vast library of models is a breeze with our powerful search
                  functionality, customizable filters, and the ability to add personal notes.
                  Quickly find the perfect model for your needs.
                </Text>
              </Stack>
            </Group>
            <Group noWrap>
              <ThemeIcon size={72} variant="light" color="green" radius={1000}>
                <IconDownload size={40} />
              </ThemeIcon>

              <Stack spacing={0}>
                <Title className={classes.heading4} order={4}>
                  Download on Demand
                </Title>
                <Text>
                  Access and download your stored models whenever you require them, from any device,
                  at any time. Your creativity knows no bounds with Civitai Vault.
                </Text>
              </Stack>
            </Group>
            <Group noWrap>
              <ThemeIcon size={72} variant="light" color="blue" radius={1000}>
                <IconRadar2 size={40} />
              </ThemeIcon>

              <Stack spacing={0}>
                <Title className={classes.heading4} order={4}>
                  Automatic Updates{' '}
                  <Text color="dimmed" component="span" size="xs">
                    Coming Soon
                  </Text>
                </Title>
                <Text>
                  Stay up-to-date with the latest versions of your favorite models. Civitai Vault
                  automatically checks for updates and notifies you when new versions are available,
                  ensuring you always have access to the most advanced iterations.
                </Text>
              </Stack>
            </Group>
            {isMember ? (
              <Text ta="center" size="lg" fs="italic">
                Upgrade your membership to expand your Civitai Vault storage capacity and unlock
                additional features.
              </Text>
            ) : (
              <Text ta="center" size="lg" fs="italic">
                Civitai Vault is only available to Supporters. Become a Supporter to access Civitai
                Vault and enjoy a host of other benefits.
              </Text>
            )}
          </Stack>
          <Button
            variant="filled"
            color="blue"
            size="lg"
            radius="xl"
            component={NextLink}
            href={buttonData.href}
            rel="nofollow noreferrer"
            fullWidth
          >
            {buttonData.text}
          </Button>
          <Stack spacing={0}>
            <Text
              size="xs"
              color="dimmed"
            >{`*Upon cancellation of your membership, you will have 7 days to download things from your Vault after which they will remain in your Vault for 23 more days, but you will be unable to download them.`}</Text>
            <Text
              size="xs"
              color="dimmed"
            >{`**Models that are removed from the site for Terms of Service violations will also be removed from your Vault.`}</Text>
          </Stack>
        </Stack>
      </Container>
    </>
  );
}

const useStyles = createStyles((theme) => ({
  cta: {
    height: 52,
  },
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
  heading3: {
    fontSize: 32,
    fontWeight: 700,
    color: theme.colorScheme === 'dark' ? '#fff' : theme.colors.gray[9],
  },
  heading4: {
    fontSize: 20,
    fontWeight: 700,
    color: theme.colorScheme === 'dark' ? '#fff' : theme.colors.gray[9],
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
