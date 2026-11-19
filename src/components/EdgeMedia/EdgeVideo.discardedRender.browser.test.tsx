import { Suspense, startTransition, useState } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';

const media = vi.hoisted(() => ({ url: '' }));
vi.mock('~/client-utils/cf-images-utils', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useEdgeUrl: () => ({ url: media.url }),
}));

import { EdgeVideo } from '~/components/EdgeMedia/EdgeVideo';

// Must outlast the wait below, or a finished clip reads as never played.
function toneUrl() {
  const rate = 8000;
  const n = rate * 30;
  const view = new DataView(new ArrayBuffer(44 + n * 2));
  const text = (at: number, s: string) =>
    [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + n * 2, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) view.setInt16(44 + i * 2, Math.sin(i / 3) * 8000, true);
  return URL.createObjectURL(new Blob([view.buffer], { type: 'audio/wav' }));
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const never = new Promise<never>(() => undefined);
function SuspendsForever(): null {
  throw never;
}

// React builds host elements while rendering, so every <video> it creates is seen here, including
// those of a render it throws away and never attaches.
let created: HTMLVideoElement[] = [];
const originalCreateElement = Document.prototype.createElement;

beforeAll(async () => {
  media.url = toneUrl();
  // Playback with sound needs a user gesture; a click through the test driver is a trusted one.
  await userEvent.click(document.body);
});

beforeEach(() => {
  created = [];
  Document.prototype.createElement = function (
    this: Document,
    ...args: Parameters<Document['createElement']>
  ) {
    const el = originalCreateElement.apply(this, args);
    if (el instanceof HTMLVideoElement) created.push(el);
    return el;
  } as Document['createElement'];
});

afterEach(() => {
  Document.prototype.createElement = originalCreateElement;
  created.forEach((video) => video.pause());
});

const player = <EdgeVideo src="tone" autoPlay muted={false} disableWebm />;

describe('EdgeVideo autoPlay', () => {
  test('a committed player plays', async () => {
    renderWithProviders(player);
    await vi.waitFor(() =>
      expect(created.some((video) => video.isConnected && !video.paused)).toBe(true)
    );
  });

  test('a player from a render React throws away never plays', async () => {
    let open: (() => void) | undefined;
    function Page() {
      const [shown, setShown] = useState(false);
      open = () => startTransition(() => setShown(true));
      return (
        <Suspense fallback={null}>
          {shown && (
            <>
              {player}
              <SuspendsForever />
            </>
          )}
        </Suspense>
      );
    }
    renderWithProviders(<Page />);
    await vi.waitFor(() => expect(open).toBeDefined());
    open?.();

    await vi.waitFor(() => expect(created.length).toBeGreaterThan(0));
    await wait(1000);
    expect(created.every((video) => !video.isConnected)).toBe(true);
    expect(created.filter((video) => !video.paused)).toEqual([]);
  });
});
