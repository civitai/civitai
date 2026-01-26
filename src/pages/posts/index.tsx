import { Stack } from '@mantine/core';
import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { Page } from '~/components/AppLayout/Page';
import { IsClient } from '~/components/IsClient/IsClient';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { Meta } from '~/components/Meta/Meta';
import { PostCategories } from '~/components/Post/Infinite/PostCategories';
import PostsInfinite from '~/components/Post/Infinite/PostsInfinite';
import { usePostQueryParams } from '~/components/Post/post.utils';
import { env } from '~/env/client';

function PostsPage() {
  const { query } = usePostQueryParams();

  return (
    <>
      <Meta
        title="Community Posts | Civitai"
        description="Discover creative posts from our community featuring AI art created with Stable Diffusion, Flux, and other models. Find tutorials, showcases, and inspiration."
        links={[{ href: `${env.NEXT_PUBLIC_BASE_URL as string}/posts`, rel: 'canonical' }]}
      />
      <MasonryContainer>
        <Stack gap="xs">
          <IsClient>
            <PostCategories />
            <PostsInfinite filters={query} showEof showAds />
          </IsClient>
        </Stack>
      </MasonryContainer>
    </>
  );
}

export default Page(PostsPage, { InnerLayout: FeedLayout, announcements: true });
