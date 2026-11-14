import { Card, CloseButton, Paper, Text } from '@mantine/core';
import { IconBrandWechat, IconDotsVertical } from '@tabler/icons-react';
import { RouterContext } from 'next/dist/shared/lib/router-context.shared-runtime';
import type { NextRouter } from 'next/router';
import type { ReactNode } from 'react';
import { StoryTRPCProvider } from '../../../../.ladle/trpc';
import { ContainerProvider } from '~/components/ContainerProvider/ContainerProvider';
import type { DetailText } from '~/components/Image/Detail/detail-items';
import { mergeDetailItems } from '~/components/Image/Detail/detail-items';
import { ImageDetailCarousel } from '~/components/Image/DetailV2/ImageDetailCarousel';
import { ImageDetailPostCard } from '~/components/Image/DetailV2/ImageDetailPostCard';
import { PostTextBlock } from '~/components/Post/Detail/PostTextBlock';
import { BrowserSettingsProvider } from '~/providers/BrowserSettingsProvider';
import { FeatureFlagsProvider } from '~/providers/FeatureFlagsProvider';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import { useCarouselNavigation } from '~/hooks/useCarouselNavigation';

// The stage around the carousel stands in for ImageDetail2's chrome, which needs the app router.

const flags = { storylines: true, storylineText: true } as unknown as FeatureAccess;
const POST = 100;

const image = (id: number, index: number, seed: string) => ({
  id,
  postId: POST,
  index,
  name: seed,
  // Served from `public/` by Ladle, so the story needs no network.
  url: `/images/${seed}`,
  type: 'image' as const,
  nsfwLevel: 1,
  width: 1200,
  height: 800,
  metadata: { width: 1200, height: 800 },
  user: { id: 1, username: 'storyteller' },
  reactions: [],
  stats: null,
  poi: false,
  minor: false,
  hasMeta: false,
  tagIds: [],
});

const images = [image(11, 0, 'daily-challenge-hero.png'), image(12, 1, 'newsletter-banner.png')];

const texts: DetailText[] = [
  {
    id: 1,
    postId: POST,
    index: 0,
    nsfwLevel: 1,
    content:
      '<h2>The forty-first day</h2><p>The lighthouse keeper had not seen a ship in <strong>forty days</strong>. On the forty-first, the fog came in <em>green</em>.</p><p>She climbed the stairs anyway, counting them out loud, the way her father had:</p><ul><li>one for the lamp,</li><li>one for the sea,</li><li>and one for whoever was still out there.</li></ul>',
  },
];

const post = { id: POST, title: 'The Green Fog', detail: null, user: { id: 1 }, texts };

const noop = () => Promise.resolve(true);
const router = {
  pathname: '/posts/[postId]',
  route: '/posts/[postId]',
  asPath: `/posts/${POST}`,
  query: { postId: String(POST) },
  basePath: '',
  isReady: true,
  isFallback: false,
  isPreview: false,
  isLocaleDomain: false,
  push: noop,
  replace: noop,
  reload: () => undefined,
  back: () => undefined,
  forward: () => undefined,
  prefetch: () => Promise.resolve(),
  beforePopState: () => undefined,
  events: { on: () => undefined, off: () => undefined, emit: () => undefined },
} as unknown as NextRouter;

function Frame({ children }: { children: ReactNode }) {
  return (
    <RouterContext.Provider value={router}>
      <StoryTRPCProvider mocks={{ 'post.get': post }}>
        <FeatureFlagsProvider flags={flags}>
          <BrowserSettingsProvider>{children}</BrowserSettingsProvider>
        </FeatureFlagsProvider>
      </StoryTRPCProvider>
    </RouterContext.Provider>
  );
}

const items = mergeDetailItems(images, texts);
const textIndex = items.findIndex((item) => item.type === 'text');

function Stage({ sidebar }: { sidebar?: ReactNode }) {
  const navigation = useCarouselNavigation({ items, initialIndex: textIndex });
  return (
    <ContainerProvider
      containerName="stage"
      style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh' }}
    >
      <div className="flex size-full overflow-hidden bg-gray-2 dark:bg-dark-9">
        <div className="relative flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between p-3">
            <CloseButton variant="filled" className="size-9 rounded-full" />
            <div className="flex size-9 items-center justify-center rounded-full bg-dark-6/60 text-white">
              <IconDotsVertical size={18} />
            </div>
          </div>
          <div className="relative flex min-h-0 flex-1 flex-col">
            <ImageDetailCarousel images={images} items={items} textUserId={1} {...navigation} />
          </div>
          <div className="flex justify-center gap-1.5 p-4">
            {items.map((item, i) => (
              <span
                key={item.key}
                className={`h-2 w-2 rounded-full ${
                  i === navigation.index ? 'bg-blue-6 dark:bg-white' : 'bg-gray-4 dark:bg-dark-3'
                }`}
              />
            ))}
          </div>
        </div>
        {sidebar && (
          <div className="flex w-[450px] min-w-[450px] flex-col gap-3 p-3 @max-md:hidden">
            {sidebar}
          </div>
        )}
      </div>
    </ContainerProvider>
  );
}

export const ReaderTextSlide = () => (
  <Frame>
    <Stage />
  </Frame>
);

export const ImageDetailTextSlide = () => (
  <Frame>
    <Stage
      sidebar={
        <>
          <ImageDetailPostCard post={post} />
          <Card className="flex flex-col gap-2 rounded-xl">
            <Text className="flex items-center gap-2 font-semibold">
              <IconBrandWechat /> Discussion
            </Text>
            <Text size="sm" c="dimmed">
              The post&apos;s thread (per-text threads come with PR3b).
            </Text>
          </Card>
        </>
      }
    />
  </Frame>
);

// The post page's list, in the order PostImages renders it: the image cards are stand-ins (the
// real ones need the app's tip and dialog providers); the text block is the real one.
export const PostPageInlineText = () => (
  <Frame>
    <div className="mx-auto flex max-w-[900px] flex-col gap-4 p-4">
      {items.map((item) =>
        item.type === 'text' ? (
          <PostTextBlock key={item.key} text={item.text} postId={POST} userId={1} />
        ) : (
          <Paper
            key={item.key}
            radius="md"
            shadow="md"
            mx="auto"
            className="w-full overflow-hidden"
          >
            <img src={item.image.url} alt="" className="block w-full" />
          </Paper>
        )
      )}
    </div>
  </Frame>
);
