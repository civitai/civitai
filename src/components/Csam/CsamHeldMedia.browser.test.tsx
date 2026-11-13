import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type { ModerationImageModel } from '~/server/services/image.service';

// The public CDN copy, as a marker: what must never render for a held image the route failed on.
vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({
  EdgeMedia: () => <div data-testid="cdn-media" />,
}));

import { CsamHeldMedia, useHeldGridReport } from '~/components/Csam/CsamHeldMedia';

const fetchMock = vi.fn();
const image = { id: 41, url: 'k', name: 'x', type: 'image' } as unknown as ModerationImageModel;

// The <img> itself fails here (the test server has no such route), so every case reaches the probe;
// what the probe answers is what decides.
const probeAnswers = (status: number, headers: Record<string, string> = {}) =>
  fetchMock.mockImplementation(async () => new Response(null, { status, headers }));

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('CsamHeldMedia', () => {
  test.each([415, 502, 500, 403])(
    'shows an error tile, never the CDN copy, when the route fails with %i',
    async (status) => {
      probeAnswers(status);
      renderWithProviders(<CsamHeldMedia image={image} onClick={() => undefined} />);
      await expect
        .element(page.getByText('Could not load this file.', { exact: false }))
        .toBeVisible();
      expect(page.getByTestId('cdn-media').query()).toBeNull();
      expect(fetchMock).toHaveBeenCalledWith('/api/mod/held-media/41?probe=1');
    }
  );

  test('shows an error tile for a 404 that does not say not-held', async () => {
    probeAnswers(404);
    renderWithProviders(<CsamHeldMedia image={image} onClick={() => undefined} />);
    await expect
      .element(page.getByText('Could not load this file.', { exact: false }))
      .toBeVisible();
    expect(page.getByTestId('cdn-media').query()).toBeNull();
  });

  test('falls back to the CDN only on the explicit not-held answer', async () => {
    probeAnswers(404, { 'x-held-media': 'not-held' });
    renderWithProviders(<CsamHeldMedia image={image} onClick={() => undefined} />);
    await expect.element(page.getByTestId('cdn-media')).toBeInTheDocument();
  });

  test('shows an error tile, never the CDN copy, when the probe itself fails', async () => {
    fetchMock.mockImplementation(async () => {
      throw new TypeError('Failed to fetch');
    });
    renderWithProviders(<CsamHeldMedia image={image} onClick={() => undefined} />);
    await expect
      .element(page.getByText('Could not load this file.', { exact: false }))
      .toBeVisible();
    expect(page.getByTestId('cdn-media').query()).toBeNull();
  });

  test('plays a video from the route, and shows an error tile when it fails for any other reason', async () => {
    const video = { ...image, type: 'video' } as unknown as ModerationImageModel;
    // A probe that never answers holds the video on screen, so its src is read from a state that stays.
    fetchMock.mockImplementation(() => new Promise(() => undefined));
    const first = await renderWithProviders(
      <CsamHeldMedia image={video} onClick={() => undefined} />
    );
    expect(first.container.querySelector('video')?.getAttribute('src')).toBe(
      '/api/mod/held-media/41'
    );
    await first.unmount();

    probeAnswers(502);
    renderWithProviders(<CsamHeldMedia image={video} onClick={() => undefined} />);
    await expect
      .element(page.getByText('Could not load this file.', { exact: false }))
      .toBeVisible();
    expect(page.getByTestId('cdn-media').query()).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith('/api/mod/held-media/41?probe=1');
  });

  test('loads from the route first, not the CDN', async () => {
    fetchMock.mockImplementation(() => new Promise(() => undefined));
    renderWithProviders(<CsamHeldMedia image={image} onClick={() => undefined} />);
    const img = page.getByRole('img');
    await expect.element(img).toHaveAttribute('src', '/api/mod/held-media/41');
    expect(page.getByTestId('cdn-media').query()).toBeNull();
  });
});

function GridReport({ userId, count }: { userId: number; count: number }) {
  useHeldGridReport(userId, count);
  return null;
}

describe('useHeldGridReport', () => {
  test('sends one summary row per account, not one per refetch', async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 204 }));
    const { rerender } = await renderWithProviders(<GridReport userId={9} count={0} />);
    await rerender(<GridReport userId={9} count={12} />);
    await rerender(<GridReport userId={9} count={13} />);
    await rerender(<GridReport userId={10} count={3} />);
    expect(fetchMock.mock.calls.map(([url, init]) => [url, JSON.parse(init.body)])).toEqual([
      ['/api/mod/held-media/grid-view', { count: 12, userId: 9 }],
      ['/api/mod/held-media/grid-view', { count: 3, userId: 10 }],
    ]);
  });
});
