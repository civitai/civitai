import type { ReactElement } from 'react';
import '@mantine/core/styles.css';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import type * as Trpc from '~/utils/trpc';
import type * as Features from '~/providers/FeatureFlagsProvider';
import type * as Browsing from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type * as Hover from '~/components/UserAvatar/UserHoverCard';
import type * as Guard from '~/components/ImageGuard/ImageGuard2';
import type * as Media from '~/components/EdgeMedia/EdgeMedia';

const state = vi.hoisted(() => ({
  enabled: true,
  safe: true,
  hoverCapable: true,
  query: vi.fn(),
}));

vi.mock('~/utils/trpc', async (original) => {
  const { makeTrpcProxy } = await import('../../../test/trpcProxyStub');
  return {
    ...(await original<typeof Trpc>()),
    trpc: makeTrpcProxy({
      'semanticImageSearch.search': { useQuery: state.query },
    }),
  };
});
vi.mock('~/providers/FeatureFlagsProvider', async (original) => ({
  ...(await original<typeof Features>()),
  useFeatureFlags: () => ({ moreLikeThis: state.enabled, feedSearch: true }),
}));
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', async (original) => ({
  ...(await original<typeof Browsing>()),
  useBrowsingLevelDebounced: () => 1,
}));
vi.mock('~/components/UserAvatar/UserHoverCard', async (original) => ({
  ...(await original<typeof Hover>()),
  useHoverCapable: () => state.hoverCapable,
}));
vi.mock('~/components/ImageGuard/ImageGuard2', async (original) => ({
  ...(await original<typeof Guard>()),
  ImageGuard2: ({ children }: { children: (safe: boolean) => ReactElement }) =>
    children(state.safe),
}));
vi.mock('~/components/EdgeMedia/EdgeMedia', async (original) => ({
  ...(await original<typeof Media>()),
  EdgeMedia: () => <div role="img" aria-label="Similar image" style={{ width: 80, height: 80 }} />,
}));

import { SimilarImagesHoverCard, SimilarImagesPreview } from './SimilarImagesHoverCard';

beforeEach(() => {
  state.enabled = true;
  state.safe = true;
  state.hoverCapable = true;
  state.query.mockReset().mockReturnValue({
    isPending: false,
    isError: false,
    data: {
      items: [{ id: 21, url: 'test', type: 'image', nsfwLevel: 1 }],
      similarityScores: { 21: 0.92 },
    },
  });
});

describe('similar images hover preview', () => {
  test('waits for a hover before querying, then links a scored match', async () => {
    renderWithProviders(
      <SimilarImagesHoverCard image={{ id: 10, type: 'image' }}>
        <div data-testid="source" style={{ width: 200, height: 200 }}>
          Source image
        </div>
      </SimilarImagesHoverCard>
    );
    expect(state.query).not.toHaveBeenCalled();
    await userEvent.hover(page.getByTestId('source'));
    await expect.element(page.getByRole('link', { name: 'Open similar image 21' })).toBeVisible();
    await expect
      .element(page.getByRole('link', { name: 'Open similar image 21' }))
      .toHaveAttribute('href', '/images/21');
    await expect.element(page.getByText('92%', { exact: true })).toBeVisible();
    expect(state.query).toHaveBeenCalledWith(
      expect.objectContaining({ imageId: 10, minSimilarity: 0.85, browsingLevel: 1 }),
      expect.anything()
    );
  });

  test('hides the preview for a source that More like this refuses', async () => {
    renderWithProviders(
      <SimilarImagesHoverCard image={{ id: 10, type: 'image', ingestion: 'Pending' }}>
        <div data-testid="source">Source image</div>
      </SimilarImagesHoverCard>
    );
    await userEvent.hover(page.getByTestId('source'));
    await expect.element(page.getByText('Similar images', { exact: true })).not.toBeInTheDocument();
    expect(state.query).not.toHaveBeenCalled();
  });

  test('offers a retry after a failed search', async () => {
    const retry = vi.fn();
    state.query.mockReturnValue({ isPending: false, isError: true, refetch: retry });
    renderWithProviders(<SimilarImagesPreview imageId={10} />);
    await expect.element(page.getByText('Similar images are unavailable.')).toBeVisible();
    await userEvent.click(page.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledOnce();
  });

  test('updates the search when the similarity cutoff changes', async () => {
    renderWithProviders(<SimilarImagesPreview imageId={10} />);
    await userEvent.click(page.getByRole('slider', { name: 'Minimum visual similarity' }));
    await userEvent.keyboard('{Home}');
    await expect.poll(() => state.query.mock.calls.at(-1)?.[0].minSimilarity).toBe(0);
  });

  test('keeps touch image taps free of hover previews', async () => {
    state.hoverCapable = false;
    renderWithProviders(
      <SimilarImagesHoverCard image={{ id: 10, type: 'image' }}>
        <div data-testid="source">Source image</div>
      </SimilarImagesHoverCard>
    );
    await userEvent.hover(page.getByTestId('source'));
    expect(state.query).not.toHaveBeenCalled();
  });

  test('explains an empty result and never invents a score', async () => {
    state.query.mockReturnValue({ isPending: false, isError: false, data: { items: [] } });
    renderWithProviders(<SimilarImagesPreview imageId={10} />);
    await expect
      .element(page.getByText('No images meet this cutoff. Try lowering it.'))
      .toBeVisible();
    await expect
      .element(page.getByRole('link', { name: /Open similar image/ }))
      .not.toBeInTheDocument();
  });

  test('honors the thumbnail blur decision', async () => {
    state.safe = false;
    renderWithProviders(<SimilarImagesPreview imageId={10} />);
    await expect.element(page.getByText('Hidden', { exact: true })).toBeVisible();
    await expect.element(page.getByRole('img', { name: 'Similar image' })).not.toBeInTheDocument();
  });

  test('leaves image cards alone while the feature is disabled', async () => {
    state.enabled = false;
    renderWithProviders(
      <SimilarImagesHoverCard image={{ id: 10, type: 'image' }}>
        <div data-testid="source">Source image</div>
      </SimilarImagesHoverCard>
    );
    await userEvent.hover(page.getByTestId('source'));
    await expect.element(page.getByText('Similar images', { exact: true })).not.toBeInTheDocument();
    expect(state.query).not.toHaveBeenCalled();
  });
});
