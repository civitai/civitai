import { useController } from 'react-hook-form';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type * as FormModule from '~/libs/form';
import type * as TrpcModule from '~/utils/trpc';
import { renderWithProviders } from '../../../../test/component-setup';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';

const upsert = vi.hoisted(() => vi.fn());

vi.mock('~/libs/form', async (importOriginal) => ({
  ...(await importOriginal<typeof FormModule>()),
  InputRTE: ({ name }: { name: string }) => {
    const { field } = useController({ name });
    return (
      <textarea
        aria-label="comment"
        value={field.value}
        onChange={(e) => field.onChange(e.target.value)}
      />
    );
  },
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: makeTrpcProxy(
    { 'resourceReview.upsert': { useMutation: () => ({ mutate: upsert, isPending: false }) } },
    { useUtils: () => ({ resourceReview: { getUserResourceReview: { invalidate: vi.fn() } } }) }
  ),
}));

import { EditResourceReview } from '../EditResourceReview';

beforeEach(() => upsert.mockClear());

describe('EditResourceReview', () => {
  test('saves the comment of a thumbs-down review', async () => {
    renderWithProviders(
      <EditResourceReview
        id={7}
        modelId={1}
        modelVersionId={2}
        rating={1}
        recommended={false}
        initialEditing
      />
    );
    await userEvent.fill(page.getByLabelText('comment'), 'did not work for me');
    await page.getByRole('button', { name: 'Save' }).click();

    await expect.poll(() => upsert.mock.calls.length).toBe(1);
    expect(upsert.mock.calls[0][0]).toMatchObject({
      id: 7,
      recommended: false,
      details: 'did not work for me',
    });
  });
});
