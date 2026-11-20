import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { RetractedMedia } from '~/components/RetractedMedia/RetractedMedia';

const fetchMock = vi.fn();

// The <img> fails here (the test server has no such route), so every case reaches the probe; what
// the probe answers decides the text.
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('RetractedMedia', () => {
  test("shows the route's reason for a refusal a moderator can act on", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 })
    );
    renderWithProviders(<RetractedMedia src="/api/mod/retracted-media/41" type="image" />);
    await expect.element(page.getByText('Forbidden')).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith('/api/mod/retracted-media/41?probe=1');
  });

  test('says only that it is not viewable for any other failure', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Not available here' }), { status: 404 })
    );
    renderWithProviders(<RetractedMedia src="/api/mod/retracted-media/41" type="image" />);
    await expect.element(page.getByText('Not viewable here')).toBeVisible();
    expect(page.getByText('Not available here').query()).toBeNull();
  });
});
