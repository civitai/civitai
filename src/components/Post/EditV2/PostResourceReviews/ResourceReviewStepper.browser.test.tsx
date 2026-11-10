import { QueryClient, useQuery } from '@tanstack/react-query';
import { useFormContext } from 'react-hook-form';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type * as FormModule from '~/libs/form';
import type * as TrpcModule from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../../test/trpcProxyStub';
import { renderWithProviders } from '../../../../../test/component-setup';

const upsert = vi.hoisted(() => vi.fn());

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 7, muted: false }) }));
vi.mock('~/hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('~/utils/notifications', () => ({ showErrorNotification: vi.fn() }));
vi.mock('~/components/Dialog/DialogProvider', () => ({
  useDialogContext: () => ({ opened: true, onClose: vi.fn() }),
}));
vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({
  EdgeMedia: ({ src }: { src: string }) => <img alt="" src={src} />,
}));
vi.mock('~/components/Post/EditV2/PostEditProvider', () => ({
  usePostEditStore: () => {
    throw new Error('dialogs render outside PostEditProvider');
  },
}));
vi.mock('~/libs/form', async (importOriginal) => ({
  ...(await importOriginal<typeof FormModule>()),
  InputRTE: ({ name }: { name: string }) => {
    const { register } = useFormContext();
    return <textarea aria-label="Comment" {...register(name)} />;
  },
}));

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const key = ['post.getResources', 1];
const resourceRow = (modelVersionId: number, modelName: string) => ({
  modelVersionId,
  modelId: modelVersionId * 10,
  modelName,
  modelType: 'LORA',
  modelVersionName: 'v1',
  reviewId: null,
  reviewRating: null,
  reviewRecommended: null,
  reviewDetails: null,
  reviewCreatedAt: null,
});

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: makeTrpcProxy(
    {
      'post.getResources': {
        useQuery: (_input: unknown, opts: object) =>
          useQuery({ queryKey: key, queryFn: async () => [], ...opts }, client),
      },
      'resourceReview.upsert': { useMutation: () => ({ mutateAsync: upsert }) },
    },
    {
      useUtils: () => ({
        post: {
          getResources: {
            cancel: async () => undefined,
            getData: () => client.getQueryData(key),
            setData: (_input: unknown, updater: unknown) =>
              client.setQueryData(
                key,
                typeof updater === 'function' ? updater(client.getQueryData(key)) : updater
              ),
          },
        },
        resourceReview: { getUserResourceReview: { invalidate: async () => undefined } },
      }),
    }
  ),
}));

import { ResourceReviewStepper } from '~/components/Post/EditV2/PostResourceReviews/ResourceReviewStepper';
import { resetPendingForTests } from '~/components/Post/EditV2/PostResourceReviews/usePostResourceReviews';

const images = [
  { id: 1, url: 'a', type: 'image', modelVersionIds: [5, 6] },
  { id: 2, url: 'b', type: 'image', modelVersionIds: [5] },
];
const open = () =>
  renderWithProviders(
    <ResourceReviewStepper postId={1} ownerId={7} modelVersionId={5} images={images} />
  );
const button = (name: string) => page.getByRole('button', { name, exact: true });

beforeEach(() => {
  resetPendingForTests();
  client.setQueryData(key, [resourceRow(5, 'Cool LoRA'), resourceRow(6, 'Other Model')]);
  upsert.mockReset();
  upsert.mockImplementation(async (input: object) => ({ id: 99, details: null, ...input }));
});

describe('ResourceReviewStepper', () => {
  test('rating, commenting and Save & next saves the comment and shows the next resource', async () => {
    await open();
    await expect.element(page.getByRole('heading', { name: 'Cool LoRA' })).toBeVisible();
    await button('Recommend').click();
    await userEvent.type(page.getByLabelText('Comment'), 'Great detail');
    await button('Save & next').click();

    await expect.element(page.getByRole('heading', { name: 'Other Model' })).toBeVisible();
    expect(upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({ modelVersionId: 5, recommended: true, details: 'Great detail' })
    );
  });

  test('Save & next stays disabled until the resource is rated', async () => {
    await open();
    await expect.element(button('Save & next')).toBeDisabled();
    await button('Not for me').click();
    await expect.element(button('Save & next')).toBeEnabled();
  });

  test('a typed comment survives jumping to another resource and back', async () => {
    await open();
    await userEvent.type(page.getByLabelText('Comment'), 'still thinking');
    await page.getByRole('button', { name: /Other Model/ }).click();
    await expect.element(page.getByRole('heading', { name: 'Other Model' })).toBeVisible();
    await page.getByRole('button', { name: /Cool LoRA/ }).click();
    await expect.element(page.getByLabelText('Comment')).toHaveValue('still thinking');
    expect(upsert).not.toHaveBeenCalled();
  });

  test('nudges for a comment only on a "Not for me" rating with no comment', async () => {
    await open();
    const nudge = page.getByText(/what went wrong helps/);
    await expect.element(nudge).not.toBeInTheDocument();
    await button('Not for me').click();
    await expect.element(nudge).toBeVisible();
    await userEvent.type(page.getByLabelText('Comment'), 'Broke my seeds');
    await expect.element(nudge).not.toBeInTheDocument();
  });
});
