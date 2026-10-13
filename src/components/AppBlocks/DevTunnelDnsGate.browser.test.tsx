import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
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
const lastOptions = () => m.useQuery.mock.calls.at(-1)![1] as QueryOptions;
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

describe('DevTunnelDnsGate', () => {
  test('polls for the caller’s blockId every few seconds, in the background too, bounded at about three minutes', async () => {
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
    expect(DEV_TUNNEL_DNS_WAIT_MS).toBe(180_000);
    // No answer yet is not an answer.
    expect(onSettled).not.toHaveBeenCalled();
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
      <DevTunnelDnsGate blockId="my-app" onSettled={() => onSettled()} waitMs={HOUR} />
    );
    answer({ active: true, ready: true });
    const screen = await renderWithProviders(gate());
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));

    await screen.rerender(gate());
    await screen.rerender(gate());
    await vi.waitFor(() => expect(lastOptions().enabled).toBe(true));
    expect(onSettled).toHaveBeenCalledTimes(1);

    // Still mounted when the next poll answers: its owner was not ready after all.
    answer({ active: true, ready: true });
    await screen.rerender(gate());
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledTimes(2));
  });

  test('stops polling while its owner is still acting on the last answer', async () => {
    let finish!: () => void;
    const onSettled = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    answer({ active: true, ready: true });
    await renderWithProviders(
      <DevTunnelDnsGate blockId="my-app" onSettled={onSettled} waitMs={HOUR} />
    );
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(lastOptions()).toMatchObject({ enabled: false, refetchInterval: false })
    );

    finish();
    await vi.waitFor(() =>
      expect(lastOptions()).toMatchObject({
        enabled: true,
        refetchInterval: DEV_TUNNEL_DNS_POLL_MS,
      })
    );
    expect(onSettled).toHaveBeenCalledTimes(1);
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
