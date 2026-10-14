import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as ImageUtilsMod from '~/components/Image/image.utils';
import { StorylineHero, useStorylineFirstImage } from '~/components/Storyline/StorylineCover';

/**
 * Chapter 1's first image for the storyline page: read only for a chapter 1 this reader may see,
 * "loading" kept apart from "none", and the hero showing it sharp only once a banner exists.
 */

const IMAGE = { id: 7, url: 'first-of-501', type: 'image', nsfwLevel: 1, userId: 10 };

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  images: [] as unknown[],
  isLoading: false,
  safe: true,
}));

vi.mock('~/components/Image/image.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageUtilsMod>()),
  useQueryImages: (input: unknown, options: unknown) => {
    mocks.query(input, options);
    return { images: mocks.images, isLoading: mocks.isLoading };
  },
}));
vi.mock('~/components/ImageGuard/ImageGuard2', () => ({
  ImageGuard2: ({ children }: { children: (safe: boolean) => React.ReactNode }) => (
    <>{children(mocks.safe)}</>
  ),
}));
vi.mock('~/components/ImageHash/ImageHash', () => ({
  MediaHash: () => <span data-testid="hash">blurred</span>,
}));
vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({
  EdgeMedia: ({ src, className, ...rest }: { src: string; className?: string }) => (
    <img alt="" src={`https://cdn.test/${src}`} className={className} {...rest} />
  ),
}));

beforeEach(() => {
  mocks.query.mockReset();
  mocks.images = [IMAGE];
  mocks.isLoading = false;
  mocks.safe = true;
});

function Probe({ postId }: { postId: number | null }) {
  const image = useStorylineFirstImage(postId);
  return <span data-testid="probe">{image === undefined ? 'loading' : image?.url ?? 'none'}</span>;
}

describe('useStorylineFirstImage', () => {
  test('reads one image of chapter 1 and returns it', async () => {
    renderWithProviders(<Probe postId={501} />);

    await expect.element(page.getByTestId('probe')).toHaveTextContent('first-of-501');
    expect(mocks.query).toHaveBeenLastCalledWith(
      expect.objectContaining({ postId: 501, limit: 1 }),
      { enabled: true }
    );
  });

  test('a hidden chapter 1 (no post) is never read', async () => {
    renderWithProviders(<Probe postId={null} />);

    await expect.element(page.getByTestId('probe')).toHaveTextContent('none');
    expect(mocks.query).toHaveBeenLastCalledWith(expect.objectContaining({ postId: undefined }), {
      enabled: false,
    });
  });

  test('loading is not "none", and an empty read is', async () => {
    mocks.isLoading = true;
    const first = await renderWithProviders(<Probe postId={501} />);
    await expect.element(page.getByTestId('probe')).toHaveTextContent('loading');
    await first.unmount();

    mocks.isLoading = false;
    mocks.images = [];
    renderWithProviders(<Probe postId={501} />);
    await expect.element(page.getByTestId('probe')).toHaveTextContent('none');
  });
});

describe('StorylineHero', () => {
  test('without a banner, the image is a blurred backdrop', async () => {
    renderWithProviders(<StorylineHero image={IMAGE as never} backdrop />);

    await expect.element(page.getByTestId('storyline-hero-backdrop')).toBeInTheDocument();
    expect(page.getByTestId('storyline-hero-backdrop').element().className).toContain(
      'blur-[28px]'
    );
    expect(page.getByTestId('storyline-hero-image').elements()).toHaveLength(0);
  });

  test('a banner shows sharp at its focus', async () => {
    renderWithProviders(<StorylineHero image={IMAGE as never} position={20} />);

    const img = page.getByTestId('storyline-hero-image');
    await expect.element(img).toBeInTheDocument();
    expect(img.element().className).not.toContain('blur');
    expect((img.element() as HTMLElement).style.objectPosition).toBe('center 20%');
  });

  test('an image the guard hides stays a hash, backdrop or not', async () => {
    mocks.safe = false;
    renderWithProviders(<StorylineHero image={IMAGE as never} backdrop />);

    await expect.element(page.getByTestId('hash')).toBeInTheDocument();
    expect(document.querySelectorAll('img')).toHaveLength(0);
  });
});
