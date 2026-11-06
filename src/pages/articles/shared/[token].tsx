import { AspectRatio, Container, Divider, Group, Stack, Text, Title } from '@mantine/core';
import { IconEye } from '@tabler/icons-react';
import type { InferGetServerSidePropsType } from 'next';
import { useMemo } from 'react';
import * as z from 'zod';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { Page } from '~/components/AppLayout/Page';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { Gated } from '~/components/Gated/Gated';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { Meta } from '~/components/Meta/Meta';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { RenderRichText } from '~/components/RichTextEditor/RenderRichText';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { constants } from '~/server/common/constants';
import { getSharedArticleSchema } from '~/server/schema/article.schema';
import type { SharedArticle } from '~/server/services/article-share.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { formatDate } from '~/utils/date-helpers';
import { removeTags } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';

const querySchema = z.object({ token: z.string() });

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  useSession: true,
  prefetch: 'always',
  resolver: async ({ ctx, ssg }) => {
    // The token is a bearer credential in the URL: never stored by a shared cache, never sent
    // on as a referrer by links inside the draft, never indexed.
    ctx.res.setHeader('Cache-Control', 'private, no-store');
    ctx.res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    ctx.res.setHeader('Referrer-Policy', 'no-referrer');

    const query = querySchema.safeParse(ctx.query);
    const token = query.success ? query.data.token : '';
    if (!ssg || !getSharedArticleSchema.safeParse({ token }).success) return { props: { token } };

    const result = await ssg.article.getShared.fetch({ token }).catch(() => null);
    if (result?.status === 'published')
      return { redirect: { destination: result.url, permanent: false } };

    const gating =
      result?.status === 'ok' ? { contentNsfwLevel: result.article.nsfwLevel } : undefined;
    return { props: { token }, gating, suppressAds: true };
  },
});

function SharedArticlePage({ token }: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const valid = getSharedArticleSchema.safeParse({ token }).success;
  const { data, isLoading } = trpc.article.getShared.useQuery(
    { token },
    { enabled: valid, staleTime: Infinity, refetchOnWindowFocus: false, retry: false }
  );

  if (valid && isLoading) return <PageLoader />;
  if (data?.status === 'ok') return <SharedArticleView article={data.article} />;
  return (
    <SharedArticleMessage
      message={
        data?.status === 'checking'
          ? 'This draft is still being checked. Try again in a few minutes.'
          : 'This link is no longer available.'
      }
    />
  );
}

function SharedArticleMessage({ message }: { message: string }) {
  return (
    <>
      <Meta title="Shared draft | Civitai" deIndex />
      <Container size="sm" py="xl">
        <Text size="lg" ta="center">
          {message}
        </Text>
      </Container>
    </>
  );
}

function SharedArticleView({ article }: { article: SharedArticle }) {
  const coverImages = useMemo(() => [article.coverImage].filter(isDefined), [article.coverImage]);
  const { items } = useApplyHiddenPreferences({ type: 'images', data: coverImages });
  const [image] = items;

  return (
    <Gated
      contentNsfwLevel={article.nsfwLevel}
      suppressAds
      meta={{
        title: `${article.title} | Draft preview | Civitai`,
        description: removeTags(article.content ?? '').slice(0, 150),
        deIndex: true,
      }}
    >
      <Container size="md">
        <Stack gap="md" my="xl">
          <AlertWithIcon icon={<IconEye />} color="blue" iconColor="blue" size="lg">
            Draft preview — shared by the author. This article isn&apos;t published.
          </AlertWithIcon>
          <Title order={1}>{article.title}</Title>
          <Group gap={8}>
            <UserAvatar user={article.user} withUsername linkToProfile />
            <Divider orientation="vertical" />
            <Text c="dimmed" size="sm">
              Draft, last edited {formatDate(article.updatedAt)}
            </Text>
          </Group>
          {image && (
            <AspectRatio
              ratio={constants.article.coverImageWidth / constants.article.coverImageHeight}
            >
              <div className="relative size-full">
                <ImageGuard2 image={image} connectType="article" connectId={article.id}>
                  {(safe) => (
                    <div className="relative size-full">
                      <ImageGuard2.BlurToggle className="absolute left-2 top-2 z-10" />
                      {!safe ? (
                        <div className="relative h-full overflow-hidden rounded-lg object-cover">
                          <MediaHash {...image} />
                        </div>
                      ) : (
                        <EdgeMedia
                          src={image.url}
                          className="h-full rounded-lg object-cover"
                          name={image.name}
                          alt={article.title}
                          type={image.type}
                          width={1320}
                          anim={safe}
                        />
                      )}
                    </div>
                  )}
                </ImageGuard2>
              </div>
            </AspectRatio>
          )}
          {article.contentJson && (
            <article>
              <RenderRichText content={article.contentJson} fallbackHtml={article.content} />
            </article>
          )}
        </Stack>
      </Container>
    </Gated>
  );
}

export default Page(SharedArticlePage);
