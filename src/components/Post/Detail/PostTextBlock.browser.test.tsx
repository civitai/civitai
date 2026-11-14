import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { PostTextBlock } from '~/components/Post/Detail/PostTextBlock';
import { renderWithProviders } from '../../../../test/component-setup';

const { guard } = vi.hoisted(() => ({ guard: { safe: true, ids: [] as number[] } }));

// The guard decides; this pins what the block does with its answer, and the id it asks about.
vi.mock('~/components/ImageGuard/ImageGuard2', async (o) => ({
  ...(await o<object>()),
  ImageGuardContent: ({
    image,
    children,
  }: {
    image: { id: number };
    children: (s: boolean) => JSX.Element;
  }) => {
    guard.ids.push(image.id);
    return children(guard.safe);
  },
}));

vi.mock('~/components/RenderHtml/RenderHtml', () => ({
  RenderHtml: ({ html }: { html: string }) => <div dangerouslySetInnerHTML={{ __html: html }} />,
}));

const text = {
  id: 7,
  postId: 40,
  index: 0,
  nsfwLevel: 4,
  content: '<p>Meanwhile, at the castle</p>',
};

describe('PostTextBlock', () => {
  test('a revealed text reads inline', async () => {
    guard.safe = true;
    renderWithProviders(<PostTextBlock text={text} postId={40} />);
    await expect.element(page.getByText('Meanwhile, at the castle')).toBeVisible();
  });

  test('a blurred text leaves its words out of the page, and never asks as an image', async () => {
    guard.safe = false;
    guard.ids.length = 0;
    renderWithProviders(<PostTextBlock text={{ ...text, id: 8 }} postId={40} />);
    const block = page
      .getByTestId('post-text-block')
      .filter({ has: page.getByTestId('text-blurred') });
    await expect.element(block).toBeInTheDocument();
    expect(block.element().textContent).not.toContain('Meanwhile');
    expect(guard.ids.length).toBeGreaterThan(0);
    expect(guard.ids.every((id) => id === -8)).toBe(true);
  });

  test("the author's unscanned text says it is pending review; a scanned one does not", async () => {
    guard.safe = true;
    renderWithProviders(<PostTextBlock text={{ ...text, id: 9, nsfwLevel: 0 }} postId={40} />);
    const pending = page
      .getByTestId('post-text-block')
      .filter({ has: page.getByTestId('text-pending-review') });
    await expect.element(pending).toHaveAttribute('data-text-id', '9');
    renderWithProviders(<PostTextBlock text={{ ...text, id: 10, nsfwLevel: 1 }} postId={40} />);
    const scanned = page.getByTestId('post-text-block').filter({ hasText: 'Meanwhile' }).last();
    await expect.element(scanned).toHaveAttribute('data-text-id', '10');
    expect(scanned.element().querySelector('[data-testid="text-pending-review"]')).toBeNull();
  });
});
