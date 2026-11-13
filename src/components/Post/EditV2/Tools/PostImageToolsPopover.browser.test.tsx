import { describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { renderWithProviders } from '../../../../../test/component-setup';
import type * as PostEditProviderMod from '~/components/Post/EditV2/PostEditProvider';
import type * as TrpcModule from '~/utils/trpc';
import type { PostEditImageDetail } from '~/server/services/post.service';

const mocks = vi.hoisted(() => ({ images: [] as unknown[] }));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    trpc: makeTrpcProxy({
      'tool.getAll': {
        useInfiniteQuery: () => ({
          data: { pages: [{ items: [{ id: 1, name: 'Suno', type: 'Audio', priority: 1 }] }] },
          isLoading: false,
        }),
      },
      'technique.getAll': {
        useQuery: () => ({ data: [{ id: 1, name: 'txt2img', type: 'Image' }], isLoading: false }),
      },
    }),
  };
});
vi.mock('~/components/Post/EditV2/PostEditProvider', async (orig) => ({
  ...(await orig<typeof PostEditProviderMod>()),
  usePostEditStore: (selector: (state: unknown) => unknown) =>
    selector({ images: mocks.images, updateImage: vi.fn() }),
}));

// eslint-disable-next-line import/first
import { ImageToolsPopover } from '~/components/Post/EditV2/Tools/PostImageToolsPopover';
// eslint-disable-next-line import/first
import { ImageTechniquesPopover } from '~/components/Post/EditV2/Techniques/PostImageTechniquesPopover';

const added = (id: number, type: 'image' | 'video' | 'audio') => ({
  type: 'added',
  data: { id, type, url: `u${id}`, tools: [], techniques: [] },
});
const target = { id: 1, tools: [], techniques: [] } as unknown as PostEditImageDetail;

describe.each([
  { name: 'tools', Popover: ImageToolsPopover, option: 'Suno' },
  { name: 'techniques', Popover: ImageTechniquesPopover, option: 'txt2img' },
])('the $name popover footer', ({ Popover, option }) => {
  async function openFooter() {
    await renderWithProviders(<Popover image={target} />);
    await userEvent.click(page.getByRole('option', { name: option }));
  }

  test('a post of images only offers to add to all images', async () => {
    mocks.images = [added(1, 'image'), added(2, 'image')];
    await openFooter();
    await expect.element(page.getByRole('button', { name: 'Add to all images (2)' })).toBeVisible();
  });

  test('a post with a song calls them items, not images', async () => {
    mocks.images = [added(1, 'image'), added(2, 'audio'), added(3, 'image')];
    await openFooter();
    await expect.element(page.getByRole('button', { name: 'Add to all items (3)' })).toBeVisible();
    await expect.element(page.getByText(/Add to all images/)).not.toBeInTheDocument();
  });
});
