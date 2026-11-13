// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type * as Trpc from '~/utils/trpc';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';

type Act = {
  (callback: () => Promise<unknown>): Promise<void>;
  (callback: () => void): void;
};
const act = (React as unknown as { act: Act }).act;

const h = vi.hoisted(() => ({
  start: vi.fn(),
  complete: vi.fn(),
}));

// A derived promise per call: a spy's own returned promise is handled by the spy (it records the
// settled result), which would hide a missing catch in the hook.
const unspied = (mutation: (input: unknown) => Promise<unknown>) => (input: unknown) =>
  mutation(input).then((result) => result);

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({
    'track.songPlayStart': { useMutation: () => ({ mutateAsync: unspied(h.start) }) },
    'track.songPlay': { useMutation: () => ({ mutateAsync: unspied(h.complete) }) },
  }),
}));

import { useSongPlayTracker, type SongPlayTrackerInput } from '~/hooks/useSongPlayTracker';

const SONG_ID = 501;

let root: Root;
let props: SongPlayTrackerInput;

function Probe(input: SongPlayTrackerInput) {
  useSongPlayTracker(input);
  return null;
}

/** Re-renders the hook with `changes` merged in, then lets pending promises settle. */
async function render(changes: Partial<SongPlayTrackerInput> = {}) {
  props = { ...props, ...changes };
  await act(async () => {
    root.render(React.createElement(Probe, props));
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  h.start.mockReset().mockResolvedValue({ started: true });
  h.complete.mockReset().mockResolvedValue({ counted: true });
  props = {
    songId: SONG_ID,
    playbackId: 'p1',
    durationSec: 200,
    listenedSec: 0,
    enabled: true,
  };
  root = createRoot(document.createElement('div'));
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

describe('useSongPlayTracker', () => {
  it('starts once per playback', async () => {
    await render();
    await render({ listenedSec: 5 });
    await render({ listenedSec: 10 });
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.start).toHaveBeenCalledWith({ imageId: SONG_ID });
  });

  it('completes once, when the play rule is met', async () => {
    await render();
    await advance(30_000);
    await render({ listenedSec: 29.9 });
    expect(h.complete).not.toHaveBeenCalled();

    await render({ listenedSec: 30 });
    await render({ listenedSec: 31 });
    expect(h.complete).toHaveBeenCalledTimes(1);
    expect(h.complete).toHaveBeenCalledWith({ imageId: SONG_ID });
  });

  it('starts and can count again for a new playback of the same song (repeat-one)', async () => {
    await render();
    await advance(30_000);
    await render({ listenedSec: 30 });

    await render({ playbackId: 'p2', listenedSec: 0 });
    expect(h.start).toHaveBeenCalledTimes(2);
    await advance(30_000);
    await render({ listenedSec: 30 });
    expect(h.complete).toHaveBeenCalledTimes(2);
  });

  it('holds the complete until the server’s clock can have reached the rule', async () => {
    // The start's answer arrives a second late; a 12 s song then ends before 12 s have passed
    // since it, and nothing re-renders afterwards.
    let answer: (value: { started: boolean }) => void = () => undefined;
    h.start.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await render({ durationSec: 12 });
    await advance(1_000);
    await act(async () => answer({ started: true }));

    await advance(11_000);
    await render({ listenedSec: 12 });
    expect(h.complete).not.toHaveBeenCalled();

    await advance(1_000);
    expect(h.complete).toHaveBeenCalledTimes(1);
  });

  it('counts a short song whose last time report falls just short of its end', async () => {
    // `timeupdate` fires a few times a second, so the last report of a 12 s song can read 11.8;
    // the next song starts in the same update as `ended`, so nothing renders at 12.
    await render({ durationSec: 12 });
    await advance(11_800);
    await render({ listenedSec: 11.8 });
    await render({ songId: 502, playbackId: 'p2', durationSec: 200, listenedSec: 0 });
    await advance(1_000);
    expect(h.complete).toHaveBeenCalledTimes(1);
    expect(h.complete).toHaveBeenCalledWith({ imageId: SONG_ID });
  });

  it('does not count a short song left well before its end', async () => {
    await render({ durationSec: 12 });
    await advance(10_000);
    await render({ listenedSec: 10 });
    await render({ songId: 502, playbackId: 'p2', durationSec: 200, listenedSec: 0 });
    await advance(5_000);
    expect(h.complete).not.toHaveBeenCalled();
  });

  it('sends a held complete before the next playback starts (repeat-one of a short song)', async () => {
    // The server keys a start by listener and song: a replay's start sent first would replace the
    // one the held complete is measured against.
    const calls: string[] = [];
    h.start.mockImplementation(async () => (calls.push('start'), { started: true }));
    h.complete.mockImplementation(async () => (calls.push('complete'), { counted: true }));
    let answer: (value: { started: boolean }) => void = () => undefined;
    h.start.mockImplementationOnce(
      () => (calls.push('start'), new Promise((resolve) => (answer = resolve)))
    );
    await render({ durationSec: 12 });
    await advance(500);
    await act(async () => answer({ started: true }));
    await advance(11_500);
    await render({ listenedSec: 12 });
    await render({ playbackId: 'p2', listenedSec: 0 });
    await advance(1_000);
    expect(calls).toEqual(['start', 'complete', 'start']);
  });

  it('never calls when disabled', async () => {
    await render({ enabled: false });
    await advance(30_000);
    await render({ listenedSec: 30 });
    expect(h.start).not.toHaveBeenCalled();
    expect(h.complete).not.toHaveBeenCalled();
  });

  it('swallows a failed start and does not complete a playback the server never saw start', async () => {
    h.start.mockRejectedValue(new Error('network'));
    await render();
    await advance(30_000);
    await render({ listenedSec: 30 });
    expect(h.complete).not.toHaveBeenCalled();
  });

  it('swallows a failed complete and does not retry it', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      h.complete.mockRejectedValue(new Error('network'));
      await render();
      await advance(30_000);
      await render({ listenedSec: 30 });
      await render({ listenedSec: 40 });
      // An unhandled rejection is reported after the microtask queue drains, so let real time pass.
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
      expect(h.complete).toHaveBeenCalledTimes(1);
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('does not start again when the same playback is disabled and re-enabled', async () => {
    await render();
    await render({ enabled: false });
    await render({ enabled: true });
    expect(h.start).toHaveBeenCalledTimes(1);
  });
});
