/**
 * The image detail page's "Made with <app>" credit, in real Chromium.
 *
 * The wording and the three states are the post chip's, rendered by the SAME
 * component (`PostPublishedWithApp`, whose own browser test pins them in
 * isolation). What this file pins is the image page's half: the credit asks the
 * server about THIS image, only when the viewer's store scope can show it, and each
 * server answer renders as that state, on the image page's own wrapper.
 *
 * 🔴 RED WITHOUT THE CHANGE: `ImagePublishedWithApp` and the
 * `image.getPublishedWithApp` query it reads did not exist, so the image page had
 * no credit at all — this file fails at import, and the linked-sentence case is the
 * behaviour that was missing (image 145511044 showed no credit).
 *
 * Requests are counted at a fake transport behind a REAL React Query client with
 * the app's own default options (`test/queryClientTrpcFake.ts`), so a zero means
 * React Query chose not to fetch, not that a spy was never wired. The flags come
 * from the real `FeatureFlagsProvider`.
 *
 * Every DOM read is gated on an awaited locator first (React 18 commits
 * asynchronously), and each "renders nothing" case renders a sibling marker and
 * waits for it, so an empty container cannot pass for an absent credit.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as TrpcModule from '~/utils/trpc';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import type { PostAppChip } from '~/server/services/blocks/post-app-chip.logic';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import type { QueryClientTrpcFake } from '../../../../test/queryClientTrpcFake';

const h = vi.hoisted(() => ({ fake: undefined as unknown as QueryClientTrpcFake }));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof TrpcModule>();
  const { makeQueryClientTrpcFake } = await import('../../../../test/queryClientTrpcFake');
  h.fake = makeQueryClientTrpcFake(actual.queryClient.getDefaultOptions());
  return { ...actual, trpc: h.fake.trpc };
});

import { LOADABLE_IMAGE_DATA_URI, renderWithProviders } from '../../../../test/component-setup';
import { ImagePublishedWithApp } from '~/components/Image/DetailV2/ImagePublishedWithApp';
import { FeatureFlagsProvider } from '~/providers/FeatureFlagsProvider';
import { trpc } from '~/utils/trpc';

const IMAGE_ID = 145511044;
const CHIP_PATH = 'image.getPublishedWithApp';
const CONTROL_PATH = 'control.ping';
const ROW = '[data-testid="image-published-with-app"]';
const row = () => document.querySelector<HTMLElement>(ROW);
/** Whitespace-normalised; nothing else is collapsed, so an extra word cannot hide. */
const sentence = () => (row()?.innerText ?? '').replace(/\s+/gu, ' ').trim();

const LINKED: PostAppChip = {
  slug: 'character-sheet-studio',
  name: 'Character Sheet Studio',
  iconUrl: LOADABLE_IMAGE_DATA_URI,
};

/** Store scope `full`: the flags `resolveStoreVisibilityScope` maps to `full` on the server. */
const FULL_VIA_LISTINGS = { appListings: true };
const FULL_VIA_BLOCKS = { appBlocks: true };
/** Store scope `public-external`: the store is reachable, but on-site listings are not. */
const PUBLIC_EXTERNAL = { appListingsPublicExternal: true };
/** Store scope `none`: the default viewer. */
const NO_SCOPE = {};

/**
 * Sent with every render, in the same commit as the credit: once its request has been
 * recorded, React Query has had its chance to start the credit's request too. It is the
 * positive control for every "zero requests" assertion below.
 */
type ControlTrpc = { control: { ping: { useQuery: (input: undefined) => { data?: unknown } } } };
function Control() {
  // A path no real router has, so no component under test can issue it by accident.
  const { data } = (trpc as unknown as ControlTrpc).control.ping.useQuery(undefined);
  return data ? <div data-testid="control-settled" /> : null;
}

async function render(flags: Partial<FeatureAccess>) {
  const view = await renderWithProviders(
    <FeatureFlagsProvider flags={flags as FeatureAccess}>
      <Control />
      <ImagePublishedWithApp imageId={IMAGE_ID} />
    </FeatureFlagsProvider>
  );
  await expect.element(page.getByTestId('control-settled')).toBeInTheDocument();
  return view;
}

/** The server's answer is `chip` for THIS image and `null` for any other id. */
function script(chip: PostAppChip | null) {
  h.fake.reset({
    [CHIP_PATH]: (input) => ((input as { id?: number })?.id === IMAGE_ID ? chip : null),
    [CONTROL_PATH]: () => true,
    // `null`: the linked state falls back to the name + icon, which is what is asserted.
    'appListings.getAppCard': () => null,
  });
}

beforeEach(() => script(null));

describe('ImagePublishedWithApp', () => {
  test('asks the server about THIS image', async () => {
    // The scripted server answers with a credit only for `IMAGE_ID`, so the credit
    // appears only if the request carried this image's id.
    script(LINKED);
    await render(FULL_VIA_LISTINGS);
    await expect.element(page.getByTestId('image-published-with-app')).toBeInTheDocument();
    expect(h.fake.callsTo(CHIP_PATH)).toBe(1);
  });

  test('renders nothing for an image with no app (server answered null)', async () => {
    await render(FULL_VIA_LISTINGS);
    await vi.waitFor(() => expect(h.fake.callsTo(CHIP_PATH)).toBe(1));
    expect(row()).toBeNull();
  });

  test('a viewable app: exactly "Made with <app>", linked to its store page, with icon', async () => {
    script(LINKED);
    await render(FULL_VIA_LISTINGS);
    await expect.element(page.getByTestId('image-published-with-app')).toBeInTheDocument();
    // 🔴 The whole sentence — "with", never "by".
    expect(sentence()).toBe('Made with Character Sheet Studio');
    const anchor = row()?.querySelector('a');
    expect(anchor?.getAttribute('href')).toBe('/apps/store-preview/character-sheet-studio');
    expect(anchor?.textContent).toBe('Character Sheet Studio');
    expect(row()?.querySelector('img')).not.toBeNull();
  });

  test('a not-viewable app: the name UNLINKED, and no icon', async () => {
    script({ slug: null, name: 'Character Sheet Studio', iconUrl: null });
    await render(FULL_VIA_LISTINGS);
    await expect.element(page.getByTestId('image-published-with-app')).toBeInTheDocument();
    expect(sentence()).toBe('Made with Character Sheet Studio');
    expect(row()?.querySelector('a')).toBeNull();
    expect(row()?.querySelector('img')).toBeNull();
  });

  /**
   * The server answers `null` before any read unless the viewer's store scope admits
   * on-site listings (`resolveAppChip` → `scopeAdmitsListingKind(scope, 'onsite')`), so
   * the request is gated on the same rule client-side. The fake would answer with a
   * credit if asked, so a request that should not have been sent also shows on screen.
   */
  describe('store-scope gate', () => {
    test.each([
      ['app-listings', FULL_VIA_LISTINGS],
      ['app-blocks-enabled', FULL_VIA_BLOCKS],
    ])('scope full via %s: the query runs and the credit renders', async (_name, flags) => {
      script(LINKED);
      await render(flags);
      await expect.element(page.getByTestId('image-published-with-app')).toBeInTheDocument();
      expect(h.fake.callsTo(CHIP_PATH)).toBe(1);
      expect(sentence()).toBe('Made with Character Sheet Studio');
    });

    test.each([
      ['scope none', NO_SCOPE],
      ['scope public-external (store reachable, on-site listings not)', PUBLIC_EXTERNAL],
    ])('%s: no request, and the same render as a null answer', async (_name, flags) => {
      // What a viewer inside the scope sees when the server answers null.
      script(null);
      const inScope = await render(FULL_VIA_LISTINGS);
      await vi.waitFor(() => expect(h.fake.callsTo(CHIP_PATH)).toBe(1));
      const nullAnswerHtml = inScope.container.innerHTML;
      await inScope.unmount();

      script(LINKED);
      const outOfScope = await render(flags);
      expect(h.fake.callsTo(CONTROL_PATH), 'positive control: the transport saw the render').toBe(
        1
      );
      expect(h.fake.callsTo(CHIP_PATH)).toBe(0);
      expect(row()).toBeNull();
      expect(outOfScope.container.innerHTML).toBe(nullAnswerHtml);
    });
  });
});
