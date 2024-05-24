import { Stack } from '@mantine/core';
import { Announcements } from '~/components/Announcements/Announcements';
import { ImageCategories } from '~/components/Image/Filters/ImageCategories';
import ImagesInfinite from '~/components/Image/Infinite/ImagesInfinite';
import { IsClient } from '~/components/IsClient/IsClient';
import { Meta } from '~/components/Meta/Meta';
import { env } from '~/env/client.mjs';
import { setPageOptions } from '~/components/AppLayout/AppLayout';
import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { AudioCard } from '~/components/Cards/AudioCard';

export default function AudioFeedPage() {
  return (
    <>
      <Meta
        title="Civitai Audio Gallery | AI-Generated Music Showcase"
        description="See the latest sounds created by the generative AI art community and delve into the inspirations and prompts behind their work"
        links={[{ href: `${env.NEXT_PUBLIC_BASE_URL}/audio`, rel: 'canonical' }]}
      />
      <Stack spacing="xs">
        <Announcements
          sx={(theme) => ({
            marginBottom: -35,
            [theme.fn.smallerThan('md')]: {
              marginBottom: -5,
            },
          })}
        />
        <IsClient>
          <ImagesInfinite filters={{ types: ['audio'] }} renderItem={AudioCard} showEof showAds />
        </IsClient>
      </Stack>
    </>
  );
}

setPageOptions(AudioFeedPage, { innerLayout: FeedLayout });
