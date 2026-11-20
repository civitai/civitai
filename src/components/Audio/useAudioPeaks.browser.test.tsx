import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { renderWithProviders } from '../../../test/component-setup';
import { useAudioPeaks } from '~/components/Audio/useAudioPeaks';

// Each test uses its own sources: decoded peaks are cached per source for the page's lifetime.
let run = 0;
const source = (name: string) => `https://audio.test/${run}/${name}.mp3`;

/** `fetch` that never answers on its own and rejects when its request is aborted. */
function stallingFetch() {
  const requests: { url: string; signal?: AbortSignal | null }[] = [];
  const spy = vi.spyOn(window, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    requests.push({ url, signal: init?.signal });
    return new Promise((_, reject) =>
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('Aborted', 'AbortError'))
      )
    );
  });
  return { requests, restore: () => spy.mockRestore() };
}

function Waveform({ src, enabled }: { src: string; enabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const peaks = useAudioPeaks(src, 10, ref, enabled === undefined ? undefined : { enabled });
  return (
    <div ref={ref} style={{ width: 100, height: 20 }}>
      {peaks ? 'peaks' : 'no peaks'}
    </div>
  );
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let fetches: ReturnType<typeof stallingFetch>;
beforeEach(() => {
  run++;
  fetches = stallingFetch();
});
afterEach(() => fetches.restore());

describe('decoding waveform peaks', () => {
  test('by default starts once the waveform is in view, as before', async () => {
    await renderWithProviders(<Waveform src={source('a')} />);
    await expect.poll(() => fetches.requests.map((r) => r.url)).toEqual([source('a')]);
  });

  test('waits while not enabled, then starts', async () => {
    const { rerender } = await renderWithProviders(<Waveform src={source('a')} enabled={false} />);
    await wait(200);
    expect(fetches.requests).toHaveLength(0);

    await rerender(<Waveform src={source('a')} enabled />);
    await expect.poll(() => fetches.requests.map((r) => r.url)).toEqual([source('a')]);
  });

  test('keeps going once started, when enabled turns off again', async () => {
    const { rerender } = await renderWithProviders(<Waveform src={source('a')} enabled />);
    await expect.poll(() => fetches.requests).toHaveLength(1);

    await rerender(<Waveform src={source('a')} enabled={false} />);
    expect(fetches.requests[0].signal?.aborted).toBe(false);
  });

  test('cancels the download on unmount and when the source changes', async () => {
    const { rerender, unmount } = await renderWithProviders(<Waveform src={source('a')} />);
    await expect.poll(() => fetches.requests).toHaveLength(1);

    await rerender(<Waveform src={source('b')} />);
    await expect.poll(() => fetches.requests).toHaveLength(2);
    expect(fetches.requests[0].signal?.aborted).toBe(true);
    expect(fetches.requests[1].signal?.aborted).toBe(false);

    await unmount();
    expect(fetches.requests[1].signal?.aborted).toBe(true);
  });

  test('a cancelled download is tried again next time, not remembered as failed', async () => {
    const first = await renderWithProviders(<Waveform src={source('a')} />);
    await expect.poll(() => fetches.requests).toHaveLength(1);
    await first.unmount();

    await renderWithProviders(<Waveform src={source('a')} />);
    await expect.poll(() => fetches.requests).toHaveLength(2);
  });
});
