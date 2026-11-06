import { Menu } from '@mantine/core';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as FeatureFlagsMod from '~/providers/FeatureFlagsProvider';
import type * as TrpcMod from '~/utils/trpc';
import { StartStorylineFromImageMenuItem } from '~/components/Storyline/StartStorylineFromImageMenuItem';

const mocks = vi.hoisted(() => ({
  flags: { storylines: true, remixGallery: true },
  visibility: { open: true } as { open: boolean } | undefined,
  queried: vi.fn(),
  openFromImage: vi.fn(),
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: makeTrpcProxy({
      'placement.getRemixGalleryVisibility': {
        useQuery: (input: unknown, options: { enabled: boolean }) => {
          mocks.queried(input, options);
          return { data: options.enabled ? mocks.visibility : undefined };
        },
      },
    }),
  };
});
// Signed in: the login gate passes the click straight through.
vi.mock('~/components/LoginRedirect/LoginRedirect', () => ({
  LoginRedirect: ({ children }: { children: React.ReactElement }) => children,
}));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsMod>()),
  useFeatureFlags: () => mocks.flags,
}));
vi.mock('~/components/Storyline/StartStorylineModal', () => ({
  openStartStorylineFromImageModal: mocks.openFromImage,
}));

const image = {
  id: 77,
  url: 'spark.jpg',
  type: 'image' as const,
  nsfwLevel: 4,
  username: 'painter',
};
const ITEM = 'Start a story from this image';

const renderItem = () =>
  renderWithProviders(
    <Menu opened>
      <Menu.Dropdown>
        <StartStorylineFromImageMenuItem image={image} />
        <Menu.Item>Other</Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
const offered = () =>
  [...document.querySelectorAll('[role="menuitem"]')].some((el) => el.textContent?.includes(ITEM));

beforeEach(() => {
  mocks.flags = { storylines: true, remixGallery: true };
  mocks.visibility = { open: true };
  mocks.queried.mockReset();
  mocks.openFromImage.mockReset();
});

describe('Start a story from this image', () => {
  test('opens the start sheet with this image as the spark', async () => {
    renderItem();
    await page.getByRole('menuitem', { name: ITEM }).click();
    expect(mocks.openFromImage).toHaveBeenCalledWith(image);
    expect(mocks.queried.mock.calls[0][0]).toMatchObject({ imageId: 77 });
  });

  test("is not offered where the image's remix gallery is switched off", async () => {
    mocks.visibility = { open: false };
    renderItem();
    await expect.element(page.getByRole('menuitem', { name: 'Other' })).toBeVisible();
    expect(offered()).toBe(false);
  });

  for (const flag of ['storylines', 'remixGallery'] as const)
    test(`is not offered, and asks nothing, with the ${flag} flag off`, async () => {
      mocks.flags = { ...mocks.flags, [flag]: false };
      renderItem();
      await expect.element(page.getByRole('menuitem', { name: 'Other' })).toBeVisible();
      expect(offered()).toBe(false);
      expect(mocks.queried).toHaveBeenCalled();
      expect(mocks.queried.mock.calls.every(([, options]) => options.enabled === false)).toBe(true);
    });
});
