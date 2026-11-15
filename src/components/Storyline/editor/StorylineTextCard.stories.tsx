import type { ReactNode } from 'react';
import { StoryTRPCProvider } from '../../../../.ladle/trpc';
import { FixedSessionProvider } from '~/components/CivitaiWrapped/CivitaiSessionProvider';
import { MediaUploadSettingsProvider } from '~/components/MediaUploadSettings/MediaUploadSettingsProvider';
import { PostEditProvider } from '~/components/Post/EditV2/PostEditProvider';
import { PostImageCards } from '~/components/Post/EditV2/PostImageCards/PostImageCards';
import { PostReorderImages } from '~/components/Post/EditV2/PostReorderImages';
import { StorylineTextCard } from '~/components/Storyline/editor/StorylineTextCard';
import { BrowserSettingsProvider } from '~/providers/BrowserSettingsProvider';
import { FeatureFlagsProvider } from '~/providers/FeatureFlagsProvider';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import type { PostDetailEditable } from '~/server/services/post.service';

// Design review stories for storyline text items, viewed as the chapter's author. "Held" shows
// the read-only card after the server refuses a change: click Delete in the story to get there.

const flags = { storylines: true, storylineText: true } as unknown as FeatureAccess;

const image = (id: number, index: number, seed: string) => ({
  id,
  index,
  name: seed,
  // Served from `public/` by Ladle, so the story needs no network.
  url: `http://localhost:61111/images/${seed}`,
  type: 'image',
  nsfwLevel: 1,
  ingestion: 'Scanned',
  metadata: { width: 800, height: 600 },
  meta: null,
  hideMeta: false,
  resourceHelper: [],
  tools: [],
  techniques: [],
  tags: [],
});

const texts = [
  {
    id: 1,
    index: 0,
    content:
      '<p>The lighthouse keeper had not seen a ship in <strong>forty days</strong>. On the forty-first, the fog came in <em>green</em>.</p>',
  },
  {
    id: 2,
    index: 1,
    content:
      '<p>She climbed the stairs anyway, counting them out loud, the way her father had.</p>',
  },
];

const post = {
  id: 100,
  title: 'The Green Fog',
  user: { id: 1 },
  publishedAt: null,
  images: [
    image(11, 0, 'daily-challenge-hero.png'),
    image(12, 1, 'newsletter-banner.png'),
    image(13, 2, 'controlnets/test-image-1-teed.png'),
  ],
  texts,
} as unknown as PostDetailEditable;

// The post is a draft chapter, so the author gets text items.
const storylineMocks = {
  'storyline.getPendingForPost': { storylineId: 1, parentChapter: null },
};

function Frame({
  children,
  mocks = {},
  editPost = post,
}: {
  children: ReactNode;
  mocks?: Record<string, unknown>;
  editPost?: PostDetailEditable;
}) {
  return (
    <StoryTRPCProvider mocks={{ ...storylineMocks, ...mocks }}>
      <FixedSessionProvider user={{ id: 1, username: 'author' }}>
        <FeatureFlagsProvider flags={flags}>
          <BrowserSettingsProvider>
            <MediaUploadSettingsProvider settings={{ maxItems: 20 }}>
              <PostEditProvider post={editPost}>
                <div className="w-[min(800px,calc(100vw-48px))]">{children}</div>
              </PostEditProvider>
            </MediaUploadSettingsProvider>
          </BrowserSettingsProvider>
        </FeatureFlagsProvider>
      </FixedSessionProvider>
    </StoryTRPCProvider>
  );
}

export const InterleavedEditor = () => (
  <Frame>
    <PostImageCards />
  </Frame>
);

export const CardMidEdit = () => (
  <Frame
    mocks={{
      'storyline.setText': ({ id, content }: { id: number; content: string }) => ({ id, content }),
    }}
  >
    <StorylineTextCard text={texts[0]} />
  </Frame>
);

export const Held = () => (
  <Frame
    mocks={{
      // The shape tRPC sends for a server error, so the card sees `data.code`.
      'storyline.deleteText': () => {
        throw {
          error: {
            message: "This can't be removed right now. Contact support if you need it removed.",
            code: -32603,
            data: { code: 'FORBIDDEN', httpStatus: 403 },
          },
        };
      },
    }}
  >
    <StorylineTextCard text={texts[1]} />
  </Frame>
);

export const ReorderView = () => (
  <Frame>
    <PostReorderImages />
  </Frame>
);

// Rearrange before text items, for comparing the image tiles.
export const ImagesOnlyReorder = () => (
  <Frame editPost={{ ...post, texts: [] }}>
    <PostReorderImages />
  </Frame>
);
