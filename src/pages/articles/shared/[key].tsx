import { AspectRatio, Container, Divider, Group, Stack, Text, Title } from '@mantine/core';
import { IconEye } from '@tabler/icons-react';
import type { InferGetServerSidePropsType } from 'next';
import { useEffect, useMemo } from 'react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { ArticleDetailComments } from '~/components/Article/Detail/ArticleDetailComments';
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
import type { SharedArticle } from '~/server/services/article-share.service';
import { resolveSharedArticleRequest } from '~/server/services/article-share.page';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { useRouter } from 'next/router';
import { formatDate } from '~/utils/date-helpers';
import { removeTags } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';

// `/articles/shared/<token>` never renders: it trades the token for an HttpOnly cookie and
// redirects, so no script ever runs on a URL holding it. `/articles/shared/<articleId>` renders the
// draft, fetched after load with that cookie, so the server-rendered page names nothing about it.
export const getServerSideProps = createServerSideProps({
  useSSG: true,
  prefetch: 'always',
  resolver: async ({ ctx, ssg }) =>
    resolveSharedArticleRequest({
      key: String(ctx.query.key ?? ''),
      res: ctx.res,
      open: (shareToken) =>
        ssg
          ? ssg.article.openShareLink.fetch({ shareToken }).catch(() => null)
          : Promise.resolve(null),
    }),
});

function SharedArticlePage({ articleId }: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const router = useRouter();
  const { mutate, data, isError } = trpc.article.getShared.useMutation();

  useEffect(() => {
    if (articleId) mutate({ articleId });
  }, [articleId, mutate]);
  useEffect(() => {
    if (data?.status === 'published') void router.replace(data.url);
  }, [data, router]);

  if (data?.status === 'ok') return <SharedArticleView article={data.article} />;
  if (articleId && !isError && (!data || data.status === 'published'))
    return (
      <>
        <Meta title="Shared draft | Civitai" deIndex />
        <PageLoader />
      </>
    );
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
          <Divider />
          <Text size="sm" c="dimmed">
            Comments you leave are visible to the author and other link holders, and stay on the
            article if it is published.
          </Text>
          <ArticleDetailComments articleId={article.id} userId={article.user.id} />
        </Stack>
      </Container>
    </Gated>
  );
}

export default Page(SharedArticlePage);
