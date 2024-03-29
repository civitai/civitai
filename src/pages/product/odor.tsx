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
import {
  Icon3dCubeSphere,
  IconAccessible,
  IconAirConditioning,
  IconBrandOpenSource,
  IconCloudPlus,
  IconDownload,
  IconLungsOff,
  IconMapSearch,
  IconPepper,
  IconRadar2,
} from '@tabler/icons-react';
import { Meta } from '~/components/Meta/Meta';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsMobile } from '~/hooks/useIsMobile';
import { containerQuery } from '~/utils/mantine-css-helpers';

export default function CivitaiVault() {
  const { classes, cx } = useStyles();
  const currentUser = useCurrentUser();
  const isMember = currentUser?.isMember;
  const isMobile = useIsMobile();

  return (
    <>
      <Meta
        title="Civitai O.D.O.R | Next generation open-source text-to-scent model"
        description="Civitai O.D.O.R is the next generation open-source text-to-scent model. Get a whiff of creativity utilizing the most powerful sense the human body has: Smell."
      />
      <Container size="md" mb="lg">
        <Stack spacing={40}>
          <Group position="apart">
            <Stack spacing={12}>
              <Title className={classes.heroTitle}>O.D.O.R</Title>
              <Text className={classes.heroText} sx={{ lineHeight: 1.25 }}>
                Open-source text-to-scent model
              </Text>
            </Stack>
            <Button
              variant="filled"
              color="blue"
              size="lg"
              radius="xl"
              component="a"
              href="https://community-content.civitai.com/odor_whitepaper.pdf"
              target="_blank"
              rel="nofollow noreferrer"
              fullWidth={isMobile}
            >
              View Whitepaper
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
              Open-sourcing text-to-scent
            </Title>
            <Text>
              {`ODOR is to your nose what Stable Diffusion is for your eyes. Get a whiff of creativity utilizing the most powerful sense the human body has: Smell.`}
            </Text>
          </Stack>
          <Stack spacing={60}>
            <Group noWrap>
              <ThemeIcon size={72} variant="light" color="green" radius={1000}>
                <IconAccessible size={40} />
              </ThemeIcon>

              <Stack spacing={0}>
                <Title className={classes.heading4} order={4}>
                  A generation model for anyone
                </Title>
                <Text>
                  {`Furthering our commitment to "AI for All" ODOR is able to be enjoyed by segments of the population previously excluded from the AI movement, unlike other ableist generation models focused on image, video or audio.`}
                </Text>
              </Stack>
            </Group>
            <Group noWrap>
              <ThemeIcon size={72} variant="light" color="blue" radius={1000}>
                <IconPepper size={40} />
              </ThemeIcon>

              <Stack spacing={0}>
                <Title className={classes.heading4} order={4}>
                  Nothing to hold your nose at
                </Title>
                <Text>
                  {`Mature content friendly: natively able to prompt for scents like leather, latex, sweat, and old shoes.*`}
                </Text>
              </Stack>
            </Group>
            <Group noWrap>
              <ThemeIcon size={72} variant="light" color="green" radius={1000}>
                <Icon3dCubeSphere size={40} />
              </ThemeIcon>

              <Stack spacing={0}>
                <Title className={classes.heading4} order={4}>
                  Breathe in the future
                </Title>
                <Text>
                  {`Open sourced for endless improvements. With theoretical adaptations for Img2scent, Video2scent and Scent2video possible, ODOR opens the door for all kinds of potential content innovations.`}
                </Text>
              </Stack>
            </Group>
            <Group noWrap>
              <ThemeIcon size={72} variant="light" color="blue" radius={1000}>
                <IconAirConditioning size={40} />
              </ThemeIcon>

              <Stack spacing={0}>
                <Title className={classes.heading4} order={4}>
                  Think it, type it, smell it
                </Title>
                <Text>
                  {`Designed to work with a wide range of Atmospheric Regulator and Emitter of Olfactory Ligands Apparatus's (AREOLA's) ODOR's can be run with minimum hardware requirements.`}
                </Text>
              </Stack>
            </Group>
            <Group noWrap>
              <ThemeIcon size={72} variant="light" color="yellow" radius={1000}>
                <IconLungsOff size={40} />
              </ThemeIcon>

              <Stack spacing={0}>
                <Title className={classes.heading4} order={4} color="yellow">
                  WARNING
                </Title>
                <Text>
                  {`The creation of ODOR's intended to mimic Carbon monoxide, Ethylene oxide, Ammonia, Carbon dioxide, Arsine, Chlorine, Hydrogen sulfide, Boron trifluoride, Dichlorosilane, Sulfur dioxide, Arsenic pentafluoride, Ozone, or any flammable gases is strictly prohibited. Doing so may result in harm to biological users.`}
                </Text>
              </Stack>
            </Group>
          </Stack>
          <Button
            variant="filled"
            color="blue"
            size="lg"
            radius="xl"
            component={NextLink}
            href="/models?base model=ODOR"
            rel="nofollow noreferrer"
            fullWidth
          >
            View the Models
          </Button>
          <Stack spacing={0}>
            <Text
              size="xs"
              color="dimmed"
            >{`* Some smells may be confusing or difficult to distinguish to inexperienced users.`}</Text>
            <Text
              size="xs"
              color="dimmed"
            >{`** While ODOR brings a new dimension to sensory technology, its full bouquet of features blossoms in the fertile ground of imagination. As we continue to explore the frontiers of possibility, remember that the essence of discovery often lies in the journey, not just the destination. Happy explorations!`}</Text>
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
