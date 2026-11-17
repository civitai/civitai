import { beforeEach, describe, expect, test, vi } from 'vitest';
import { renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';
import type * as TrpcMod from '~/utils/trpc';

/**
 * "Opening clears the hide": the run page mounts `ReopenClearsHide` only when the viewer had
 * removed the app from their My apps home (pinned in `run-page-reopen-clears-hide.test.ts`).
 * Here: once mounted it clears THAT slug's hide exactly once, however often it re-renders.
 */

const mocks = vi.hoisted(() => ({ unhide: vi.fn() }));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: makeTrpcProxy({
    // A fresh `mutate` identity on every render, as a worst case for the effect's deps: the
    // one-write guarantee must come from the component, not from a stable callback.
    'appListings.unhideMyApp': { useMutation: () => ({ mutate: (i: unknown) => mocks.unhide(i) }) },
  }),
}));

const { ReopenClearsHide } = await import('./ReopenClearsHide');

beforeEach(() => {
  mocks.unhide.mockReset();
});

describe('ReopenClearsHide', () => {
  test('🔴 clears the hide for its slug exactly once, across re-renders', async () => {
    const view = await renderWithProviders(<ReopenClearsHide slug="pixel-forge" />);
    await vi.waitFor(() => expect(mocks.unhide).toHaveBeenCalled());
    await view.rerender(<ReopenClearsHide slug="pixel-forge" />);
    await view.rerender(<ReopenClearsHide slug="pixel-forge" />);
    expect(mocks.unhide.mock.calls).toEqual([[{ slug: 'pixel-forge' }]]);
  });
});
