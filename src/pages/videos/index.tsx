import { Stack, Title } from '@mantine/core';
import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { Page } from '~/components/AppLayout/Page';
import { ImageCategories } from '~/components/Image/Filters/ImageCategories';
import { useImageFilters } from '~/components/Image/image.utils';
import ImagesInfinite from '~/components/Image/Infinite/ImagesInfinite';
import { IsClient } from '~/components/IsClient/IsClient';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { Meta } from '~/components/Meta/Meta';

function VideosPage() {
  const { hidden, ...filters } = useImageFilters('videos');

  return (
    <>
      <Meta
        title="Civitai Video Gallery | AI-Generated Art Showcase"
        description="See the latest art created by the generative AI art community and delve into the inspirations and prompts behind their work"
        canonical="/videos"
      />
      <MasonryContainer>
        {hidden && <Title>Your Hidden Videos</Title>}
        <Stack gap="xs">
          <IsClient>
            <ImageCategories />
            <ImagesInfinite
              filterType="videos"
              filters={{ ...filters, types: ['video'] }}
              showEof
              showAds
              useIndex
            />
          </IsClient>
        </Stack>
      </MasonryContainer>
    </>
  );
}

export default Page(VideosPage, { InnerLayout: FeedLayout, announcements: true });
