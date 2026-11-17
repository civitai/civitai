import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import type * as TrpcModule from '~/utils/trpc';
import { renderWithProviders } from '../../../test/component-setup';
import type { MediaOverlapReport } from '~/components/EdgeMedia/media-overlap-detector';
import { installMediaOverlapDetector } from '~/components/EdgeMedia/media-overlap-detector';
import { mediaOverlapSchema } from '~/server/schema/track.schema';

const user = vi.hoisted(() => ({ current: null as { isModerator: boolean } | null }));
const mutate = vi.hoisted(() => vi.fn());
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => user.current }));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    trpc: makeTrpcProxy({ 'track.mediaOverlap': { useMutation: () => ({ mutate }) } }),
  };
});

import { MediaOverlapDetectorMount } from '~/components/EdgeMedia/MediaOverlapDetectorMount';

/** A 3 s tone a <video> plays with sound, so `paused` and `muted` mean what they do in production. */
function toneUrl() {
  const rate = 8000;
  const n = rate * 3;
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

let src = '';
const elements: HTMLVideoElement[] = [];
function video({ attached = true } = {}) {
  const el = document.createElement('video');
  el.src = src;
  el.loop = true;
  el.volume = 0.5;
  if (attached) document.body.appendChild(el);
  elements.push(el);
  return el;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const originalPlay = HTMLMediaElement.prototype.play;

let uninstall: (() => void) | undefined;
function install(options: Partial<Parameters<typeof installMediaOverlapDetector>[0]> = {}) {
  const reports: MediaOverlapReport[] = [];
  uninstall = installMediaOverlapDetector({
    report: (r) => reports.push(r),
    overlapMs: 300,
    sampleMs: 20,
    ...options,
  });
  return reports;
}

beforeAll(async () => {
  src = toneUrl();
  // Playback with sound needs a user gesture; a click through the test driver is a trusted one.
  await userEvent.click(document.body);
});

afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  for (const el of elements.splice(0)) {
    el.pause();
    el.remove();
  }
});

describe('media overlap detector', () => {
  test('reports a playing element that has left the page alongside the current one', async () => {
    const reports = install();
    const leaked = video();
    await leaked.play();
    leaked.remove();
    // Leaving the page pauses it; play() on the detached element is the leak.
    await wait(50);
    await leaked.play();
    await video().play();

    await vi.waitFor(() => expect(reports).toHaveLength(1), { timeout: 2000 });
    expect(reports[0].elements.map((e) => e.connected).sort()).toEqual([false, true]);
    expect(reports[0].overlapMs).toBeGreaterThanOrEqual(300);
    // What the server accepts: a report the route rejects would never reach the log.
    expect(mediaOverlapSchema.safeParse(reports[0]).error).toBeUndefined();
  });

  test('sees an element the autoplay attribute started, with no play() call', async () => {
    const reports = install();
    const auto = video({ attached: false });
    auto.autoplay = true;
    document.body.appendChild(auto);
    await vi.waitFor(() => expect(auto.paused).toBe(false));
    await video().play();

    await vi.waitFor(() => expect(reports).toHaveLength(1), { timeout: 2000 });
  });

  test('two elements audible for less than the threshold are not reported', async () => {
    const reports = install({ overlapMs: 1000 });
    const first = video();
    await first.play();
    await video().play();
    await wait(100);
    first.pause();

    await wait(1300);
    expect(reports).toHaveLength(0);
  });

  test('a muted second element is not an overlap', async () => {
    const reports = install();
    await video().play();
    const silent = video();
    silent.muted = true;
    await silent.play();

    await wait(600);
    expect(reports).toHaveLength(0);
  });

  test('reports once per cooldown', async () => {
    const reports = install({ cooldownMs: 60_000 });
    const [a, b] = [video(), video()];
    await a.play();
    await b.play();
    await vi.waitFor(() => expect(reports).toHaveLength(1), { timeout: 2000 });
    b.pause();
    await wait(100);
    await b.play();

    await wait(800);
    expect(reports).toHaveLength(1);
  });

  // Three play; only the first and third are audible. With room for two, which one is dropped
  // decides whether that pair is seen.
  async function threeWithTheMiddleSilenced(maxTracked: number, middle: 'muted' | 'paused') {
    const reports = install({ maxTracked });
    await video().play();
    const second = video();
    if (middle === 'muted') second.muted = true;
    await second.play();
    if (middle === 'paused') second.pause();
    await video().play();
    await wait(800);
    return reports;
  }

  test('tracks no more elements than it is allowed: the oldest playing one goes', async () => {
    expect(await threeWithTheMiddleSilenced(3, 'muted')).toHaveLength(1);
    uninstall?.();
    for (const el of elements.splice(0)) el.pause();
    expect(await threeWithTheMiddleSilenced(2, 'muted')).toHaveLength(0);
  });

  test('at the limit a paused element is dropped before an older playing one', async () => {
    expect(await threeWithTheMiddleSilenced(2, 'paused')).toHaveLength(1);
  });

  test("leaves play()'s result alone, rejection included", async () => {
    install();
    const broken = document.createElement('video');
    broken.src = 'data:video/mp4;base64,AAAA';

    await expect(broken.play()).rejects.toMatchObject({ name: 'NotSupportedError' });
    await expect(video().play()).resolves.toBeUndefined();
  });
});

describe('MediaOverlapDetectorMount', () => {
  let screen: { unmount: () => unknown } | undefined;
  afterEach(async () => {
    await screen?.unmount();
    screen = undefined;
    HTMLMediaElement.prototype.play = originalPlay;
    user.current = null;
    mutate.mockClear();
    for (const el of elements.splice(0)) {
      el.pause();
      el.remove();
    }
  });

  test('installs nothing for someone who is not a moderator', async () => {
    user.current = { isModerator: false };
    screen = await renderWithProviders(<MediaOverlapDetectorMount />);

    expect(HTMLMediaElement.prototype.play).toBe(originalPlay);
  });

  test('for a moderator, sends an overlap to the server', async () => {
    user.current = { isModerator: true };
    screen = await renderWithProviders(<MediaOverlapDetectorMount />);
    await video().play();
    await video().play();

    await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(mediaOverlapSchema.safeParse(mutate.mock.calls[0][0]).error).toBeUndefined();
  });

  test('takes the wrapper out again on unmount', async () => {
    user.current = { isModerator: true };
    screen = await renderWithProviders(<MediaOverlapDetectorMount />);
    expect(HTMLMediaElement.prototype.play).not.toBe(originalPlay);

    await screen.unmount();
    screen = undefined;
    expect(HTMLMediaElement.prototype.play).toBe(originalPlay);
  });
});
