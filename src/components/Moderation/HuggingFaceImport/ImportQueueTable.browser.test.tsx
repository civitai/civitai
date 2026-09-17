import { ModalsProvider } from '@mantine/modals';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as TrpcModule from '~/utils/trpc';
import { renderWithProviders } from '../../../../test/component-setup';

/**
 * A storage refusal must end in a choice, not a dead end: the page shows why cleanup failed and
 * offers to go ahead, and going ahead re-sends the same action with `force`.
 */

const { mockRetry, mockDelete, stuckRow, fakeMutation, noop } = vi.hoisted(() => {
  const stuckRow = {
    id: 7,
    groupName: 'boogu',
    repo: 'Comfy-Org/Boogu-Image',
    revision: 'aaaaaaa1',
    filename: 'diffusion_models/boogu_image_edit_int8_convrot.safetensors',
    status: 'Failed',
    sizeBytes: 20_585_228_872,
    bytesTransferred: 268_435_456,
    error: 'The specified bucket does not exist: civitai-delivery-worker-prod',
    url: null,
    modelFileId: null,
    modelVersionId: null,
    suggestedType: null,
    createdAt: new Date('2026-09-15'),
  };

  /** Enough of a react-query mutation for this page: `mutate` resolves, then calls the handlers. */
  const fakeMutation =
    (fn: (input: unknown) => unknown) =>
    (options?: {
      onSuccess?: (result: unknown, input: unknown) => unknown;
      onError?: (error: unknown) => unknown;
    }) => ({
      mutate: (input: unknown) =>
        Promise.resolve(fn(input)).then(
          (result) => options?.onSuccess?.(result, input),
          (error) => options?.onError?.(error)
        ),
      isPending: false,
      variables: undefined,
    });

  const noop = () => Promise.resolve();

  return { mockRetry: vi.fn(), mockDelete: vi.fn(), stuckRow, fakeMutation, noop };
});

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: {
    useUtils: () => ({
      huggingFaceImport: { getAll: { invalidate: noop }, getCounts: { invalidate: noop } },
    }),
    huggingFaceImport: {
      getAll: { useQuery: () => ({ data: [stuckRow], isLoading: false }) },
      getCounts: { useQuery: () => ({ data: { total: 1, unattached: 0 } }) },
      retry: { useMutation: fakeMutation(mockRetry) },
      delete: { useMutation: fakeMutation(mockDelete) },
      cancel: { useMutation: fakeMutation(vi.fn()) },
      detach: { useMutation: fakeMutation(vi.fn()) },
      attach: { useMutation: fakeMutation(vi.fn()) },
    },
  },
}));

import { ImportQueueTable } from '~/components/Moderation/HuggingFaceImport/ImportQueueTable';

const storageRefusal = {
  ok: false,
  reason: 'storage',
  message: 'Could not abort the partial upload: The specified bucket does not exist',
};

function renderTable() {
  renderWithProviders(
    <ModalsProvider>
      <ImportQueueTable />
    </ModalsProvider>
  );
}

beforeEach(() => {
  mockRetry.mockReset();
  mockDelete.mockReset();
});

describe('ImportQueueTable — stuck imports', () => {
  test('restart shows why cleanup failed, and "Restart anyway" re-sends with force', async () => {
    mockRetry.mockImplementation((input: { force?: boolean }) =>
      input.force ? { ok: true } : storageRefusal
    );
    renderTable();

    await page.getByRole('button', { name: 'Restart import' }).click();
    await expect.element(page.getByText('Restart without cleaning up storage?')).toBeVisible();
    await expect
      .element(page.getByText('The specified bucket does not exist', { exact: false }).first())
      .toBeVisible();
    expect(mockRetry).toHaveBeenCalledTimes(1);

    await page.getByRole('button', { name: 'Restart anyway' }).click();
    await expect.poll(() => mockRetry.mock.calls.length).toBe(2);
    expect(mockRetry.mock.calls[1][0]).toEqual({ id: 7, force: true });
  });

  test('"Keep it" sends nothing further', async () => {
    mockRetry.mockReturnValue(storageRefusal);
    renderTable();

    await page.getByRole('button', { name: 'Restart import' }).click();
    await page.getByRole('button', { name: 'Keep it' }).click();

    await expect
      .element(page.getByText('Restart without cleaning up storage?'))
      .not.toBeInTheDocument();
    expect(mockRetry).toHaveBeenCalledTimes(1);
  });

  test('delete asks twice — once to delete, once more when storage cannot be freed', async () => {
    mockDelete.mockImplementation((input: { force?: boolean }) =>
      input.force ? { ok: true } : storageRefusal
    );
    renderTable();

    await page.getByRole('button', { name: 'Delete import' }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect.element(page.getByText('Delete without cleaning up storage?')).toBeVisible();

    await page.getByRole('button', { name: 'Delete anyway' }).click();
    await expect.poll(() => mockDelete.mock.calls.length).toBe(2);
    expect(mockDelete.mock.calls.map(([input]) => input)).toEqual([
      { id: 7 },
      { id: 7, force: true },
    ]);
  });
});
