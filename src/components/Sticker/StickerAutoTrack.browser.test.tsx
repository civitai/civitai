import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as Trpc from '~/utils/trpc';
import type { StickerTrackV1 } from '~/shared/utils/sticker-track';
import { useStickerAutoTrackStore as runs } from '~/store/sticker-auto-track.store';
import { useStickerPlacementDraftStore as store } from '~/store/sticker-placement-draft.store';
import { renderWithProviders } from '../../../test/component-setup';

const flags = { stickerAutoTrack: true };

const io = vi.hoisted(() => ({
  start: vi.fn(),
  poll: { data: undefined as unknown, error: null as unknown },
  pollOptions: undefined as undefined | { refetchInterval: (query: unknown) => number | false },
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof Trpc>();
  return {
    ...actual,
    // eslint-disable-next-line local-rules/no-hand-enumerated-trpc-mock -- spreads the real client, so an unlisted procedure is the real hook, not undefined
    trpc: {
      ...actual.trpc,
      placement: {
        ...actual.trpc.placement,
        startStickerAutoTrack: {
          useMutation: () => ({ mutate: io.start, isPending: false }),
        },
        getStickerAutoTrack: {
          useQuery: (_input: unknown, options: typeof io.pollOptions) => {
            io.pollOptions = options;
            return io.poll;
          },
        },
      },
    },
  };
});

const { StickerMotionEditor } = await import('~/components/Sticker/StickerMotionEditor');

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
  io.start.mockReset();
  io.poll = { data: undefined, error: null };
  io.pollOptions = undefined;
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
    <div style={{ position: 'relative', width: 600, height: 400 }}>
      <StickerMotionEditor video={video} autoTrack={flags.stickerAutoTrack} />
    </div>
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
    io.start.mockImplementation((_input, { onSuccess }) => onSuccess({ workflowId: 'wf-1' }));
    await autoTrack().click();
    const draft = selected();
    expect(io.start).toHaveBeenCalledWith(
      {
        imageId: 74,
        pose: { x: draft.x, y: draft.y, scale: draft.scale, rotation: draft.rotation },
        startMs: 1500,
      },
      expect.anything()
    );
    await expect.element(page.getByText(/Tracking your sticker/)).toBeInTheDocument();
    expect(page.getByRole('button', { name: 'Pause' }).query()).toBeNull();
    expect(page.getByRole('button', { name: 'Play' }).query()).toBeNull();
  });

  test('a landed track becomes the draft keys from its start, cut at hides; Discard puts them back', async () => {
    render();
    await page.getByText('Movement').click();
    const handKeys = selected().motion!.keys;
    io.start.mockImplementation((_input, { onSuccess }) => onSuccess({ workflowId: 'wf-1' }));
    store.getState().setPlayhead(1000);
    await autoTrack().click();
    await expect.element(page.getByText(/Tracking your sticker/)).toBeInTheDocument();

    io.poll = { data: { status: 'succeeded', track: TRACK, startMs: 1000 }, error: null };
    await expect.element(page.getByText('Auto-track ready'), { timeout: 3000 }).toBeInTheDocument();
    await expect.element(page.getByText(/hidden once/)).toBeInTheDocument();

    const keys = selected().motion!.keys;
    const run = keys.filter((key) => key.t >= 1000);
    expect(run[0]).toMatchObject({ t: 1000, x: 0.2 });
    expect(run.at(-1)).toMatchObject({ t: 3000, x: 0.6 });
    // The shown key before the hide holds and snaps, rather than fading over the fade budget.
    expect(run.find((key) => key.t === 1500)).toMatchObject({ ease: 'jump', o: 1, x: 0.3 });
    expect(run.find((key) => key.t === 1750)).toMatchObject({ o: 0 });

    await page.getByRole('button', { name: 'Discard' }).click();
    expect(selected().motion!.keys).toEqual(handKeys);
    expect(page.getByText('Auto-track ready').query()).toBeNull();
  });

  test('the daily limit says so in the server own words', async () => {
    render();
    await page.getByText('Movement').click();
    io.start.mockImplementation((_input, { onError }) =>
      onError({
        message: "You've used your 3 sticker auto-tracks for today. Try again tomorrow.",
        data: { code: 'TOO_MANY_REQUESTS' },
      })
    );
    await autoTrack().click();
    await expect
      .element(
        page.getByText("You've used your 3 sticker auto-tracks for today. Try again tomorrow.")
      )
      .toBeInTheDocument();
    await page.getByRole('button', { name: 'Keep it still' }).click();
    expect(selected().motion?.on).toBe(false);
  });

  test('polling stops once the run has an answer', async () => {
    render();
    await page.getByText('Movement').click();
    io.start.mockImplementation((_input, { onSuccess }) => onSuccess({ workflowId: 'wf-1' }));
    await autoTrack().click();
    await expect.element(page.getByText(/Tracking your sticker/)).toBeInTheDocument();
    const every = io.pollOptions!.refetchInterval;
    expect(every({ state: { data: { status: 'running' } } })).toBeGreaterThan(0);
    expect(every({ state: { data: { status: 'succeeded' } } })).toBe(false);
    expect(every({ state: { data: { status: 'failed' } } })).toBe(false);
  });
});
