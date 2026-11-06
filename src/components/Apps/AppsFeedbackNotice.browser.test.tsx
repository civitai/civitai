import { useRouter } from 'next/router';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type * as TrpcModule from '~/utils/trpc';
import { renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';

/**
 * AppsFeedbackNotice — the rail notice that replaced the inline `/apps` prompt.
 *
 * The drawer it opens is NOT rendered: `dialogStore.trigger` is the observable, so what is
 * asserted is the area, context and copy handed to it.
 */

const { mocks } = vi.hoisted(() => ({
  mocks: {
    areaEnabled: true,
    user: { id: 1, username: 'reporter' } as { id: number; username: string } | null,
    trigger: vi.fn(),
  },
}));

// Spread the REAL module and override only `trpc` (local-rules/no-wholesale-module-mock).
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: makeTrpcProxy({
    'feedback.getArea': { useQuery: () => ({ data: { enabled: mocks.areaEnabled } }) },
    'feedback.create': { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
  }),
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => mocks.user }));

vi.mock('~/hooks/useCFImageUpload', () => ({
  useCFImageUpload: () => ({
    uploadToCF: vi.fn(),
    files: [],
    resetFiles: vi.fn(),
    removeImage: vi.fn(),
  }),
}));

vi.mock('~/components/Dialog/dialogStore', () => ({ dialogStore: { trigger: mocks.trigger } }));

const { AppsFeedbackNotice } = await import('~/components/Apps/AppsFeedbackNotice');

// The scaffold mocks `next/router` with a singleton, so module scope is fine.
// eslint-disable-next-line react-hooks/rules-of-hooks
const router = useRouter();

beforeEach(() => {
  mocks.areaEnabled = true;
  mocks.user = { id: 1, username: 'reporter' };
  mocks.trigger.mockClear();
  router.query = {};
});

/**
 * Renders the notice beside a probe and waits for the probe, so an absence read straight after
 * is an absence of the notice and not of a render that has not happened yet. (The
 * `expect.element(...).not` form is inert in this repo, so it is not used.)
 */
async function renderBesideProbe(collapsed: boolean) {
  renderWithProviders(
    <>
      <span data-testid="probe" />
      <AppsFeedbackNotice collapsed={collapsed} />
    </>
  );
  await expect.element(page.getByTestId('probe')).toBeInTheDocument();
}

describe('AppsFeedbackNotice', () => {
  test('open rail: Give feedback opens the panel for the apps area, carrying the store view', async () => {
    router.query = { kind: 'offsite', sort: 'newest' };
    renderWithProviders(<AppsFeedbackNotice collapsed={false} />);

    await userEvent.click(page.getByRole('button', { name: 'Give feedback' }));

    expect(mocks.trigger).toHaveBeenCalledTimes(1);
    const { props } = mocks.trigger.mock.calls[0][0];
    expect(props).toMatchObject({
      area: 'apps-marketplace',
      title: 'Give feedback',
      context: { filters: { kind: 'offsite', sort: 'newest' } },
    });
  });

  test('collapsed rail: only the icon button, and it opens the same panel', async () => {
    await renderBesideProbe(true);

    expect(page.getByText('Apps are new here').elements()).toHaveLength(0);
    await userEvent.click(page.getByRole('button', { name: 'Give feedback' }));

    expect(mocks.trigger).toHaveBeenCalledTimes(1);
  });

  test('renders nothing when the area is off', async () => {
    mocks.areaEnabled = false;
    await renderBesideProbe(false);

    expect(page.getByRole('button', { name: 'Give feedback' }).elements()).toHaveLength(0);
  });

  test('renders nothing for a signed-out viewer', async () => {
    mocks.user = null;
    await renderBesideProbe(false);

    expect(page.getByRole('button', { name: 'Give feedback' }).elements()).toHaveLength(0);
  });
});
