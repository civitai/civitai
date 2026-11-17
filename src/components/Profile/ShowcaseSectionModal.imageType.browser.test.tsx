import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as TrpcModule from '~/utils/trpc';
import type { ShowcaseSectionSchema } from '~/server/schema/user-profile.schema';
import { renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';

// Without image search the Images picker has nothing to search (the Meilisearch images index is
// gone and the image search refuses the request), so the section type is offered only with it.

const state = vi.hoisted(() => ({
  imageSearch: false,
  pickerProps: [] as Array<{ supportedIndexes?: string[]; username?: string }>,
}));

vi.mock('~/components/Dialog/DialogProvider', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useDialogContext: () => ({ opened: true, onClose: () => undefined }),
}));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useFeatureFlags: () =>
    new Proxy({}, { get: (_, key) => (key === 'imageSearch' ? state.imageSearch : true) }),
}));
vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useCurrentUser: () => ({ id: 7, username: 'fox' }),
}));
// The picker's own search is covered in ShowcaseItemsInput.imageOwner.browser.test.tsx; here only
// what the modal hands it matters.
vi.mock('~/components/Profile/ShowcaseItemsInput', () => ({
  ShowcaseItemsInput: (props: { supportedIndexes?: string[]; username?: string }) => {
    state.pickerProps.push(props);
    return null;
  },
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: makeTrpcProxy({}),
}));

const { default: ShowcaseSectionModal } = await import('~/components/Profile/ShowcaseSectionModal');

beforeEach(() => {
  state.imageSearch = false;
  state.pickerProps = [];
});

const imageSection: ShowcaseSectionSchema = { id: 'abc', type: 'Image', title: 'Mine', items: [1] };

describe('Showcase section types', () => {
  test('without image search, a new section offers no Images type', async () => {
    renderWithProviders(<ShowcaseSectionModal sections={[]} />);

    await expect.element(page.getByText('Models')).toBeInTheDocument();
    await expect.element(page.getByText('Articles')).toBeInTheDocument();
    expect(page.getByText('Images').elements()).toHaveLength(0);
  });

  test('with image search, Images is offered and its picker is the owner’s', async () => {
    state.imageSearch = true;
    renderWithProviders(<ShowcaseSectionModal sections={[]} />);

    await page.getByText('Images').click();

    await vi.waitFor(() =>
      expect(state.pickerProps.at(-1)).toMatchObject({
        supportedIndexes: ['images'],
        username: 'fox',
      })
    );
  });

  test('without image search, an existing Images section still shows its type', async () => {
    renderWithProviders(<ShowcaseSectionModal sections={[imageSection]} sectionId="abc" />);

    await expect.element(page.getByText('Images')).toBeInTheDocument();
    expect(state.pickerProps.at(-1)?.supportedIndexes).toEqual(['images']);
  });
});
