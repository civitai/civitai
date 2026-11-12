import { QueryClient, useQuery } from '@tanstack/react-query';
import type * as NotificationsModule from '~/utils/notifications';
import type { ReactNode } from 'react';
import { useFormContext } from 'react-hook-form';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type * as BrowsingLevelModule from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type * as FormModule from '~/libs/form';
import type * as TrpcModule from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../../test/trpcProxyStub';
import { renderWithProviders } from '../../../../../test/component-setup';

const upsert = vi.hoisted(() => vi.fn());

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 7, muted: false }) }));
vi.mock('~/hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationsModule>()),
  showErrorNotification: vi.fn(),
}));
vi.mock('~/components/Dialog/DialogProvider', () => ({
  useDialogContext: () => ({ opened: true, onClose: vi.fn() }),
}));
vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({
  EdgeMedia: ({ src }: { src: string }) => <img alt="" src={src} />,
}));
// Stands in for the viewer's browsing level: anything rated above PG is blurred.
vi.mock('~/components/ImageGuard/ImageGuard2', () => ({
  ImageGuard2: ({
    image,
    children,
  }: {
    image: { nsfwLevel: number };
    children: (safe: boolean) => ReactNode;
  }) => <>{children(image.nsfwLevel <= 1)}</>,
}));
vi.mock('~/components/ImageHash/ImageHash', () => ({
  MediaHash: () => <canvas data-testid="blurred-cover" />,
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
const cover = (nsfwLevel: number) => ({
  id: 1,
  userId: 3,
  url: 'cover-url',
  type: 'image',
  nsfwLevel,
  width: 512,
  height: 512,
  hash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
  poi: false,
  minor: false,
});

const covers = vi.hoisted(() => ({
  current: {} as Record<number, Record<string, unknown> | null>,
}));
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowsingLevelModule>()),
  useBrowsingLevelDebounced: () => 1,
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: makeTrpcProxy(
    {
      'post.getResources': {
        useQuery: (_input: unknown, opts: object) =>
          useQuery({ queryKey: key, queryFn: async () => [], ...opts }, client),
      },
      'post.getResourceCovers': {
        useQuery: (_input: unknown, opts: { enabled?: boolean }) => ({
          data: opts.enabled === false ? undefined : covers.current,
        }),
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
  covers.current = {};
  client.setQueryData(key, [resourceRow(5, 'Cool LoRA'), resourceRow(6, 'Other Model')]);
  upsert.mockReset();
  upsert.mockImplementation(async (input: object) => ({ id: 99, details: null, ...input }));
});

const manyResources = (count: number) =>
  Array.from({ length: count }, (_, i) => resourceRow(100 + i, `Model ${i + 1}`));

describe('ResourceReviewStepper cover', () => {
  test('the header shows the current resource cover and the rail a thumbnail for each cover', async () => {
    covers.current = { 5: cover(1), 6: null };
    await open();

    await expect.element(page.getByTestId('resource-cover').first()).toBeVisible();
    // Header + rail item for the one resource that has a cover.
    expect(page.getByTestId('resource-cover').elements()).toHaveLength(2);
    expect(document.querySelector('[data-testid="resource-cover"] img')?.getAttribute('src')).toBe(
      'cover-url'
    );
    // The other resource keeps its rail slot as a placeholder.
    expect(page.getByTestId('resource-cover-placeholder').elements()).toHaveLength(1);
  });

  test('a resource without a cover shows placeholders in the header and rail, not an image', async () => {
    await open();

    expect(page.getByTestId('resource-cover').elements()).toHaveLength(0);
    // Header + two rail items.
    expect(page.getByTestId('resource-cover-placeholder').elements()).toHaveLength(3);
  });

  test("a cover above the viewer's level renders blurred instead of the image", async () => {
    covers.current = { 5: cover(8) };
    await open();

    await expect.element(page.getByTestId('blurred-cover').first()).toBeInTheDocument();
    expect(document.querySelector('[data-testid="resource-cover"] img')).toBeNull();
  });
});

describe('ResourceReviewStepper', () => {
  test('a post with few resources shows one segment each and no rated bar', async () => {
    await open();
    await expect.element(page.getByText('1 of 2')).toBeVisible();
    expect(page.getByRole('progressbar').elements()).toHaveLength(0);
  });

  test('a post with many resources shows one continuous rated bar instead of segments', async () => {
    client.setQueryData(key, manyResources(13));
    await open();
    await expect
      .element(page.getByRole('progressbar', { name: 'Resources rated' }))
      .toBeInTheDocument();
    await expect.element(page.getByText('1 of 13 · 0 rated')).toBeVisible();
  });

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

  test('Save & next stays on the resource when saving the comment fails', async () => {
    await open();
    await button('Recommend').click();
    upsert.mockRejectedValueOnce(new Error('nope'));
    await userEvent.type(page.getByLabelText('Comment'), 'Great detail');
    await button('Save & next').click();

    await expect.element(button('Save & next')).toBeEnabled();
    await expect.element(page.getByRole('heading', { name: 'Cool LoRA' })).toBeVisible();
    await expect.element(page.getByLabelText('Comment')).toHaveValue('Great detail');
  });

  test('Save & next with an unchanged comment moves on without saving again', async () => {
    await open();
    await button('Recommend').click();
    await expect.element(button('Save & next')).toBeEnabled();
    expect(upsert).toHaveBeenCalledTimes(1);
    await button('Save & next').click();

    await expect.element(page.getByRole('heading', { name: 'Other Model' })).toBeVisible();
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});
