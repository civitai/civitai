import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * Global "Active previews (N / cap)" panel — browser-mode render test
 * (report-only in Tekton). The panel was extracted from `src/pages/apps/review.tsx`
 * to `ActivePreviewsPanel.tsx` (mirrors the #3163 `OnsiteReviewModal` extraction)
 * so it is importable WITHOUT the page's `getServerSideProps` server graph — this
 * suite is the coverage that extraction unlocks. Asserts:
 *  - a `preview-live` row renders an "Open full-page preview" link to the internal
 *    same-origin `/apps/review/preview/<id>` route (new tab) AND still renders
 *    "Tear down";
 *  - a `preview-building` / `preview-deploying` row renders NO "Open" link (only
 *    "Tear down") — a not-yet-live preview isn't openable;
 *  - "Tear down" fires `blocks.teardownPreview` with the row's publishRequestId.
 */

const ROWS = [
  {
    publishRequestId: 'req-live',
    slug: 'live-block',
    version: '1.0.0',
    state: 'preview-live',
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  },
  {
    publishRequestId: 'req-building',
    slug: 'building-block',
    version: '2.0.0',
    state: 'preview-building',
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  },
  {
    publishRequestId: 'req-deploying',
    slug: 'deploying-block',
    version: '3.0.0',
    state: 'preview-deploying',
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  },
];

const mocks = vi.hoisted(() => ({
  invalidate: vi.fn().mockResolvedValue(undefined),
  mutate: vi.fn(),
  // Query state the panel renders from — { cap, active } | undefined, plus an
  // optional error to exercise the authz-silent / transient-retry branches.
  data: undefined as unknown,
  error: null as unknown,
}));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: true }),
}));

vi.mock('~/utils/notifications', () => ({
  showSuccessNotification: vi.fn(),
  showErrorNotification: vi.fn(),
}));

vi.mock('~/utils/trpc', () => {
  const mutation =
    (name: string) =>
    (opts?: { onSuccess?: (res: unknown, vars: unknown) => void; onError?: (e: { message: string }) => void }) => ({
      mutate: (vars: unknown) => {
        mocks.mutate(name, vars);
        void opts?.onSuccess?.(undefined, vars);
      },
      mutateAsync: vi.fn(),
      isPending: false,
      variables: undefined,
    });
  const inert = { invalidate: mocks.invalidate };
  const utils = {
    blocks: {
      listActivePreviews: inert,
      getReviewStatus: inert,
    },
  };
  return {
    trpc: {
      useUtils: () => utils,
      blocks: {
        listActivePreviews: {
          useQuery: () => ({
            data: mocks.data,
            error: mocks.error,
            isFetching: false,
            refetch: vi.fn(),
          }),
        },
        teardownPreview: { useMutation: mutation('teardown') },
      },
    },
  };
});

const { ActivePreviewsPanel } = await import('./ActivePreviewsPanel');

beforeEach(() => {
  mocks.invalidate.mockClear();
  mocks.mutate.mockClear();
  mocks.data = { cap: 3, active: ROWS };
  mocks.error = null;
});

describe('ActivePreviewsPanel — Open affordance is live-only + coexists with Tear down', () => {
  test('a preview-live row renders an "Open full-page preview" link to the internal route (new tab) plus Tear down', async () => {
    renderWithProviders(<ActivePreviewsPanel />);

    // The panel header + count render for a non-empty active set.
    await expect.element(page.getByText('Active previews')).toBeInTheDocument();

    // The live row exposes the Open link, keyed by publishRequestId to the
    // same-origin internal review route — opened top-level in a new tab.
    const link = page.getByRole('link', { name: /Open full-page preview/ });
    await expect.element(link).toBeInTheDocument();
    const el = link.element() as HTMLAnchorElement;
    expect(el.getAttribute('href')).toBe('/apps/review/preview/req-live');
    expect(el.getAttribute('target')).toBe('_blank');
    expect(el.getAttribute('rel')).toContain('noopener');

    // Tear down is still present on every row (3 rows → 3 buttons).
    expect(page.getByRole('button', { name: 'Tear down' }).elements()).toHaveLength(3);

    // Exactly ONE Open link — only the single live row is openable.
    expect(page.getByRole('link', { name: /Open full-page preview/ }).elements()).toHaveLength(1);
  });

  test('a building / deploying row renders NO Open link (only Tear down)', async () => {
    // Restrict the dataset to the two non-live rows so no live row exists.
    mocks.data = {
      cap: 3,
      active: ROWS.filter((r) => r.state !== 'preview-live'),
    };
    renderWithProviders(<ActivePreviewsPanel />);

    await expect.element(page.getByText('Active previews')).toBeInTheDocument();
    // Both non-live rows still get a Tear down…
    expect(page.getByRole('button', { name: 'Tear down' }).elements()).toHaveLength(2);
    // …but neither is openable.
    expect(page.getByRole('link', { name: /Open full-page preview/ }).elements()).toHaveLength(0);
  });
});

describe('ActivePreviewsPanel — Tear down fires the mutation', () => {
  test('clicking Tear down fires blocks.teardownPreview with the row publishRequestId', async () => {
    mocks.data = { cap: 1, active: [ROWS[0]] };
    renderWithProviders(<ActivePreviewsPanel />);
    await page.getByRole('button', { name: 'Tear down' }).click();
    expect(mocks.mutate).toHaveBeenCalledWith('teardown', { publishRequestId: 'req-live' });
  });
});
