import {
  // AspectRatio,
  Container,
  createStyles,
  Flex,
  Grid,
  Stack,
  Text,
  Title,
  Image,
} from '@mantine/core';
import dynamic from 'next/dynamic';
// import { YoutubeEmbed } from '~/components/YoutubeEmbed/YoutubeEmbed';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { Meta } from '~/components/Meta/Meta';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { fetchLinkReleases } from '~/utils/fetch-link-releases';
import { CivitaiLinkDownloadButton } from '~/components/CivitaiLink/CivitaiLinkDownloadButton';

const LinkAnimation = dynamic(
  () => import('~/components/Animations/LinkAnimation').then((mod) => mod.LinkAnimation),
  { ssr: false }
);

type ServerSideProps = {
  secondaryText: string;
  href: string;
};

export const getServerSideProps = createServerSideProps({
  resolver: async ({ ctx: req }) => {
    const userAgent = req.req.headers['user-agent'];
    const data = await fetchLinkReleases(userAgent || '');

    return {
      props: {
        secondaryText: `${data.os} ${data.tag_name}`,
        href: data.href,
      },
    };
  },
});

export default function LinkApp(props: ServerSideProps) {
  const { classes } = useStyles();
  const currentUser = useCurrentUser();
  const isMember = currentUser?.isMember;
  const buttonData = {
    text: isMember ? 'Download the Link App' : 'Become a Supporter',
    secondaryText: props.secondaryText,
    href: isMember ? props.href : '/pricing',
  };

  return (
    <>
      <Meta
        title="Civitai Link | One-click install Stable Diffusion & Flux models"
        description="Directly download any resource from Civitai to your local model library."
      />
      <Container>
        <Flex
          direction={{ base: 'column', md: 'row' }}
          justify="space-between"
          className={classes.heroContainer}
        >
          <Stack gap={12} mb={{ base: 24, md: 0 }}>
            <Title className={classes.heroTitle} order={1}>
              Civitai Link App
            </Title>
            <Text className={classes.copy}>For Windows, Linux, and MacOS.</Text>
            {!isMember ? (
              <Text className={classes.heroText}>
                ❤️ Civitai Link is only available to Supporters
              </Text>
            ) : null}
          </Stack>
          <Flex align="center">
            <CivitaiLinkDownloadButton {...buttonData} isMember={isMember} />
          </Flex>
        </Flex>

        <Flex direction="row" className={classes.gradientContainer}>
          <LinkAnimation justify="center" className={classes.videoBorder} />
          <div className={classes.gradientBox} />
        </Flex>

        <Stack gap={12} mb={40}>
          <Title className={classes.heading} order={2}>
            Add models to your local library with one click
          </Title>
          <Text className={classes.copy}>
            Directly add any resource from Civitai to your local model library with just one click.
          </Text>
        </Stack>

        <Grid gutter={40} gutterMd={80}>
          <Grid.Col md={6}>
            <Flex justify="center" className={classes.gradientContainer}>
              <Image
                src="/images/link/glance.png"
                alt="download"
                id="download"
                width="auto"
                imageProps={{
                  style: { objectFit: 'cover', objectPosition: 'top', height: '100%' },
                }}
              />
              <div className={classes.gradientBox} />
            </Flex>
            <Title className={classes.heading}>
              See instantly which models you have stored in your local library as you browse the
              site
            </Title>
          </Grid.Col>
          <Grid.Col md={6}>
            <Flex justify="center" className={classes.gradientContainer}>
              <Image
                src="/images/link/pair.png"
                alt="activity"
                id="activity"
                width="auto"
                imageProps={{
                  style: { objectFit: 'cover', objectPosition: 'top', height: '100%' },
                }}
              />
              <div className={classes.gradientBox} />
            </Flex>
            <Title className={classes.heading} order={3}>
              Pair with your Civitai Vault to free-up local disk space
            </Title>
            <Text className={classes.copy}>
              Models saved to Civitai Vault remain accessible, even if removed from Civitai by the
              creator.
            </Text>
          </Grid.Col>
        </Grid>
        <Grid gutter={40} gutterMd={80}>
          <Grid.Col md={6}>
            <Flex justify="center" className={classes.gradientContainer}>
              <Image
                src="/images/link/download.png"
                alt="download"
                id="download"
                width="auto"
                imageProps={{
                  style: { objectFit: 'cover', objectPosition: 'top', height: '100%' },
                }}
              />
              <div className={classes.gradientBox} />
            </Flex>
            <Title className={classes.heading} order={3}>
              Manage your files
            </Title>
            <Text className={classes.copy}>
              Sync your local model library to Civitai for image previews, trigger words, and more.
            </Text>
          </Grid.Col>
          <Grid.Col md={6}>
            <Flex justify="center" className={classes.gradientContainer}>
              <Image
                src="/images/link/activity.png"
                alt="activity"
                id="activity"
                width="auto"
                imageProps={{
                  style: { objectFit: 'cover', objectPosition: 'top', height: '100%' },
                }}
              />
              <div className={classes.gradientBox} />
            </Flex>
            <Title className={classes.heading} order={3}>
              Keep track of your activities
            </Title>
            <Text className={classes.copy}>
              View the history of all models you&apos;ve added to your local model library.
            </Text>
          </Grid.Col>
        </Grid>

        {/* TODO: Add video once created */}
        {/* <AspectRatio ratio={16 / 9} my={40}>
        <YoutubeEmbed videoId="MaSRXvM05x4" />
      </AspectRatio> */}

        <Flex justify="center" w="100%" my={40}>
          <CivitaiLinkDownloadButton {...buttonData} isMember={isMember} />
        </Flex>
      </Container>
    </>
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
    color: theme.colorScheme === 'dark' ? theme.white : theme.colors.gray[9],
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
    color: theme.colorScheme === 'dark' ? theme.white : theme.colors.gray[9],
  },
  copy: {
    fontSize: 16,
    fontWeight: 500,
    marginTop: 8,
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
