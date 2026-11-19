import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as TrpcModule from '~/utils/trpc';
import { TextSlide } from '~/components/Image/DetailV2/TextSlide';
import { renderWithProviders } from '../../../../test/component-setup';

type GuardImage = { id: number; nsfwLevel?: number; userId?: number };
const { guard, postGet } = vi.hoisted(() => ({
  guard: { safe: true, asked: [] as GuardImage[] },
  postGet: { calls: [] as { id: number; enabled: boolean }[] },
}));

// The guard decides; this pins what the slide does with its answer, and what it asks about.
vi.mock('~/components/ImageGuard/ImageGuard2', async (o) => ({
  ...(await o<object>()),
  ImageGuardContent: ({
    image,
    children,
  }: {
    image: GuardImage;
    children: (safe: boolean) => JSX.Element;
  }) => {
    guard.asked.push(image);
    return children(guard.safe);
  },
}));
vi.mock('~/components/RenderHtml/RenderHtml', () => ({
  RenderHtml: ({ html }: { html: string }) => <div dangerouslySetInnerHTML={{ __html: html }} />,
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: (await import('../../../../test/trpcProxyStub')).makeTrpcProxy({
    'post.get': {
      useQuery: ({ id }: { id: number }, opts?: { enabled?: boolean }) => {
        postGet.calls.push({ id, enabled: opts?.enabled !== false });
        return {
          data:
            opts?.enabled === false
              ? undefined
              : {
                  id,
                  texts: [{ id: 12, index: 0, nsfwLevel: 1, content: '<p>From the post</p>' }],
                },
        };
      },
    },
  }),
}));

const stub = { id: 12, postId: 40, index: 0, nsfwLevel: 4 };

describe('TextSlide', () => {
  test("a stub's words come from its post's read and show once the guard allows", async () => {
    guard.safe = true;
    postGet.calls.length = 0;
    renderWithProviders(<TextSlide text={stub} />);
    await expect.element(page.getByText('From the post')).toBeVisible();
    expect(postGet.calls).toContainEqual({ id: 40, enabled: true });
  });

  test('a blurred slide keeps its words out of the page, and never asks as an image', async () => {
    guard.safe = false;
    guard.asked.length = 0;
    renderWithProviders(
      <TextSlide text={{ ...stub, id: 13, content: '<p>Secret words</p>' }} userId={7} />
    );
    const slide = page
      .getByTestId('text-slide')
      .filter({ has: page.getByTestId('text-blurred') })
      .last();
    await expect.element(slide).toHaveAttribute('data-text-id', '13');
    expect(slide.element().textContent).not.toContain('Secret words');
    expect(guard.asked.length).toBeGreaterThan(0);
    // The text's own rating and author, so an R text is blurred for anyone who blurs R.
    for (const asked of guard.asked) expect(asked).toEqual({ id: -13, nsfwLevel: 4, userId: 7 });
  });

  test("the author's unscanned text says it is pending review; a scanned one does not", async () => {
    guard.safe = true;
    renderWithProviders(
      <TextSlide text={{ ...stub, id: 14, nsfwLevel: 0, content: '<p>Draft</p>' }} />
    );
    const pending = page.getByTestId('text-slide').filter({ hasText: 'Draft' });
    await expect.element(pending.getByTestId('text-pending-review')).toBeVisible();
    renderWithProviders(
      <TextSlide text={{ ...stub, id: 15, nsfwLevel: 1, content: '<p>Final</p>' }} />
    );
    const scanned = page.getByTestId('text-slide').filter({ hasText: 'Final' });
    await expect.element(scanned).toBeVisible();
    expect(scanned.element().querySelector('[data-testid="text-pending-review"]')).toBeNull();
  });
});
