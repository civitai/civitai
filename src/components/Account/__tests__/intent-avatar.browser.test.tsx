import { useRouter } from 'next/router';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';

// /intent/avatar saves an uploaded avatar. It must go through `profilePicture`, which creates a
// scanned Image row; `user.update` refuses an upload key sent as `image`.
const state = vi.hoisted(() => ({
  mutate: vi.fn(),
  uploadToCF: vi.fn(async () => ({ id: 'cf-upload-key' })),
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: makeTrpcProxy({ 'user.update': { useMutation: () => ({ mutate: state.mutate }) } }),
  };
});
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 7, username: 'avatar-owner', refresh: vi.fn() }),
}));
vi.mock('~/hooks/useCFImageUpload', () => ({
  useCFImageUpload: () => ({ uploadToCF: state.uploadToCF }),
}));
vi.mock('~/utils/image-utils', () => ({
  createImageElement: async () => ({ naturalWidth: 320, naturalHeight: 240 }),
}));
vi.mock('~/components/UserAvatar/UserAvatar', () => ({ UserAvatar: () => <span>avatar</span> }));
vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: () => async () => ({ props: {} }),
}));

import IntentAvatarPage from '~/pages/intent/avatar';

// The scaffold mocks next/router; this is its shared object, not a hook call.
// eslint-disable-next-line react-hooks/rules-of-hooks
const router = useRouter();
const BYTES = 3000;

beforeEach(() => {
  state.mutate.mockReset();
  router.query = { mediaUrl: 'https://example.test/new-avatar.png' };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(new Blob([new Uint8Array(BYTES)], { type: 'image/png' })))
  );
});

describe('/intent/avatar', () => {
  test('saves the upload as a profile picture, never as image', async () => {
    renderWithProviders(<IntentAvatarPage />);
    await page.getByRole('button', { name: 'Confirm' }).click();

    await expect.poll(() => state.mutate.mock.calls.length).toBe(1);
    expect(state.mutate.mock.calls[0][0]).toEqual({
      id: 7,
      profilePicture: {
        url: 'cf-upload-key',
        width: 320,
        height: 240,
        mimeType: 'image/png',
        sizeKB: Math.ceil(BYTES / 1024),
      },
    });
  });
});
