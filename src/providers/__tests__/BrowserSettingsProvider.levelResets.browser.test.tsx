import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';

const h = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options: undefined as any,
  mutate: vi.fn(),
  resets: {
    getPosted: vi.fn(),
    getForShop: vi.fn(),
    getRelatedPosts: vi.fn(),
  },
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof Trpc>()),
    trpc: makeTrpcProxy(
      {
        'user.updateContentSettings': {
          useMutation: (options: unknown) => {
            h.options = options;
            return { isPending: false, mutate: h.mutate };
          },
        },
      },
      {
        useUtils: () => ({
          blockImagePicker: { getPosted: { reset: h.resets.getPosted } },
          creatorService: { getForShop: { reset: h.resets.getForShop } },
          model3d: { getRelatedPosts: { reset: h.resets.getRelatedPosts } },
          user: { getSettings: { cancel: vi.fn(), setData: vi.fn() } },
        }),
      }
    ),
  };
});
vi.mock('~/components/CivitaiWrapped/CivitaiSessionProvider', () => ({
  useCivitaiSessionContext: () => ({
    type: 'authed',
    settings: {
      showNsfw: false,
      blurNsfw: true,
      browsingLevel: 1,
      disableHidden: false,
      allowAds: true,
      autoplayGifs: true,
      showEventCosmetics: true,
      eventPointPops: 'on',
    },
  }),
}));
vi.mock('~/hooks/useDomainColor', () => ({ useDomainColor: () => 'green' }));

import { BrowserSettingsProvider, useBrowsingSettings } from '~/providers/BrowserSettingsProvider';
import { renderWithProviders } from '../../../test/component-setup';
import { cleanup } from 'vitest-browser-react';

let setState: ((patch: Record<string, unknown>) => void) | undefined;
function Grab() {
  setState = useBrowsingSettings((s) => s.setState) as typeof setState;
  return null;
}

beforeEach(() => {
  h.options = undefined;
  h.mutate.mockReset();
  // The real mutation calls onSuccess with the variables it sent.
  h.mutate.mockImplementation((variables: unknown) => h.options?.onSuccess?.(undefined, variables));
  Object.values(h.resets).forEach((fn) => fn.mockReset());
  setState = undefined;
});
afterEach(() => cleanup());

async function change(patch: Record<string, unknown>) {
  renderWithProviders(
    <BrowserSettingsProvider>
      <Grab />
    </BrowserSettingsProvider>
  );
  await vi.waitFor(() => expect(setState).toBeDefined());
  setState!(patch);
  await vi.waitFor(() => expect(h.mutate).toHaveBeenCalled(), { timeout: 3000 });
}

describe('lists filtered by browsing level, after a settings change', () => {
  test.each([
    ['the browsing level', { browsingLevel: 31 }],
    ['showing mature content', { showNsfw: true }],
  ])('changing %s drops every list filtered at the old level', async (_, patch) => {
    await change(patch);
    expect(h.mutate).toHaveBeenCalledWith(expect.objectContaining(patch));
    expect(h.resets.getPosted).toHaveBeenCalledTimes(1);
    expect(h.resets.getForShop).toHaveBeenCalledTimes(1);
    expect(h.resets.getRelatedPosts).toHaveBeenCalledTimes(1);
  });

  test('a change that does not move the level keeps them', async () => {
    await change({ blurNsfw: false });
    expect(h.resets.getPosted).not.toHaveBeenCalled();
    expect(h.resets.getForShop).not.toHaveBeenCalled();
    expect(h.resets.getRelatedPosts).not.toHaveBeenCalled();
  });
});
