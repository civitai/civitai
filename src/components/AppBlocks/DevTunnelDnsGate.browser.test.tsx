import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { useQuery } from '@tanstack/react-query';
import type * as TrpcMod from '~/utils/trpc';
import type * as PreviewFrameMod from '~/components/Apps/AppAssistant/previewFrame';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';

type Readiness = { active: false } | { active: true; ready: boolean };
type QueryOptions = { enabled?: boolean; refetchInterval?: number | false };

const m = vi.hoisted(() => ({
  data: undefined as Readiness | undefined,
  dataUpdatedAt: 0,
  useQuery: vi.fn(),
  fetchFrame: vi.fn(),
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: makeTrpcProxy({ 'blocks.devTunnelDnsReady': { useQuery: m.useQuery } }),
}));
vi.mock('~/components/Apps/AppAssistant/previewFrame', async (importOriginal) => ({
  ...(await importOriginal<typeof PreviewFrameMod>()),
  fetchPreviewFrame: m.fetchFrame,
}));
vi.mock('~/components/AppBlocks/DevTunnelBlockHost', () => ({
  DevTunnelBlockHost: ({ iframeSrc }: { iframeSrc: string }) => (
    <div data-testid="frame" data-src={iframeSrc} />
  ),
}));

const { DevTunnelDnsGate, DEV_TUNNEL_DNS_POLL_MS, DEV_TUNNEL_DNS_WAIT_MS } = await import(
  './DevTunnelDnsGate'
);
const { AppAssistantPreview } = await import('~/components/Apps/AppAssistant/AppAssistantPreview');

const HOUR = 60 * 60_000;
/** Short enough that a resumed poll arrives within a test, long enough to tell from zero. */
const POLL = 150;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const lastOptions = () => m.useQuery.mock.calls.at(-1)![1] as QueryOptions;
/** Every `enabled` the gate has rendered with, so a pause too short to sample is still seen. */
const enabledHistory = () => m.useQuery.mock.calls.map(([, o]) => (o as QueryOptions).enabled);
const pausedThenResumed = () => {
  const history = enabledHistory();
  const paused = history.indexOf(false);
  return paused >= 0 && history.indexOf(true, paused) > paused;
};
const timeoutsOf = (spy: { mock: { calls: unknown[][] } }, ms: number) =>
  spy.mock.calls.filter(([, delay]) => delay === ms).length;
/** One poll answer; a new `dataUpdatedAt` is what tells the gate it is a new answer. */
function answer(data: Readiness) {
  m.data = data;
  m.dataUpdatedAt += 1;
}

beforeEach(() => {
  m.data = undefined;
  m.dataUpdatedAt = 0;
  m.useQuery.mockReset().mockImplementation(() => ({
    data: m.data,
    dataUpdatedAt: m.dataUpdatedAt,
  }));
  m.fetchFrame.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('DevTunnelDnsGate', () => {
  test('polls for the caller’s blockId every few seconds, in the background too', async () => {
    const onSettled = vi.fn();
    await renderWithProviders(<DevTunnelDnsGate blockId="my-app" onSettled={onSettled} />);
    await expect.element(page.getByText('Preparing the preview…')).toBeVisible();

    expect(m.useQuery.mock.calls.at(-1)![0]).toEqual({ blockId: 'my-app' });
    expect(lastOptions()).toMatchObject({
      enabled: true,
      refetchInterval: DEV_TUNNEL_DNS_POLL_MS,
      refetchIntervalInBackground: true,
      staleTime: 0,
      gcTime: 0,
    });
    expect(DEV_TUNNEL_DNS_POLL_MS).toBeGreaterThanOrEqual(2_000);
    expect(DEV_TUNNEL_DNS_POLL_MS).toBeLessThanOrEqual(3_000);
    // No answer yet is not an answer.
    expect(onSettled).not.toHaveBeenCalled();
  });

  test('arms a three-minute bound when given no other', async () => {
    expect(DEV_TUNNEL_DNS_WAIT_MS).toBe(180_000);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    // Control: with another bound, nothing arms a three-minute timer.
    const control = await renderWithProviders(
      <DevTunnelDnsGate blockId="my-app" onSettled={vi.fn()} waitMs={HOUR} />
    );
    await expect.element(page.getByText('Preparing the preview…')).toBeVisible();
    expect(timeoutsOf(setTimeoutSpy, 180_000)).toBe(0);
    expect(timeoutsOf(setTimeoutSpy, HOUR)).toBe(1);
    await control.unmount();

    await renderWithProviders(<DevTunnelDnsGate blockId="my-app" onSettled={vi.fn()} />);
    await expect.element(page.getByText('Preparing the preview…')).toBeVisible();
    expect(timeoutsOf(setTimeoutSpy, 180_000)).toBe(1);
  });

  test('does not settle while the record is pending, then settles once it is published', async () => {
    const onSettled = vi.fn();
    answer({ active: true, ready: false });
    const screen = await renderWithProviders(
      <DevTunnelDnsGate blockId="my-app" onSettled={onSettled} waitMs={HOUR} />
    );
    await expect.element(page.getByText('Preparing the preview…')).toBeVisible();
    expect(onSettled).not.toHaveBeenCalled();

    answer({ active: true, ready: true });
    await screen.rerender(
      <DevTunnelDnsGate blockId="my-app" onSettled={onSettled} waitMs={HOUR} />
    );
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));
  });

  test('settles once per answer, however often its owner re-renders it with a new callback', async () => {
    const onSettled = vi.fn();
    const gate = () => (
      <DevTunnelDnsGate
        blockId="my-app"
        onSettled={() => onSettled()}
        pollMs={POLL}
        waitMs={HOUR}
      />
    );
    answer({ active: true, ready: true });
    const screen = await renderWithProviders(gate());
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));

    // Through the pause and out the other side, with a new callback on every render.
    await screen.rerender(gate());
    await vi.waitFor(() => expect(pausedThenResumed()).toBe(true));
    await screen.rerender(gate());
    await pause(50);
    expect(onSettled).toHaveBeenCalledTimes(1);

    // Still mounted when the next poll answers: its owner was not ready after all.
    answer({ active: true, ready: true });
    await screen.rerender(gate());
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledTimes(2));
  });

  test('stops polling while its owner acts on an answer, and for a full interval after', async () => {
    let finish!: () => void;
    const onSettled = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    answer({ active: true, ready: true });
    await renderWithProviders(
      <DevTunnelDnsGate blockId="my-app" onSettled={onSettled} pollMs={HOUR} waitMs={2 * HOUR} />
    );
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(lastOptions()).toMatchObject({ enabled: false, refetchInterval: false })
    );

    // Polling resumes one poll interval (an hour), not one wait bound, after the owner finishes.
    // This is the test that owns the delay; the others only see that polling resumes.
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    finish();
    await vi.waitFor(() => expect(timeoutsOf(setTimeoutSpy, HOUR)).toBe(1));
    expect(timeoutsOf(setTimeoutSpy, 2 * HOUR)).toBe(0);
    expect(lastOptions()).toMatchObject({ enabled: false, refetchInterval: false });
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['rejects', () => Promise.reject(new Error('refetch failed'))],
    [
      'throws',
      () => {
        throw new Error('refetch failed');
      },
    ],
  ])('resumes polling when its owner’s callback %s', async (_label, callback) => {
    const onSettled = vi.fn(callback);
    answer({ active: true, ready: true });
    await renderWithProviders(
      <DevTunnelDnsGate blockId="my-app" onSettled={onSettled} pollMs={POLL} waitMs={HOUR} />
    );
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(pausedThenResumed()).toBe(true));
    expect(lastOptions()).toMatchObject({ enabled: true, refetchInterval: POLL });
    await expect.element(page.getByText('Preparing the preview…')).toBeVisible();
  });

  test('a new app while paused re-enables the query for it rather than staying paused', async () => {
    const onSettled = vi.fn(() => new Promise<void>(() => undefined));
    answer({ active: true, ready: true });
    const screen = await renderWithProviders(
      <DevTunnelDnsGate blockId="my-app" onSettled={onSettled} waitMs={HOUR} />
    );
    await vi.waitFor(() => expect(lastOptions().enabled).toBe(false));

    // The owner never finishes, and the gate is now asked about another app with no answer yet.
    m.data = undefined;
    await screen.rerender(
      <DevTunnelDnsGate blockId="other-app" onSettled={onSettled} waitMs={HOUR} />
    );
    await vi.waitFor(() =>
      expect(lastOptions()).toMatchObject({
        enabled: true,
        refetchInterval: DEV_TUNNEL_DNS_POLL_MS,
      })
    );
    expect(m.useQuery.mock.calls.at(-1)![0]).toEqual({ blockId: 'other-app' });
  });

  test('settles when the tunnel has gone, so the owner can show that instead of waiting', async () => {
    const onSettled = vi.fn();
    answer({ active: false });
    await renderWithProviders(
      <DevTunnelDnsGate blockId="my-app" onSettled={onSettled} waitMs={HOUR} />
    );
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));
  });

  test('after the bound it stops polling and says so, and waiting again restarts the poll', async () => {
    const onSettled = vi.fn();
    answer({ active: true, ready: false });
    const screen = await renderWithProviders(
      <DevTunnelDnsGate blockId="my-app" onSettled={onSettled} waitMs={50} />
    );
    await expect
      .element(page.getByText('The preview is taking longer than usual to come online.'))
      .toBeVisible();
    expect(page.getByText('Preparing the preview…').query()).toBeNull();
    expect(lastOptions()).toMatchObject({ enabled: false, refetchInterval: false });
    expect(onSettled).not.toHaveBeenCalled();

    // A window too long to elapse, so the waiting state it returns to cannot leave on its own.
    await screen.rerender(
      <DevTunnelDnsGate blockId="my-app" onSettled={onSettled} waitMs={HOUR} />
    );
    await page.getByRole('button', { name: 'Keep waiting' }).click();
    await expect.element(page.getByText('Preparing the preview…')).toBeVisible();
    expect(lastOptions()).toMatchObject({ enabled: true, refetchInterval: DEV_TUNNEL_DNS_POLL_MS });
  });
});

// The cases above drive a stubbed `useQuery`; these check what the gate assumes of the real one.
describe('DevTunnelDnsGate on a real query', () => {
  const fetchReadiness = vi.fn<() => Promise<Readiness>>();
  beforeEach(() => {
    fetchReadiness.mockReset();
    m.useQuery.mockImplementation((input: { blockId: string }, options: object) =>
      useQuery({
        queryKey: ['dev-tunnel-dns-ready', input.blockId],
        queryFn: fetchReadiness,
        ...options,
      })
    );
  });

  test('an identical answer is still a new answer, and nothing is fetched while the owner acts on one', async () => {
    fetchReadiness.mockResolvedValue({ active: true, ready: true });
    let finish!: () => void;
    const onSettled = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    await renderWithProviders(
      <DevTunnelDnsGate blockId="my-app" onSettled={onSettled} pollMs={POLL} waitMs={HOUR} />
    );
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));
    expect(fetchReadiness).toHaveBeenCalledTimes(1);

    // Several intervals pass with the owner still busy.
    await pause(POLL * 4);
    expect(fetchReadiness).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledTimes(1);

    finish();
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledTimes(2));
    expect(fetchReadiness).toHaveBeenCalledTimes(2);
  });

  test('keeps polling a pending record, and stops at the bound', async () => {
    fetchReadiness.mockResolvedValue({ active: true, ready: false });
    const onSettled = vi.fn();
    const gate = (waitMs: number) => (
      <DevTunnelDnsGate blockId="my-app" onSettled={onSettled} pollMs={POLL} waitMs={waitMs} />
    );
    const screen = await renderWithProviders(gate(HOUR));
    await vi.waitFor(() => expect(fetchReadiness.mock.calls.length).toBeGreaterThanOrEqual(3));

    await screen.rerender(gate(1));
    await expect
      .element(page.getByText('The preview is taking longer than usual to come online.'))
      .toBeVisible();
    // A tick already in flight as the bound fell may still land; after that, nothing.
    await pause(POLL * 2);
    const polls = fetchReadiness.mock.calls.length;
    await pause(POLL * 4);
    expect(fetchReadiness).toHaveBeenCalledTimes(polls);
    expect(onSettled).not.toHaveBeenCalled();
  });
});

describe('DevTunnelDnsGate inside the preview pane', () => {
  const HOST = 'dev-0123456789abcdef.apps.example';
  const FRAME = { blockId: 'my-app', iframeSrc: `https://${HOST}/?dev=entry-token` };
  const pane = () => (
    <AppAssistantPreview
      canPreview
      session={{ blockId: 'my-app', sessionId: 'bki_1', host: HOST }}
    />
  );

  test('a ready answer makes the pane fetch its frame again, and that is what mounts the app', async () => {
    m.fetchFrame.mockResolvedValueOnce({ preparing: true }).mockResolvedValue(FRAME);
    answer({ active: true, ready: false });
    const screen = await renderWithProviders(pane());
    await expect.element(page.getByText('Preparing the preview…')).toBeVisible();
    expect(page.getByTestId('frame').query()).toBeNull();
    expect(m.fetchFrame).toHaveBeenCalledTimes(1);

    answer({ active: true, ready: true });
    await screen.rerender(pane());
    await expect.element(page.getByTestId('frame')).toHaveAttribute('data-src', FRAME.iframeSrc);
    expect(m.fetchFrame).toHaveBeenCalledTimes(2);
  });
});
