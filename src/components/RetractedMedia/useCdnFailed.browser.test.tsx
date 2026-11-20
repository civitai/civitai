import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { retractedMediaUrl, useCdnFailed } from '~/components/RetractedMedia/retracted-media';

// The callers' wiring: the CDN first, and the route once it refuses. Nothing here is served, so every
// CDN load fails.
function Tile({ isModerator, type }: { isModerator: boolean; type: 'image' | 'video' }) {
  const image = { id: 41, ingestion: 'Scanned' };
  const user = { isModerator };
  const [cdnFailed, onCdnError] = useCdnFailed(image.id);
  const src = retractedMediaUrl(image, user, { cdnFailed });
  const onError = retractedMediaUrl(image, user, { cdnFailed: true }) ? onCdnError : undefined;
  if (src) return <p>route {src}</p>;
  if (type === 'video')
    return (
      <video data-testid="cdn" onError={onError}>
        <source src="/__missing__.webm" type="video/webm" />
        <source src="/__missing__.mp4" type="video/mp4" />
      </video>
    );
  // eslint-disable-next-line @next/next/no-img-element
  return <img data-testid="cdn" src="/__missing__.png" alt="" onError={onError} />;
}

describe('useCdnFailed', () => {
  test.each(['image', 'video'] as const)(
    'moves a moderator to the route once the CDN refuses a scanned %s',
    async (type) => {
      renderWithProviders(<Tile isModerator type={type} />);
      await expect.element(page.getByText('route /api/mod/retracted-media/41')).toBeVisible();
    }
  );

  test('leaves everyone else on the CDN', async () => {
    renderWithProviders(<Tile isModerator={false} type="image" />);
    await expect.element(page.getByTestId('cdn')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 300));
    expect(page.getByText(/route/).query()).toBeNull();
  });
});
