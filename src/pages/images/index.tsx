import { Stack, Title } from '@mantine/core';
import { Announcements } from '~/components/Announcements/Announcements';
import { setPageOptions } from '~/components/AppLayout/AppLayout';
import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { ImageCategories } from '~/components/Image/Filters/ImageCategories';
import { useImageQueryParams } from '~/components/Image/image.utils';
import ImagesInfinite from '~/components/Image/Infinite/ImagesInfinite';
import { IsClient } from '~/components/IsClient/IsClient';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { Meta } from '~/components/Meta/Meta';
import { ToolBanner } from '~/components/Tool/ToolBanner';
import { env } from '~/env/client.mjs';

export default function ImagesPage() {
  const { query } = useImageQueryParams();
  const { hidden } = query;

  return (
    <>
      <Meta
        title="Civitai Gallery | AI-Generated Art Showcase"
        description="See the latest art created by the generative AI art community and delve into the inspirations and prompts behind their work"
        links={[{ href: `${env.NEXT_PUBLIC_BASE_URL}/images`, rel: 'canonical' }]}
      />
      <ToolBanner />
      <MasonryContainer>
        <Announcements />
        {hidden && <Title>Your Hidden Images</Title>}
        <Stack spacing="xs">
          <IsClient>
            <ImageCategories />
            <ImagesInfinite showEof showAds />
          </IsClient>
        </Stack>
      </MasonryContainer>
    </>
  );
}

setPageOptions(ImagesPage, { innerLayout: FeedLayout });
