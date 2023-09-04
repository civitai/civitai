import {
  Badge,
  Box,
  Button,
  Container,
  Divider,
  Grid,
  Group,
  Stack,
  Text,
  Title,
  createStyles,
} from '@mantine/core';
import { InferGetServerSidePropsType } from 'next';
import Link from 'next/link';
import React from 'react';
import { z } from 'zod';

import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Sidebar } from '~/components/Article/Detail/Sidebar';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { Meta } from '~/components/Meta/Meta';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { SensitiveShield } from '~/components/SensitiveShield/SensitiveShield';
import { TrackView } from '~/components/TrackView/TrackView';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsMobile } from '~/hooks/useIsMobile';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { formatDate } from '~/utils/date-helpers';
import { removeEmpty } from '~/utils/object-helpers';
import { parseNumericString } from '~/utils/query-string-helpers';
import { trpc } from '~/utils/trpc';
import { isNsfwImage } from '~/server/common/model-helpers';
import { ImageCarousel } from '~/components/Bounty/ImageCarousel';

const querySchema = z.object({
  id: z.preprocess(parseNumericString, z.number()),
  slug: z.array(z.string()).optional(),
});

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  useSession: true,
  resolver: async ({ ctx, ssg, session }) => {
    const features = getFeatureFlags({ user: session?.user });
    if (!features.articles) return { notFound: true };

    const result = querySchema.safeParse(ctx.query);
    if (!result.success) return { notFound: true };

    if (ssg) await ssg.bounty.getById.prefetch({ id: result.data.id });

    return { props: removeEmpty(result.data) };
  },
});

export default function BountyDetailsPage({
  id,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const currentUser = useCurrentUser();
  const { classes, theme } = useStyles();
  const mobile = useIsMobile();

  const { data: bounty, isLoading } = trpc.bounty.getById.useQuery({ id });
  const [mainImage] = bounty?.images ?? [];

  const meta = (
    <Meta
      title={`Civitai | ${bounty?.name}`}
      image={
        !mainImage || isNsfwImage(mainImage) || bounty?.nsfw
          ? undefined
          : getEdgeUrl(mainImage.url, { width: 1200 })
      }
      description={bounty?.description}
    />
  );

  if (isLoading) return <PageLoader />;
  if (!bounty) return <NotFound />;

  if ((bounty.nsfw || isNsfwImage(mainImage)) && !currentUser) {
    return (
      <>
        {meta}
        <SensitiveShield />
      </>
    );
  }

  console.log(bounty, mainImage);

  return (
    <>
      {meta}
      <TrackView entityId={bounty.id} entityType="Bounty" type="BountyView" />
      <Container size="xl">
        <Stack spacing={0} mb="xl">
          <Group position="apart" noWrap>
            <Title weight="bold" className={bounty.name}>
              {bounty.name}
            </Title>
          </Group>
          <Group spacing={8}>
            <UserAvatar user={bounty.user} withUsername linkToProfile />
            <Divider orientation="vertical" />
            <Text color="dimmed" size="sm">
              {bounty.startsAt ? formatDate(bounty.startsAt) : 'Draft'}
            </Text>
          </Group>
        </Stack>
        <Grid>
          <Grid.Col xs={12} md={8}>
            <Stack spacing="xs">
              <ImageCarousel
                images={bounty.images}
                nsfw={bounty.nsfw}
                entityId={bounty.id}
                entityType="bounty"
              />
              <Title order={2} mt="sm">
                About this bounty
              </Title>
              <article>
                <RenderHtml html={bounty.description} />
              </article>
              <Divider />
            </Stack>
          </Grid.Col>
        </Grid>
      </Container>
    </>
  );
}

const useStyles = createStyles((theme) => ({
  titleWrapper: {
    gap: theme.spacing.xs,

    [theme.fn.smallerThan('md')]: {
      gap: theme.spacing.xs * 0.4,
    },
  },

  title: {
    wordBreak: 'break-word',
    [theme.fn.smallerThan('md')]: {
      fontSize: theme.fontSizes.xs * 2.4, // 24px
      width: '100%',
      paddingBottom: 0,
    },
  },

  badgeText: {
    fontSize: theme.fontSizes.md,
    [theme.fn.smallerThan('md')]: {
      fontSize: theme.fontSizes.sm,
    },
  },
}));
