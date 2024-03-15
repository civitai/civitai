import {
  Container,
  Title,
  Text,
  Button,
  Stack,
  Group,
  createStyles,
  Image,
  Box,
  ThemeIcon,
} from '@mantine/core';
import { useRouter } from 'next/router';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { Meta } from '~/components/Meta/Meta';
import { NextLink } from '@mantine/next';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { IconCloudPlus, IconDownload, IconMapSearch } from '@tabler/icons-react';
import { useIsMobile } from '~/hooks/useIsMobile';

export default function CivitaiVault() {
  const { classes, cx } = useStyles();
  const currentUser = useCurrentUser();
  const isMember = currentUser?.isMember;
  const buttonData = {
    text: isMember ? 'Go to my Vault' : 'Become a member',
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
              <Text className={classes.heroText} sx={{ lineHeight: 1.25 }}>
                ❤️ Civitai Vault is only available to members
              </Text>
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
              Save models. Download anytime. Forever
            </Title>
            <Text>
              Vault is a place for all your models. You can download them even after the creator
              deleted them from Civitai
            </Text>
          </Stack>
          <Stack spacing={60}>
            <Group noWrap>
              <ThemeIcon size={72} variant="light" color="green" radius={1000}>
                <IconCloudPlus size={40} />
              </ThemeIcon>

              <Stack spacing={0}>
                <Title className={classes.heading4} order={4}>
                  Save Models
                </Title>
                <Text>
                  Save any models you like to your vault. You get different vault sizes based on
                  your membership tier.
                </Text>
              </Stack>
            </Group>
            <Group noWrap>
              <ThemeIcon size={72} variant="light" color="blue" radius={1000}>
                <IconMapSearch size={40} />
              </ThemeIcon>

              <Stack spacing={0}>
                <Title className={classes.heading4} order={4}>
                  Search, filter, add notes
                </Title>
                <Text>Have lots of models? Easily find them with searchm, filters, and notes!</Text>
              </Stack>
            </Group>
            <Group noWrap>
              <ThemeIcon size={72} variant="light" color="green" radius={1000}>
                <IconDownload size={40} />
              </ThemeIcon>

              <Stack spacing={0}>
                <Title className={classes.heading4} order={4}>
                  Download when you need
                </Title>
                <Text>Whenever you need!</Text>
              </Stack>
            </Group>
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
