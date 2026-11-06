import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type * as CurrentUserModule from '~/hooks/useCurrentUser';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import type * as NotificationsModule from '~/utils/notifications';
import type * as TrpcModule from '~/utils/trpc';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';

const { mutate, viewer } = vi.hoisted(() => ({
  mutate: vi.fn(),
  viewer: { current: null as null | { id: number; isModerator: boolean } },
}));

vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<typeof CurrentUserModule>()),
  useCurrentUser: () => viewer.current,
}));

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
  viewer.current = null;
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

const FEED_LABEL = 'Moderator: read the developer-platform feedback feed';

describe('ApiKeyModal moderator feed scope', () => {
  test('is not offered to a non-moderator', async () => {
    viewer.current = { id: 1001, isModerator: false };
    await renderModal();
    expect(page.getByRole('checkbox', { name: FEED_LABEL }).elements()).toHaveLength(0);
    // The control: the grid did render.
    expect(page.getByRole('checkbox').elements().length).toBeGreaterThan(1);
  });

  test('a moderator can save a key carrying the feed scope and nothing else', async () => {
    viewer.current = { id: 6006, isModerator: true };
    const boxes = await renderModal();
    const feed = page.getByRole('checkbox', { name: FEED_LABEL });
    // Untick every grid box (all ticked from Full), then tick the feed box.
    for (const box of boxes) if (box !== feed.element()) await userEvent.click(box);
    await userEvent.click(feed);
    await userEvent.click(page.getByRole('button', { name: 'Save' }));

    await vi.waitFor(() => expect(mutate).toHaveBeenCalled());
    expect(submittedScope()).toBe(TokenScope.ModeratorFeedbackRead);
  });

  test('toggling a grid box keeps the feed scope a moderator ticked', async () => {
    viewer.current = { id: 6006, isModerator: true };
    const boxes = await renderModal();
    await userEvent.click(page.getByRole('checkbox', { name: FEED_LABEL }));
    await userEvent.click(boxes[1]);
    await userEvent.click(boxes[1]);
    await userEvent.click(page.getByRole('button', { name: 'Save' }));

    await vi.waitFor(() => expect(mutate).toHaveBeenCalled());
    expect(submittedScope()).toBe(TokenScope.Full | TokenScope.ModeratorFeedbackRead);
  });
});
