import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../../test/component-setup';
import type * as PostEditProviderMod from '~/components/Post/EditV2/PostEditProvider';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import type * as TrpcModule from '~/utils/trpc';

const { flags } = vi.hoisted(() => ({ flags: { storylineText: false } }));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../../test/trpcProxyStub');
  return { ...(await importOriginal<typeof TrpcModule>()), trpc: makeTrpcProxy() };
});
vi.mock('~/providers/FeatureFlagsProvider', async (orig) => ({
  ...(await orig<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => flags,
}));
vi.mock('~/components/Post/EditV2/PostEditProvider', async (orig) => ({
  ...(await orig<typeof PostEditProviderMod>()),
  usePostEditStore: (selector: (state: unknown) => unknown) =>
    selector({
      images: [{ type: 'added', data: { id: 11, index: 0, url: 'u11' } }],
      texts: [{ id: 1, index: 0, content: '<p>Once</p>' }],
      post: { id: 5, user: { id: 7 } },
      setTexts: vi.fn(),
    }),
  usePostPreviewContext: () => ({ showPreview: false, toggleShowPreview: vi.fn() }),
}));
vi.mock('~/components/MediaUploadSettings/MediaUploadSettingsProvider', () => ({
  useMediaUploadSettingsContext: () => ({ maxItems: 20 }),
}));
vi.mock('~/components/Post/EditV2/PostImageCards/AddedImage', () => ({
  AddedImage: () => <div>image card</div>,
}));
vi.mock('~/components/Storyline/editor/StorylineTextCard', () => ({
  StorylineTextCard: () => <div>text card</div>,
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 7 }) }));
vi.mock('~/components/Storyline/editor/usePostStorylineMode', () => ({
  usePostStorylineMode: () => ({ inStoryline: true }),
}));

// eslint-disable-next-line import/first
import { PostImageCards } from '~/components/Post/EditV2/PostImageCards/PostImageCards';

// The text routes refuse every change without the flag, so the editor shows no text items then.
describe('PostImageCards and the storylineText flag', () => {
  test('flag off: images only, no text card', async () => {
    flags.storylineText = false;
    renderWithProviders(<PostImageCards />);
    await expect.element(page.getByText('image card')).toBeVisible();
    await expect.element(page.getByText('text card')).not.toBeInTheDocument();
  });

  test('flag on: the text card shows', async () => {
    flags.storylineText = true;
    renderWithProviders(<PostImageCards />);
    await expect.element(page.getByText('text card')).toBeVisible();
  });
});
