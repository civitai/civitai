// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type * as Trpc from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';

type Act = {
  (callback: () => Promise<unknown>): Promise<void>;
  (callback: () => void): void;
};
const act = (React as unknown as { act: Act }).act;

const h = vi.hoisted(() => ({ start: vi.fn(), complete: vi.fn() }));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({
    'track.songPlayStart': { useMutation: () => ({ mutateAsync: h.start }) },
    'track.songPlay': { useMutation: () => ({ mutateAsync: h.complete }) },
  }),
}));

import { MusicPlayCounter } from '~/components/MusicPlayer/MusicPlayCounter';
import { useMusicPlayerStore, type MusicTrack } from '~/store/music-player.store';

const track = (id: number, durationSec = 200): MusicTrack => ({
  id,
  url: `song-${id}.mp3`,
  title: `Song ${id}`,
  durationSec,
  creator: { id: 100 + id, username: `artist${id}` },
});

const store = () => useMusicPlayerStore.getState();
let root: Root;

/** Applies a store change and lets the counter render and its reports settle. */
async function update(change: () => void) {
  await act(async () => change());
}

function setListened(listenedSec: number) {
  const { playback } = store();
  if (playback) useMusicPlayerStore.setState({ playback: { ...playback, listenedSec } });
}

beforeEach(async () => {
  vi.useFakeTimers();
  h.start.mockReset().mockResolvedValue({ started: true });
  h.complete.mockReset().mockResolvedValue({ counted: true });
  store().close();
  root = createRoot(document.createElement('div'));
  await act(async () => root.render(React.createElement(MusicPlayCounter)));
});

afterEach(() => {
  act(() => root.unmount());
  store().close();
  vi.useRealTimers();
});

describe('MusicPlayCounter', () => {
  it('counts the playing song from the player’s listen progress', async () => {
    await update(() =>
      store().playFromList({ name: 'Feed', tracks: [track(1), track(2)], index: 0 })
    );
    expect(h.start).toHaveBeenCalledExactlyOnceWith({ imageId: 1 });

    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    await update(() => setListened(30));
    expect(h.complete).toHaveBeenCalledExactlyOnceWith({ imageId: 1 });
  });

  it('starts tracking again for the next song', async () => {
    await update(() =>
      store().playFromList({ name: 'Feed', tracks: [track(1), track(2)], index: 0 })
    );
    await update(() => store().next());
    expect(h.start.mock.calls).toEqual([[{ imageId: 1 }], [{ imageId: 2 }]]);
  });

  it('starts nothing for a song restored paused until it is played', async () => {
    await update(() => store().restore({ track: track(1), positionSec: 40 }));
    expect(h.start).not.toHaveBeenCalled();

    await update(() => store().resume());
    expect(h.start).toHaveBeenCalledExactlyOnceWith({ imageId: 1 });
  });
});
