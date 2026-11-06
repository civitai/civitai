import { AspectRatio, Container, Divider, Group, Stack, Text, Title } from '@mantine/core';
import { IconEye } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useEffect, useMemo, useState } from 'react';
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
import { shareTokenSchema } from '~/server/schema/article.schema';
import type { SharedArticle } from '~/server/services/article-share.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { formatDate } from '~/utils/date-helpers';
import { removeTags } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';

// The token rides in the fragment (`/articles/shared#token=…`), which no request carries: not to
// this server, a CDN, analytics or a Referer. The page reads it and asks for the draft by POST.
export const getServerSideProps = createServerSideProps({
  resolver: async ({ ctx }) => {
    ctx.res.setHeader('Cache-Control', 'private, no-store');
    ctx.res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    ctx.res.setHeader('Referrer-Policy', 'no-referrer');
    return { props: {}, suppressAds: true };
  },
});

function readShareToken() {
  const token = new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '';
  return shareTokenSchema.safeParse(token).success ? token : null;
}

function SharedArticlePage() {
  const router = useRouter();
  const [token, setToken] = useState<string | null>();
  const { mutate, data, isPending, isError } = trpc.article.getShared.useMutation();

  useEffect(() => {
    const read = () => setToken(readShareToken());
    read();
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, []);
  useEffect(() => {
    if (token) mutate({ shareToken: token });
  }, [token, mutate]);
  useEffect(() => {
    if (data?.status === 'published') void router.replace(data.url);
  }, [data, router]);

  if (token === undefined || (token && !isError && (isPending || !data))) return <PageLoader />;
  if (data?.status === 'ok') return <SharedArticleView article={data.article} />;
  if (data?.status === 'published') return <PageLoader />;
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
