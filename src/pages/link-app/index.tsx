import {
  AspectRatio,
  Button,
  Container,
  createStyles,
  Flex,
  Grid,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { YoutubeEmbed } from '~/components/YoutubeEmbed/YoutubeEmbed';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { NextLink } from '@mantine/next';
import linkAnimation from '~/utils/lotties/link-animation.json';

export default function LinkApp() {
  const { classes } = useStyles();
  const currentUser = useCurrentUser();
  const isMember = currentUser?.isMember;
  const buttonData = {
    text: isMember ? 'Download the Link App' : 'Become a member',
    href: isMember ? 'https://github.com/civitai/civitai-link-desktop/releases/latest' : '/pricing',
  };

  return (
    <Container size="md">
      <Flex direction="row" justify="space-between" className={classes.heroContainer}>
        <Stack spacing={12}>
          <Title className={classes.heroTitle}>Civitai Link App</Title>
          {!isMember ? (
            <Text className={classes.heroText}>❤️ Civitia Link is only available to members</Text>
          ) : null}
        </Stack>
        <Flex align="center">
          <Button
            variant="filled"
            color="blue"
            size="lg"
            radius="xl"
            component={NextLink}
            href={buttonData.href}
          >
            {buttonData.text}
          </Button>
        </Flex>
      </Flex>

      {/* TODO: Insert Lottie */}
      <Flex direction="row" className={classes.gradientContainer}>
        <Flex justify="center" className={classes.videoBorder}>
          {/* <LottiePlayer
            src={linkAnimation}
            background="transparent"
            speed="1"
            direction="1"
            playMode="normal"
            loop
            autoplay
          /> */}
        </Flex>
        <div className={classes.gradientBox} />
      </Flex>

      <Stack spacing={12} mb={40}>
        <Title className={classes.heading}>Add models to SD</Title>
        <Text className={classes.copy}>
          Directly add any models from Civitai to your Stable Diffusion instance.
        </Text>
      </Stack>

      {/* TODO: Update copy */}
      <Grid gutter={40} gutterMd={80}>
        <Grid.Col md={6}>
          {/* TODO: Image */}
          <Title className={classes.heading}>Manage files</Title>
          <Text className={classes.copy}>
            Directly add any models from Civitai to your Stable Diffusion instance.
          </Text>
        </Grid.Col>
        <Grid.Col md={6}>
          {/* TODO: Image */}
          <Title className={classes.heading}>Keep track of activities</Title>
          <Text className={classes.copy}>
            See the history of all the models you have added to your Stable Diffusion instance.
          </Text>
        </Grid.Col>
      </Grid>

      {/* TODO: Replace video */}
      <AspectRatio ratio={16 / 9} my={40}>
        <YoutubeEmbed videoId="MaSRXvM05x4" />
      </AspectRatio>

      <Button
        variant="filled"
        color="blue"
        size="lg"
        radius="xl"
        fullWidth
        component={NextLink}
        href={buttonData.href}
      >
        Become a member
      </Button>
    </Container>
  );
}

const useStyles = createStyles((theme) => ({
  heroContainer: {
    marginTop: 40,
    marginBottom: 40,
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
