import { act, useState } from 'react';
import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { useRetractedMedia } from '~/components/RetractedMedia/retracted-media';

type Hook = ReturnType<typeof useRetractedMedia>;
const host = { hook: null as Hook | null, setId: (() => undefined) as (id: number) => void };

// Nothing here is served, so every CDN load fails.
function Host({ isModerator = true, media = 'none' as 'none' | 'image' | 'video' }) {
  const [id, setId] = useState(41);
  const hook = useRetractedMedia({ id, ingestion: 'Scanned' }, { isModerator });
  host.hook = hook;
  host.setId = setId;
  return (
    <>
      <p>src {hook.src ?? 'cdn'}</p>
      {media === 'image' && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src="/__missing__.png" alt="" onError={hook.onCdnError} />
      )}
      {media === 'video' && (
        <video onError={hook.onCdnError}>
          <source src="/__missing__.webm" type="video/webm" />
          <source src="/__missing__.mp4" type="video/mp4" />
        </video>
      )}
    </>
  );
}

const ROUTE = 'src /api/mod/retracted-media/41';
const failedImage = () =>
  new Promise<HTMLImageElement>((resolve) => {
    const img = new Image();
    img.onerror = () => resolve(img);
    img.src = '/__missing__.png';
  });

describe('useRetractedMedia', () => {
  test.each(['image', 'video'] as const)(
    'moves a moderator to the route once the CDN refuses a scanned %s',
    async (media) => {
      await renderWithProviders(<Host media={media} />);
      await expect.element(page.getByText(ROUTE)).toBeVisible();
    }
  );

  test('waits for the last <source> of a video, since a later one may still play', async () => {
    await renderWithProviders(<Host />);
    const video = document.createElement('video');
    const [webm, mp4] = [document.createElement('source'), document.createElement('source')];
    video.append(webm, mp4);
    // act flushes the update, so a recorded failure would already show here.
    await act(async () => host.hook!.onCdnError!({ target: webm }));
    expect(document.body.textContent).toContain('src cdn');
    host.hook!.onCdnError!({ target: mp4 });
    await expect.element(page.getByText(ROUTE)).toBeVisible();
  });

  // Server-rendered media can fail before hydration attaches onError, and that event is not replayed.
  test('reads an image that failed before it was attached as refused', async () => {
    await renderWithProviders(<Host />);
    const img = await failedImage();
    host.hook!.mediaRef![1](img);
    await expect.element(page.getByText(ROUTE)).toBeVisible();
  });

  test('starts a tile reused for another image on the CDN again', async () => {
    await renderWithProviders(<Host />);
    host.hook!.onCdnError!({ target: null });
    await expect.element(page.getByText(ROUTE)).toBeVisible();
    host.setId(42);
    await expect.element(page.getByText('src cdn')).toBeVisible();
  });

  test('attaches nothing for anyone but a moderator', async () => {
    for (const props of [{ isModerator: false }]) {
      const { unmount } = await renderWithProviders(<Host {...props} />);
      expect({ props, onCdnError: host.hook!.onCdnError, mediaRef: host.hook!.mediaRef }).toEqual({
        props,
        onCdnError: undefined,
        mediaRef: undefined,
      });
      unmount();
    }
  });
});
