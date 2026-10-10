import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as TrpcMod from '~/utils/trpc';
import type * as UserAvatarMod from '~/components/UserAvatar/UserAvatar';
import type { VersionHistoryEntry } from './PriorVersionsModal';

/**
 * The moderator PRIOR-VERSIONS modal — every state it can be in, plus the one behaviour
 * that is not a state: the history read must not fire while the modal is closed.
 */

const queryState = vi.hoisted(() => ({
  current: {
    data: undefined as unknown,
    error: null as { message: string } | null,
    isLoading: false,
  },
  /** Every `useQuery` call this file made, so the `enabled` gate can be asserted. */
  calls: [] as { input: { slug: string }; enabled: boolean }[],
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: {
    blocks: {
      listVersionHistory: {
        useQuery: (input: { slug: string }, opts: { enabled?: boolean }) => {
          queryState.calls.push({ input, enabled: !!opts.enabled });
          return queryState.current;
        },
      },
    },
  },
}));

// Same reason as the review list's own browser suite: the real avatar needs three providers
// this harness does not mount, and the modal's contract with it is only which user it names.
vi.mock('~/components/UserAvatar/UserAvatar', async (importOriginal) => ({
  ...(await importOriginal<typeof UserAvatarMod>()),
  UserAvatar: ({ user }: { user: { id: number; username?: string | null } }) => (
    <span>{user.username ?? `#${user.id}`}</span>
  ),
}));

const { PriorVersionsBody, PriorVersionsModal } = await import('./PriorVersionsModal');
const { renderWithProviders } = await import('../../../test/component-setup');

const SELECTION = { slug: 'lighthouse', currentRequestId: 'pubreq_b', title: 'Lighthouse' };

/** Three entries, every field pairwise distinct from every other row's. */
const ENTRIES: VersionHistoryEntry[] = [
  {
    id: 'pubreq_b',
    version: '2.0.0',
    status: 'pending',
    submittedAt: '2026-05-04T00:00:00Z',
    reviewedAt: null,
    submittedBy: { id: 11, username: 'ada', deletedAt: null, image: null },
    reviewedBy: null,
    rejectionReason: null,
    deployState: null,
  },
  {
    id: 'pubreq_a',
    version: '1.3.0',
    status: 'rejected',
    submittedAt: '2026-04-03T00:00:00Z',
    reviewedAt: '2026-04-04T00:00:00Z',
    submittedBy: { id: 12, username: 'grace', deletedAt: null, image: null },
    reviewedBy: { id: 13, username: 'hopper', deletedAt: null, image: null },
    rejectionReason: 'Manifest declares a scope it never uses',
    deployState: null,
  },
  {
    id: 'pubreq_0',
    version: '1.0.0',
    status: 'approved',
    submittedAt: '2026-03-02T00:00:00Z',
    reviewedAt: '2026-03-03T00:00:00Z',
    submittedBy: { id: 12, username: 'grace', deletedAt: null, image: null },
    reviewedBy: { id: 14, username: 'turing', deletedAt: null, image: null },
    rejectionReason: null,
    deployState: 'live',
  },
];

beforeEach(() => {
  queryState.current = { data: undefined, error: null, isLoading: false };
  queryState.calls.length = 0;
});

describe('PriorVersionsBody — the four states', () => {
  test('LOADING shows a loader, not an empty history', async () => {
    renderWithProviders(<PriorVersionsBody selection={SELECTION} entries={[]} loading />);
    await expect.element(page.getByTestId('apps-prior-versions-loading')).toBeInTheDocument();
    expect(page.getByTestId('apps-prior-versions-empty').elements()).toEqual([]);
  });

  test('ERROR shows the message, never an empty history', async () => {
    // A failed read that rendered "no submissions" would be a confident wrong answer about
    // an app's whole record.
    renderWithProviders(
      <PriorVersionsBody selection={SELECTION} entries={[]} errorMessage="UNAUTHORIZED" />
    );
    await expect
      .element(page.getByTestId('apps-prior-versions-error'))
      .toHaveTextContent('UNAUTHORIZED');
    expect(page.getByTestId('apps-prior-versions-empty').elements()).toEqual([]);
    expect(page.getByTestId('apps-prior-versions-list').elements()).toEqual([]);
  });

  test('EMPTY says so', async () => {
    renderWithProviders(<PriorVersionsBody selection={SELECTION} entries={[]} />);
    await expect.element(page.getByTestId('apps-prior-versions-empty')).toBeInTheDocument();
  });

  test('ENTRIES render newest-first with version, status, reviewer and the reject reason', async () => {
    renderWithProviders(<PriorVersionsBody selection={SELECTION} entries={ENTRIES} />);
    const list = page.getByTestId('apps-prior-versions-list');
    await expect.element(list).toBeInTheDocument();
    const rows = page.getByTestId(/^apps-history-entry-/).elements();
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([
      'apps-history-entry-pubreq_b',
      'apps-history-entry-pubreq_a',
      'apps-history-entry-pubreq_0',
    ]);
    // The shared row renderer, so the status colour + version badge match the author view.
    await expect
      .element(page.getByTestId('apps-history-status-pubreq_a'))
      .toHaveTextContent('rejected');
    await expect
      .element(page.getByTestId('apps-history-notes-pubreq_a'))
      .toHaveTextContent('Manifest declares a scope it never uses');
    expect(list.element().textContent).toContain('v1.3.0');
    // Submitter AND reviewer are both named — the mod surface's addition to the shared row.
    expect(list.element().textContent).toContain('grace');
    expect(list.element().textContent).toContain('hopper');
    expect(list.element().textContent).toContain('live');
  });

  test('the CURRENT entry is marked, and only that one', async () => {
    renderWithProviders(<PriorVersionsBody selection={SELECTION} entries={ENTRIES} />);
    await expect
      .element(page.getByTestId('apps-prior-versions-current-pubreq_b'))
      .toHaveTextContent('current');
    expect(page.getByTestId(/^apps-prior-versions-current-/).elements()).toHaveLength(1);
  });

  test('no WITHDRAW control is offered to a moderator', async () => {
    // Both withdraw procs are submitter-scoped, so a button here could only ever 403.
    renderWithProviders(<PriorVersionsBody selection={SELECTION} entries={ENTRIES} />);
    await expect.element(page.getByTestId('apps-prior-versions-list')).toBeInTheDocument();
    expect(page.getByTestId(/^apps-history-withdraw-/).elements()).toEqual([]);
  });

  test('a TRUNCATED read says so rather than presenting a clipped list as complete', async () => {
    renderWithProviders(<PriorVersionsBody selection={SELECTION} entries={ENTRIES} truncated />);
    await expect.element(page.getByTestId('apps-prior-versions-truncated')).toBeInTheDocument();
  });
});

describe('PriorVersionsModal — opening, the read gate, and closing', () => {
  test('CLOSED renders no dialog and the history read is DISABLED', async () => {
    renderWithProviders(<PriorVersionsModal selection={null} onClose={vi.fn()} />);
    // The harness commits asynchronously, so a synchronous read here races the mount and
    // sees zero query calls whether or not the gate works.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    // Mantine keeps the Modal mounted and toggles `opened`, so the dialog must be absent
    // rather than merely empty.
    expect(page.getByRole('dialog').elements()).toEqual([]);
    expect(queryState.calls.length).toBeGreaterThan(0);
    expect(
      queryState.calls.every((c) => c.enabled === false),
      'the history query ran while the modal was closed'
    ).toBe(true);
  });

  test('OPEN renders the dialog, titles it with the slug, and ENABLES the read for it', async () => {
    queryState.current = {
      data: { items: ENTRIES, truncated: false },
      error: null,
      isLoading: false,
    };
    renderWithProviders(<PriorVersionsModal selection={SELECTION} onClose={vi.fn()} />);
    await expect.element(page.getByRole('dialog')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-prior-versions-list')).toBeInTheDocument();
    expect(page.getByRole('dialog').element().textContent).toContain('lighthouse');
    const enabled = queryState.calls.filter((c) => c.enabled);
    expect(enabled.length).toBeGreaterThan(0);
    // POSITIVE CONTROL for the gate: it is enabled for THIS slug, not for an empty one.
    expect(enabled.every((c) => c.input.slug === 'lighthouse')).toBe(true);
  });

  test("the app's NAME renders beside the slug", async () => {
    queryState.current = {
      data: { items: ENTRIES, truncated: false },
      error: null,
      isLoading: false,
    };
    renderWithProviders(<PriorVersionsModal selection={SELECTION} onClose={vi.fn()} />);
    await expect
      .element(page.getByTestId('apps-prior-versions-title'))
      .toHaveTextContent('Lighthouse');
    // Distinct from the slug in the fixture, so this cannot pass by the two coinciding.
    expect(SELECTION.title).not.toBe(SELECTION.slug);
  });

  test('…and is SUPPRESSED when the name IS the slug', async () => {
    // The branch a reader would not guess from the field name: an app whose manifest name
    // is its slug would otherwise read twice in one title.
    queryState.current = {
      data: { items: ENTRIES, truncated: false },
      error: null,
      isLoading: false,
    };
    renderWithProviders(
      <PriorVersionsModal selection={{ ...SELECTION, title: SELECTION.slug }} onClose={vi.fn()} />
    );
    await expect.element(page.getByRole('dialog')).toBeInTheDocument();
    expect(page.getByTestId('apps-prior-versions-title').elements()).toEqual([]);
    // Positive control that the dialog really rendered its title area.
    expect(page.getByRole('dialog').element().textContent).toContain(SELECTION.slug);
  });

  test('the close control invokes onClose', async () => {
    queryState.current = {
      data: { items: ENTRIES, truncated: false },
      error: null,
      isLoading: false,
    };
    const onClose = vi.fn();
    renderWithProviders(<PriorVersionsModal selection={SELECTION} onClose={onClose} />);
    await expect.element(page.getByRole('dialog')).toBeInTheDocument();
    await page.getByRole('button', { name: 'Close version history' }).click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
