import {
  // AspectRatio,
  Container,
  Flex,
  Grid,
  Stack,
  Text,
  Title,
  Image,
} from '@mantine/core';
import dynamic from 'next/dynamic';
// import { YoutubeEmbed } from '~/components/YoutubeEmbed/YoutubeEmbed';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { Meta } from '~/components/Meta/Meta';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { fetchLinkReleases } from '~/utils/fetch-link-releases';
import { CivitaiLinkDownloadButton } from '~/components/CivitaiLink/CivitaiLinkDownloadButton';

import classes from '~/styles/utils.module.scss';

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
            <Text className="text-base font-medium text-gray-9 dark:text-white">
              For Windows, Linux, and MacOS.
            </Text>
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
          <LinkAnimation
            justify="center"
            className="w-full rounded-xl border border-b-0 border-[#2D2E32]"
          />
          <div className={classes.gradientBox} />
        </Flex>

        <Stack gap={12} mb={40}>
          <Title className={classes.heading} order={2}>
            Add models to your local library with one click
          </Title>
          <Text className="text-base font-medium text-gray-9 dark:text-white">
            Directly add any resource from Civitai to your local model library with just one click.
          </Text>
        </Stack>

        <Grid gutter={{ base: 40, md: 80 }}>
          <Grid.Col span={{ base: 12, md: 6 }}>
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
          <Grid.Col span={{ base: 12, md: 6 }}>
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
            <Text className="text-base font-medium text-gray-9 dark:text-white">
              Models saved to Civitai Vault remain accessible, even if removed from Civitai by the
              creator.
            </Text>
          </Grid.Col>
        </Grid>
        <Grid gutter={{ base: 40, md: 80 }}>
          <Grid.Col span={{ base: 12, md: 6 }}>
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
            <Text className="text-base font-medium text-gray-9 dark:text-white">
              Sync your local model library to Civitai for image previews, trigger words, and more.
            </Text>
          </Grid.Col>
          <Grid.Col span={{ base: 12, md: 6 }}>
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
              <div
                className="absolute inset-0"
                style={{
                  background: 'linear-gradient(180deg, rgba(26, 27, 30, 0.00) 50%, #1A1B1E 100%)',
                }}
              />
            </Flex>
            <Title className={classes.heading} order={3}>
              Keep track of your activities
            </Title>
            <Text className="text-base font-medium text-gray-9 dark:text-white">
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
