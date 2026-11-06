import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import type * as PostEditProviderMod from '~/components/Post/EditV2/PostEditProvider';
import type * as FormLib from '~/libs/form';

/**
 * The editable post title is the top heading, so the way back to the model is a separate link
 * above it. The real form, link and title input render; only the store and its heavier siblings
 * are replaced.
 */

const mocks = vi.hoisted(() => ({ post: {} as Record<string, unknown> }));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return { ...(await importOriginal<typeof TrpcMod>()), trpc: makeTrpcProxy() };
});

vi.mock('~/components/Post/EditV2/PostEditProvider', async (orig) => ({
  ...(await orig<typeof PostEditProviderMod>()),
  usePostEditStore: (selector: (state: unknown) => unknown) =>
    selector({
      post: mocks.post,
      updatePost: vi.fn(),
      presetTitle: null,
      setPresetTitle: vi.fn(),
    }),
  usePostEditParams: () => ({}),
  usePendingSave: () => undefined,
}));

vi.mock('~/libs/form', async (orig) => ({
  ...(await orig<typeof FormLib>()),
  InputRTE: () => null,
}));
vi.mock('~/components/ReadOnlyAlert/ReadOnlyAlert', () => ({ ReadOnlyAlert: () => null }));
vi.mock('~/components/Post/EditV2/EditPostTags', () => ({ EditPostTags: () => null }));
vi.mock('~/components/Post/EditV2/Collections/CollectionSelectDropdown', () => ({
  CollectionSelectDropdown: () => null,
}));

// eslint-disable-next-line import/first
import { PostEditForm } from '~/components/Post/EditV2/PostEditForm';

const modelVersionPost = {
  id: 1,
  title: 'My Model - v1 Showcase',
  detail: null,
  modelVersionId: 5,
  parentModelId: 3,
  parentModelName: 'My Model',
};

describe('PostEditForm — back link to the model', () => {
  beforeEach(() => {
    mocks.post = modelVersionPost;
  });

  test('a model-version post links back to its model at that version, in the same tab', async () => {
    renderWithProviders(<PostEditForm />);

    const link = page.getByRole('link', { name: 'My Model' });
    await expect.element(link).toBeVisible();
    await expect.element(link).toHaveAttribute('href', '/models/3?modelVersionId=5');
    await expect.element(link).not.toHaveAttribute('target');
  });

  test('the title is still an editable field, not the link', async () => {
    renderWithProviders(<PostEditForm />);

    const title = page.getByPlaceholder('Add a title...');
    await expect.element(title).toHaveValue('My Model - v1 Showcase');
    await userEvent.fill(title, 'Renamed');
    await expect.element(title).toHaveValue('Renamed');
  });

  test('a post without a model version shows no back link', async () => {
    mocks.post = {
      ...modelVersionPost,
      modelVersionId: null,
      parentModelId: null,
      parentModelName: null,
    };
    renderWithProviders(<PostEditForm />);

    await expect.element(page.getByPlaceholder('Add a title...')).toBeVisible();
    await expect.element(page.getByRole('link')).not.toBeInTheDocument();
  });
});
