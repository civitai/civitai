import { Title } from '@mantine/core';
import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { Page } from '~/components/AppLayout/Page';
import { ImageCategories } from '~/components/Image/Filters/ImageCategories';
import { useImageQueryParams } from '~/components/Image/image.utils';
import ImagesInfinite from '~/components/Image/Infinite/ImagesInfinite';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { Meta } from '~/components/Meta/Meta';
import { env } from '~/env/client';

export default Page(
  function () {
    const { query } = useImageQueryParams();
    const { hidden } = query;

    return (
      <>
        <Meta
          title="Civitai Gallery | AI-Generated Art Showcase"
          description="See the latest art created by the generative AI art community and delve into the inspirations and prompts behind their work"
          links={[{ href: `${env.NEXT_PUBLIC_BASE_URL}/images`, rel: 'canonical' }]}
        />
        {/* <ToolBanner /> */}
        <MasonryContainer className="min-h-full">
          {/* <Announcements /> */}
          {hidden && <Title>Your Hidden Images</Title>}
          <div className="flex flex-col gap-2.5">
            <ImageCategories />
            <ImagesInfinite showEof showAds useIndex />
          </div>
        </MasonryContainer>
      </>
    );
  },
  { InnerLayout: FeedLayout, announcements: true }
);
