import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import type * as NotificationsModule from '~/utils/notifications';
import type * as TrpcModule from '~/utils/trpc';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';

const { mutate } = vi.hoisted(() => ({ mutate: vi.fn() }));

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => ({}),
}));
vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationsModule>()),
  showErrorNotification: vi.fn(),
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: makeTrpcProxy({
    'apiKey.add': {
      useMutation: () => ({ data: undefined, isPending: false, mutate, reset: vi.fn() }),
    },
  }),
}));

import { ApiKeyModal } from '~/components/Account/ApiKeyModal';
import { TokenScope, getScopeLabel } from '~/shared/constants/token-scope.constants';

function submittedScope(): number {
  expect(mutate).toHaveBeenCalledTimes(1);
  return (mutate.mock.calls[0][0] as { tokenScope: number }).tokenScope;
}

async function renderModal() {
  renderWithProviders(<ApiKeyModal opened onClose={vi.fn()} />);
  await userEvent.fill(page.getByPlaceholder('Your API Key name'), 'my key');
  const boxes = page.getByRole('checkbox').elements() as HTMLInputElement[];
  expect(boxes.length).toBeGreaterThan(1);
  return boxes;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ApiKeyModal scope', () => {
  test('starting from Full and unticking all but one box saves exactly that one scope', async () => {
    const boxes = await renderModal();
    // The first grid checkbox is Profile & Settings → Read.
    for (const box of boxes.slice(1)) await userEvent.click(box);
    await userEvent.click(page.getByRole('button', { name: 'Save' }));

    await vi.waitFor(() => expect(mutate).toHaveBeenCalled());
    expect(submittedScope()).toBe(TokenScope.UserRead);
  });

  test('unticking a box and ticking it again still saves Full Access', async () => {
    const boxes = await renderModal();
    await userEvent.click(boxes[0]);
    await userEvent.click(boxes[0]);
    await userEvent.click(page.getByRole('button', { name: 'Save' }));

    await vi.waitFor(() => expect(mutate).toHaveBeenCalled());
    expect(getScopeLabel(submittedScope())).toBe('Full Access');
  });
});
