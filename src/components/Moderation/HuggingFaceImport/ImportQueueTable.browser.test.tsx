import { ModalsProvider } from '@mantine/modals';
import { IsClientProvider } from '~/providers/IsClientProvider';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as TrpcModule from '~/utils/trpc';
import { renderWithProviders } from '../../../../test/component-setup';

/**
 * A storage refusal must end in a choice, not a dead end: the page shows why cleanup failed and
 * offers to go ahead, and going ahead re-sends the same action with `force`.
 */

const listed = vi.hoisted(() => ({ rows: [] as unknown[] }));
const { mockRetry, mockDelete, stuckRow, completed, fakeMutation, noop } = vi.hoisted(() => {
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

  const completed = (over: Record<string, unknown>) => ({
    ...stuckRow,
    status: 'Completed',
    error: null,
    url: 'https://s3.example/model-bucket/model/7/x.safetensors',
    bytesTransferred: stuckRow.sizeBytes,
    ...over,
  });

  return { mockRetry: vi.fn(), mockDelete: vi.fn(), stuckRow, completed, fakeMutation, noop };
});

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: {
    useUtils: () => ({
      huggingFaceImport: { getAll: { invalidate: noop }, getCounts: { invalidate: noop } },
    }),
    huggingFaceImport: {
      getAll: { useQuery: () => ({ data: listed.rows, isLoading: false }) },
      getCounts: { useQuery: () => ({ data: { total: 1, unattached: 0 } }) },
      retry: { useMutation: fakeMutation(mockRetry) },
      delete: { useMutation: fakeMutation(mockDelete) },
      cancel: { useMutation: fakeMutation(vi.fn()) },
      detach: { useMutation: fakeMutation(vi.fn()) },
      attach: { useMutation: fakeMutation(vi.fn()) },
      renameGroup: { useMutation: fakeMutation(vi.fn()) },
    },
  },
}));

import { ImportQueueTable } from '~/components/Moderation/HuggingFaceImport/ImportQueueTable';

const storageRefusal = {
  ok: false,
  reason: 'storage',
  message: 'Could not abort the partial upload: The specified bucket does not exist',
};

function renderTable(width?: number) {
  renderWithProviders(
    <IsClientProvider>
      <ModalsProvider>
        <div style={{ width, maxWidth: '100%' }}>
          <ImportQueueTable />
        </div>
      </ModalsProvider>
    </IsClientProvider>
  );
}

beforeEach(() => {
  listed.rows = [stuckRow];
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

describe('ImportQueueTable — layout', () => {
  test('a card fits its container, so the actions are never scrolled out of sight', async () => {
    // A narrow column is where a non-wrapping row breaks first; the sidebar layout has one.
    renderTable(240);
    const restart = page.getByRole('button', { name: 'Restart import' });
    await expect.element(restart).toBeVisible();

    // A Hugging Face filename is one unbroken word. The column layout this replaced let that widen
    // the row until the actions sat inside a horizontal scroll, where they were never found.
    const card = restart.element().closest('.mantine-Card-root') as HTMLElement;
    expect(card).toBeTruthy();
    expect({
      overflow: Math.max(0, Math.round(card.scrollWidth - card.clientWidth)),
      actionOutside: Math.max(
        0,
        Math.round(
          restart.element().getBoundingClientRect().right - card.getBoundingClientRect().right
        )
      ),
    }).toEqual({ overflow: 0, actionOutside: 0 });
  });
});

describe('ImportQueueTable — what can be deleted', () => {
  test('a transferred file no version claimed can be deleted; an attached one cannot', async () => {
    listed.rows = [
      stuckRow,
      completed({ id: 8, filename: 'free.safetensors', modelFileId: null }),
      completed({ id: 9, filename: 'claimed.safetensors', modelFileId: 55, modelVersionId: 12 }),
    ];
    renderTable();
    await expect.element(page.getByText('claimed.safetensors', { exact: false })).toBeVisible();

    // Storage nobody has claimed is the whole point of the Unattached tab; the queue offers the
    // same exit, and an attached file is refused server-side anyway.
    expect(page.getByRole('button', { name: 'Delete import' }).elements()).toHaveLength(2);
    expect(page.getByRole('button', { name: 'Detach import' }).elements()).toHaveLength(1);
  });
});

describe('ImportGroupList — provenance', () => {
  test('the group links to the repo at the revision it was imported from', async () => {
    renderTable();
    const link = page.getByRole('link', { name: stuckRow.repo, exact: true });
    await expect.element(link).toBeVisible();

    // The pinned commit, not a branch: a branch moves, and then the link no longer shows the files
    // that were actually imported.
    expect(link.element().getAttribute('href')).toBe(
      `https://huggingface.co/${stuckRow.repo}/tree/${stuckRow.revision}`
    );
  });
});
