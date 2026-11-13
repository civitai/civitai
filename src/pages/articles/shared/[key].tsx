import { Container, Text } from '@mantine/core';
import type { InferGetServerSidePropsType } from 'next';
import { useRouter } from 'next/router';
import { useEffect } from 'react';
import { Page } from '~/components/AppLayout/Page';
import { SharedArticleView } from '~/components/Article/SharedArticleView';
import { Meta } from '~/components/Meta/Meta';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { resolveSharedArticleRequest } from '~/server/services/article-share.page';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trpc } from '~/utils/trpc';

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

export default Page(SharedArticlePage);
