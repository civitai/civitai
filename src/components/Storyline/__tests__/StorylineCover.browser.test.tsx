import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import { StorylineHero } from '~/components/Storyline/StorylineCover';

/**
 * The storyline page's hero: a picked banner sharp at its focus, anything else a blurred backdrop.
 */

const IMAGE = { id: 7, url: 'first-of-501', type: 'image', nsfwLevel: 1, userId: 10 };

const mocks = vi.hoisted(() => ({
  safe: true,
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
  mocks.safe = true;
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
    // EdgeImage caps its width at the size it requests; the hero must span the page anyway.
    expect((img.element() as HTMLElement).style.maxWidth).toBe('none');
  });

  test('an image the guard hides stays a hash, backdrop or not', async () => {
    mocks.safe = false;
    renderWithProviders(<StorylineHero image={IMAGE as never} backdrop />);

    await expect.element(page.getByTestId('hash')).toBeInTheDocument();
    expect(document.querySelectorAll('img')).toHaveLength(0);
  });
});
