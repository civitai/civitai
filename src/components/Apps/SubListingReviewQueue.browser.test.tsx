import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';

/** The `/apps/review` Sub-listings tab: what each row offers, and what each action sends. */

type Row = Record<string, unknown>;
const m = vi.hoisted(() => ({
  rows: [] as Row[],
  calls: [] as Record<string, unknown>[],
  invalidated: [] as string[],
  lastView: null as unknown,
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const invalidator = (name: string) => ({
    invalidate: () => {
      m.invalidated.push(name);
      return Promise.resolve();
    },
  });
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: makeTrpcProxy(
      {
        'appListings.listSubListingQueue': {
          useQuery: (input: { view: string }) => {
            m.lastView = input.view;
            return { data: { items: m.rows }, isLoading: false, error: null, refetch: vi.fn() };
          },
        },
        'appListings.moderateSubListing': {
          useMutation: (opts: {
            onSuccess?: (d: unknown, v: Record<string, unknown>) => unknown;
          }) => ({
            isPending: false,
            variables: undefined,
            mutate: (vars: Record<string, unknown>) => {
              m.calls.push(vars);
              void opts.onSuccess?.({}, vars);
            },
          }),
        },
      },
      {
        useUtils: () => ({
          appListings: {
            listSubListingQueue: invalidator('listSubListingQueue'),
            countSubListingQueue: invalidator('countSubListingQueue'),
          },
        }),
      }
    ),
  };
});

const { SubListingReviewQueue, subListingEditDiff, subListingRowActions } = await import(
  './SubListingReviewQueue'
);

const live = {
  title: 'Neon Portraits',
  tagline: 'Glowing headshots',
  imageId: null,
  subPath: 'g/NEON',
  contentRating: null,
  imageUrl: null,
};

function row(over: Row = {}): Row {
  return {
    id: 'asl_1',
    status: 'pending',
    statusReason: null,
    itemKey: 'neon',
    parent: { id: 'apl_P', slug: 'custom-generators', name: 'Custom Generators' },
    author: { id: 7, username: 'pixelwitch', image: null },
    live,
    pending: null,
    createdAt: new Date(),
    moderatedAt: null,
    ...over,
  };
}

const buttonNames = () =>
  page
    .getByTestId('sub-listing-row')
    .getByRole('button')
    .elements()
    .map((b) => b.textContent);

beforeEach(() => {
  m.rows = [];
  m.calls = [];
  m.invalidated = [];
});

describe('subListingRowActions', () => {
  test('offers exactly the transitions the server accepts', () => {
    expect(subListingRowActions({ status: 'pending', pending: null })).toEqual(['approve', 'hide']);
    expect(subListingRowActions({ status: 'approved', pending: null })).toEqual(['hide']);
    expect(subListingRowActions({ status: 'approved', pending: live as never })).toEqual([
      'approve-edit',
      'reject-edit',
      'hide',
    ]);
    expect(subListingRowActions({ status: 'hidden', pending: null })).toEqual(['restore']);
    expect(subListingRowActions({ status: 'withdrawn', pending: null })).toEqual([]);
  });

  test('the edit diff lists only the fields that change', () => {
    const diff = subListingEditDiff(live as never, { ...live, title: 'Neon v2' } as never);
    expect(diff).toEqual([
      { key: 'title', label: 'Title', before: 'Neon Portraits', after: 'Neon v2' },
    ]);
  });
});

describe('SubListingReviewQueue', () => {
  test('approving a new item sends approve and refreshes the queue and the tab count', async () => {
    m.rows = [row()];
    renderWithProviders(<SubListingReviewQueue />);
    await expect.element(page.getByText('Neon Portraits')).toBeVisible();
    expect(buttonNames()).toEqual(['Approve', 'Hide']);
    await userEvent.click(page.getByRole('button', { name: 'Approve' }));
    expect(m.calls).toEqual([{ id: 'asl_1', action: 'approve' }]);
    await expect
      .poll(() => [...m.invalidated].sort())
      .toEqual(['countSubListingQueue', 'listSubListingQueue']);
  });

  test('hiding asks for a reason and sends it', async () => {
    m.rows = [row({ status: 'approved' })];
    renderWithProviders(<SubListingReviewQueue />);
    await userEvent.click(page.getByRole('button', { name: 'Hide' }));
    const dialog = page.getByRole('dialog');
    const confirm = dialog.getByRole('button', { name: 'Hide' });
    await expect.element(confirm).toBeDisabled();
    expect(m.calls).toEqual([]);
    await dialog.getByRole('textbox').fill('Misleading title');
    await userEvent.click(confirm);
    expect(m.calls).toEqual([{ id: 'asl_1', action: 'hide', reason: 'Misleading title' }]);
  });

  test('a staged edit shows a before/after diff and approve-edit / reject-edit', async () => {
    m.rows = [
      row({
        status: 'approved',
        pending: { ...live, title: 'Neon Portraits v2', submittedAt: new Date() },
      }),
    ];
    renderWithProviders(<SubListingReviewQueue />);
    await expect
      .element(page.getByTestId('sub-listing-diff-title'))
      .toHaveTextContent(/^Neon Portraits$/);
    await expect
      .element(page.getByTestId('sub-listing-diff-title-proposed'))
      .toHaveTextContent('Neon Portraits v2');
    expect(page.getByTestId('sub-listing-diff-tagline').elements()).toHaveLength(0);
    expect(buttonNames()).toEqual(['Approve edit', 'Reject edit', 'Hide']);
    await userEvent.click(page.getByRole('button', { name: 'Approve edit' }));
    expect(m.calls).toEqual([{ id: 'asl_1', action: 'approve-edit' }]);
  });

  test('rejecting an edit takes an optional reason', async () => {
    m.rows = [
      row({ status: 'approved', pending: { ...live, title: 'x', submittedAt: new Date() } }),
    ];
    renderWithProviders(<SubListingReviewQueue />);
    await userEvent.click(page.getByRole('button', { name: 'Reject edit' }));
    await userEvent.click(page.getByRole('dialog').getByRole('button', { name: 'Reject edit' }));
    expect(m.calls).toEqual([{ id: 'asl_1', action: 'reject-edit', reason: undefined }]);
  });

  test('a hidden item offers restore', async () => {
    m.rows = [row({ status: 'hidden', statusReason: 'spam' })];
    renderWithProviders(<SubListingReviewQueue />);
    await expect.element(page.getByText('spam')).toBeVisible();
    expect(buttonNames()).toEqual(['Restore']);
    await userEvent.click(page.getByRole('button', { name: 'Restore' }));
    expect(m.calls).toEqual([{ id: 'asl_1', action: 'restore' }]);
  });

  test('switching view asks for that list', async () => {
    renderWithProviders(<SubListingReviewQueue />);
    expect(m.lastView).toBe('queue');
    await userEvent.click(page.getByText('Hidden'));
    await expect.poll(() => m.lastView).toBe('hidden');
  });
});
