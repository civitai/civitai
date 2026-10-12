import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as TrpcMod from '~/utils/trpc';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';

type Readiness = { active: false } | { active: true; ready: boolean };
type QueryOptions = { enabled?: boolean; refetchInterval?: number | false };

const m = vi.hoisted(() => ({
  data: undefined as Readiness | undefined,
  dataUpdatedAt: 0,
  useQuery: vi.fn(),
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: makeTrpcProxy({ 'blocks.devTunnelDnsReady': { useQuery: m.useQuery } }),
}));

const { DevTunnelDnsGate, DEV_TUNNEL_DNS_POLL_MS, DEV_TUNNEL_DNS_WAIT_MS } = await import(
  './DevTunnelDnsGate'
);

const HOUR = 60 * 60_000;
const lastOptions = () => m.useQuery.mock.calls.at(-1)![1] as QueryOptions;

beforeEach(() => {
  m.data = undefined;
  m.dataUpdatedAt = 0;
  m.useQuery.mockReset().mockImplementation(() => ({
    data: m.data,
    dataUpdatedAt: m.dataUpdatedAt,
  }));
});

describe('DevTunnelDnsGate', () => {
  test('polls for the caller’s blockId every few seconds, bounded at about three minutes', async () => {
    await renderWithProviders(<DevTunnelDnsGate blockId="my-app" onSettled={vi.fn()} />);
    await expect.element(page.getByText('Preparing the preview…')).toBeVisible();

    expect(m.useQuery.mock.calls.at(-1)![0]).toEqual({ blockId: 'my-app' });
    expect(lastOptions()).toMatchObject({ enabled: true, refetchInterval: DEV_TUNNEL_DNS_POLL_MS });
    expect(DEV_TUNNEL_DNS_POLL_MS).toBeGreaterThanOrEqual(2_000);
    expect(DEV_TUNNEL_DNS_POLL_MS).toBeLessThanOrEqual(3_000);
    expect(DEV_TUNNEL_DNS_WAIT_MS).toBe(180_000);
  });

  test('does not settle while the record is pending, then settles once it is published', async () => {
    const onSettled = vi.fn();
    m.data = { active: true, ready: false };
    m.dataUpdatedAt = 1;
    const screen = await renderWithProviders(
      <DevTunnelDnsGate blockId="my-app" onSettled={onSettled} waitMs={HOUR} />
    );
    await expect.element(page.getByText('Preparing the preview…')).toBeVisible();
    expect(onSettled).not.toHaveBeenCalled();

    m.data = { active: true, ready: true };
    m.dataUpdatedAt = 2;
    await screen.rerender(
      <DevTunnelDnsGate blockId="my-app" onSettled={onSettled} waitMs={HOUR} />
    );
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));
  });

  test('settles again on a later poll if its owner has not replaced it yet', async () => {
    const onSettled = vi.fn();
    m.data = { active: true, ready: true };
    m.dataUpdatedAt = 1;
    const screen = await renderWithProviders(
      <DevTunnelDnsGate blockId="my-app" onSettled={onSettled} waitMs={HOUR} />
    );
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));

    m.dataUpdatedAt = 2;
    await screen.rerender(
      <DevTunnelDnsGate blockId="my-app" onSettled={onSettled} waitMs={HOUR} />
    );
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledTimes(2));
  });

  test('settles when the tunnel has gone, so the owner can show that instead of waiting', async () => {
    const onSettled = vi.fn();
    m.data = { active: false };
    m.dataUpdatedAt = 1;
    await renderWithProviders(
      <DevTunnelDnsGate blockId="my-app" onSettled={onSettled} waitMs={HOUR} />
    );
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));
  });

  test('after the bound it stops polling and says so, and waiting again restarts the poll', async () => {
    const onSettled = vi.fn();
    m.data = { active: true, ready: false };
    m.dataUpdatedAt = 1;
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
