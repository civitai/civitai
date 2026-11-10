/**
 * The image detail page's "Made with <app>" credit, in real Chromium.
 *
 * The wording and the three states are the post chip's, rendered by the SAME
 * component (`PostPublishedWithApp`, whose own browser test pins them in
 * isolation). What this file pins is the image page's half: the credit asks the
 * server about THIS image, and each server answer renders as that state, on the
 * image page's own wrapper.
 *
 * 🔴 RED WITHOUT THE CHANGE: `ImagePublishedWithApp` and the
 * `image.getPublishedWithApp` query it reads did not exist, so the image page had
 * no credit at all — this file fails at import, and the linked-sentence case is the
 * behaviour that was missing (image 145511044 showed no credit).
 *
 * Every DOM read is gated on an awaited locator first (React 18 commits
 * asynchronously), and each "renders nothing" case renders a sibling marker and
 * waits for it, so an empty container cannot pass for an absent credit.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as TrpcModule from '~/utils/trpc';
import type * as FeatureFlagsMod from '~/providers/FeatureFlagsProvider';
import type { PostAppChip } from '~/server/services/blocks/post-app-chip.logic';

const { useChipQuery } = vi.hoisted(() => ({
  useChipQuery: vi.fn((..._a: unknown[]): { data: PostAppChip | null | undefined } => ({
    data: undefined,
  })),
}));

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsMod>()),
  useFeatureFlags: () => ({ appBlocksPages: false }),
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  // `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    trpc: makeTrpcProxy({
      'image.getPublishedWithApp': { useQuery: useChipQuery },
      'appListings.getAppCard': { useQuery: () => ({ data: undefined }) },
    }),
  };
});

import { LOADABLE_IMAGE_DATA_URI, renderWithProviders } from '../../../../test/component-setup';
import { ImagePublishedWithApp } from '~/components/Image/DetailV2/ImagePublishedWithApp';

const IMAGE_ID = 145511044;
const ROW = '[data-testid="image-published-with-app"]';
const row = () => document.querySelector<HTMLElement>(ROW);
/** Whitespace-normalised; nothing else is collapsed, so an extra word cannot hide. */
const sentence = () => (row()?.innerText ?? '').replace(/\s+/gu, ' ').trim();

async function renderedWith(data: PostAppChip) {
  useChipQuery.mockReturnValue({ data });
  renderWithProviders(<ImagePublishedWithApp imageId={IMAGE_ID} />);
  await expect.element(page.getByTestId('image-published-with-app')).toBeInTheDocument();
}

async function renderedWithout(data: PostAppChip | null | undefined) {
  useChipQuery.mockReturnValue({ data });
  renderWithProviders(
    <>
      <div data-testid="render-committed" />
      <ImagePublishedWithApp imageId={IMAGE_ID} />
    </>
  );
  await expect.element(page.getByTestId('render-committed')).toBeInTheDocument();
}

beforeEach(() => {
  useChipQuery.mockReset();
  useChipQuery.mockReturnValue({ data: undefined });
});

describe('ImagePublishedWithApp', () => {
  test('asks the server about THIS image', async () => {
    await renderedWithout(null);
    expect(useChipQuery).toHaveBeenCalled();
    expect(useChipQuery.mock.calls[0][0]).toEqual({ id: IMAGE_ID });
  });

  test('renders nothing for an image with no app (server answered null)', async () => {
    await renderedWithout(null);
    expect(row()).toBeNull();
  });

  test('renders nothing while the answer is still loading', async () => {
    await renderedWithout(undefined);
    expect(row()).toBeNull();
  });

  test('a viewable app: exactly "Made with <app>", linked to its store page, with icon', async () => {
    await renderedWith({
      slug: 'character-sheet-studio',
      name: 'Character Sheet Studio',
      iconUrl: LOADABLE_IMAGE_DATA_URI,
    });
    // 🔴 The whole sentence — "with", never "by".
    expect(sentence()).toBe('Made with Character Sheet Studio');
    const anchor = row()?.querySelector('a');
    expect(anchor?.getAttribute('href')).toBe('/apps/store-preview/character-sheet-studio');
    expect(anchor?.textContent).toBe('Character Sheet Studio');
    expect(row()?.querySelector('img')).not.toBeNull();
  });

  test('a not-viewable app: the name UNLINKED, and no icon', async () => {
    await renderedWith({ slug: null, name: 'Character Sheet Studio', iconUrl: null });
    expect(sentence()).toBe('Made with Character Sheet Studio');
    expect(row()?.querySelector('a')).toBeNull();
    expect(row()?.querySelector('img')).toBeNull();
  });
});
