import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createTRPCReact } from '@trpc/react-query';
import { createTRPCClient, TRPCClientError, type TRPCLink } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { StickerMotionEditor } from '~/components/Sticker/StickerMotionEditor';
import type { AppRouter } from '~/server/routers';
import type { StickerTrackV1 } from '~/shared/utils/sticker-track';
import { useStickerAutoTrackStore as runs } from '~/store/sticker-auto-track.store';
import { useStickerPlacementDraftStore as store } from '~/store/sticker-placement-draft.store';
import { renderWithProviders } from '../../../test/component-setup';

const flags = { stickerAutoTrack: true };

/** A tRPC error as the server sends it, so `error.data.code` reads as it does in the app. */
const serverError = (code: string, message = 'refused') =>
  TRPCClientError.from({ error: { message, code: -32000, data: { code } } } as never);

/**
 * The two procedures, answered at the network edge rather than by mocking the client module.
 * `read` answers each status read; a promise holds the read until it settles.
 */
const io = {
  starts: [] as unknown[],
  start: (): unknown => ({ workflowId: 'wf-1', startMs: 0, maxMs: 60_000 }),
  reads: 0,
  read: (): unknown => ({ status: 'running' }),
};

const link: TRPCLink<AppRouter> =
  () =>
  ({ op }) =>
    observable((observer) => {
      const answer = async () => {
        if (op.path === 'placement.startStickerAutoTrack') {
          io.starts.push(op.input);
          return io.start();
        }
        if (op.path === 'placement.getStickerAutoTrack') {
          io.reads++;
          return io.read();
        }
        return new Promise(() => undefined);
      };
      answer().then(
        (data) => {
          observer.next({ result: { type: 'data', data } });
          observer.complete();
        },
        (error) =>
          observer.error(
            error instanceof TRPCClientError ? error : serverError('INTERNAL_SERVER_ERROR')
          )
      );
    });

const { Provider: TRPCProvider } = createTRPCReact<AppRouter>();

function Network({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient();
  const client = createTRPCClient<AppRouter>({ links: [link] });
  return (
    <TRPCProvider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </TRPCProvider>
  );
}

function fakeVideo() {
  const video = document.createElement('video');
  let time = 0;
  let paused = true;
  Object.defineProperty(video, 'duration', { get: () => 10 });
  Object.defineProperty(video, 'paused', { get: () => paused });
  Object.defineProperty(video, 'currentTime', {
    get: () => time,
    set: (value: number) => {
      time = value;
    },
  });
  video.play = vi.fn(async () => {
    paused = false;
  });
  video.pause = vi.fn(() => {
    paused = true;
  });
  return video;
}

const selected = () => {
  const state = store.getState();
  return state.drafts.find((draft) => draft.id === state.selectedDraftId)!;
};

/** Two seconds of track moving right from the placer's pose, hidden for the middle half second. */
const TRACK: StickerTrackV1 = {
  v: 1,
  ms: 250,
  x: [
    [0, 0.2],
    [8, 0.6],
  ],
  y: [[0, 0.5]],
  s: [[0, 0.3]],
  r: [[0, 0]],
  show: [
    [0, 1],
    [3, 0],
    [5, 1],
  ],
};

beforeEach(() => {
  io.starts = [];
  io.start = () => ({ workflowId: 'wf-1', startMs: 0, maxMs: 60_000 });
  io.reads = 0;
  io.read = () => ({ status: 'running' });
  flags.stickerAutoTrack = true;
  runs.setState({ runs: {} });
  store.getState().close();
  store.getState().open(74);
  store.getState().begin(9, { x: 0.2, y: 0.5 });
  store.getState().closeTray();
});

const render = () => {
  const video = fakeVideo();
  renderWithProviders(
    <Network>
      <div style={{ position: 'relative', width: 600, height: 400 }}>
        <StickerMotionEditor video={video} autoTrack={flags.stickerAutoTrack} />
      </div>
    </Network>
  );
  return video;
};

const autoTrack = () => page.getByRole('button', { name: 'Auto-track' });

describe('auto-track', () => {
  test('is offered in Movement only, and only behind the flag', async () => {
    render();
    await expect.element(page.getByText('Movement')).toBeInTheDocument();
    expect(autoTrack().query()).toBeNull();
    await page.getByText('Movement').click();
    await expect.element(autoTrack()).toBeInTheDocument();
  });

  test('is not offered with the flag off', async () => {
    flags.stickerAutoTrack = false;
    render();
    await page.getByText('Movement').click();
    await expect.element(page.getByRole('group', { name: 'Sticker timeline' })).toBeInTheDocument();
    expect(autoTrack().query()).toBeNull();
  });

  test('starts from the draft pose at the playhead and shows the run in place of the timeline', async () => {
    render();
    await page.getByText('Movement').click();
    store.getState().setPlayhead(1500);
    await autoTrack().click();
    await expect.element(page.getByText(/Tracking your sticker/)).toBeInTheDocument();
    const draft = selected();
    expect(io.starts).toEqual([
      {
        imageId: 74,
        pose: { x: draft.x, y: draft.y, scale: draft.scale, rotation: draft.rotation },
        startMs: 1500,
      },
    ]);
    expect(page.getByRole('button', { name: 'Pause' }).query()).toBeNull();
    expect(page.getByRole('button', { name: 'Play' }).query()).toBeNull();
  });

  test('a landed track becomes the draft keys from its start, cut at hides; Discard puts them back', async () => {
    render();
    await page.getByText('Movement').click();
    const handKeys = selected().motion!.keys;
    io.read = () => ({ status: 'succeeded', track: TRACK, startMs: 1000 });
    store.getState().setPlayhead(1000);
    await autoTrack().click();
    await expect.element(page.getByText('Auto-track ready')).toBeInTheDocument();
    await expect.element(page.getByText(/hidden once/)).toBeInTheDocument();

    const run = selected().motion!.keys.filter((key) => key.t >= 1000);
    expect(run[0]).toMatchObject({ t: 1000, x: 0.2 });
    expect(run.at(-1)).toMatchObject({ t: 3000, x: 0.6 });
    // The shown key before the hide holds and snaps, rather than fading over the fade budget.
    expect(run.find((key) => key.t === 1500)).toMatchObject({ ease: 'jump', o: 1, x: 0.3 });
    expect(run.find((key) => key.t === 1750)).toMatchObject({ o: 0 });

    await page.getByRole('button', { name: 'Discard' }).click();
    expect(selected().motion!.keys).toEqual(handKeys);
    expect(page.getByText('Auto-track ready').query()).toBeNull();
  });

  test('stops reading once the run has an answer', async () => {
    render();
    await page.getByText('Movement').click();
    io.read = () => ({ status: 'succeeded', track: TRACK, startMs: 0 });
    await autoTrack().click();
    await expect.element(page.getByText('Auto-track ready')).toBeInTheDocument();
    const reads = io.reads;
    // Past the first poll interval.
    await new Promise((resolve) => setTimeout(resolve, 3500));
    expect(io.reads).toBe(reads);
  });

  test('the daily limit says so in the server own words', async () => {
    render();
    await page.getByText('Movement').click();
    const limit = "You've used your 3 sticker auto-tracks for today. Try again tomorrow.";
    io.start = () => {
      throw serverError('TOO_MANY_REQUESTS', limit);
    };
    await autoTrack().click();
    await expect.element(page.getByText(limit)).toBeInTheDocument();
    await page.getByRole('button', { name: 'Keep it still' }).click();
    expect(selected().motion?.on).toBe(false);
  });

  test('a start the server refuses for another reason shows the generic message', async () => {
    render();
    await page.getByText('Movement').click();
    io.start = () => {
      throw serverError('INTERNAL_SERVER_ERROR', 'placement: internal detail');
    };
    await autoTrack().click();
    await expect.element(page.getByText(/Something went wrong on our side/)).toBeInTheDocument();
    expect(page.getByText(/internal detail/).query()).toBeNull();
  });

  test('a run that fails says so and leaves the sticker as it was', async () => {
    render();
    await page.getByText('Movement').click();
    const keys = selected().motion!.keys;
    io.read = () => ({ status: 'failed' });
    await autoTrack().click();
    await expect.element(page.getByText("Couldn't track this one")).toBeInTheDocument();
    await expect.element(page.getByText(/Something went wrong on our side/)).toBeInTheDocument();
    expect(selected().motion!.keys).toEqual(keys);
  });

  test('a run the server no longer knows ends as failed', async () => {
    render();
    await page.getByText('Movement').click();
    io.read = () => {
      throw serverError('NOT_FOUND');
    };
    await autoTrack().click();
    await expect.element(page.getByText("Couldn't track this one")).toBeInTheDocument();
  });

  test('an old run waits for a fresh answer before timing out, then gives up', async () => {
    let answer: (value: unknown) => void = () => undefined;
    io.read = () => new Promise((resolve) => (answer = resolve));
    render();
    await page.getByText('Movement').click();
    // As if the editor closed for six minutes while the run went on.
    runs.getState().set(selected().id, {
      phase: 'tracking',
      workflowId: 'wf-1',
      startMs: 0,
      startedAt: Date.now() - 360_000,
    });
    await expect.element(page.getByText(/Tracking your sticker/)).toBeInTheDocument();
    // Past one tick of the panel's 1 s clock.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(page.getByText(/took too long/).query()).toBeNull();

    answer({ status: 'running' });
    await expect.element(page.getByText(/took too long/)).toBeInTheDocument();
  });
});
