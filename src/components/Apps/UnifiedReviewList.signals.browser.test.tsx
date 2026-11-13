import '@mantine/core/styles.css';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as UserAvatarMod from '~/components/UserAvatar/UserAvatar';
import type { OffsiteReviewRequest, OnsiteReviewRequest } from './unifiedReviewRow';

/**
 * The PENDING queue's decision signals and readability, and its PHONE layout:
 *  - each on-site row carries Preview / AI / Sensitive-permission chips (the column that holds
 *    Plays on the history tabs);
 *  - every preview and AI state renders, including the two nothing writes yet;
 *  - the display name leads, and Kind and Version render IN FULL (no "A..", no squeezed semver);
 *  - the action is a chevron "Review", not an external-link icon;
 *  - rows in their undo window are hidden;
 *  - at phone width every row's Review button is on screen with no sideways scroll.
 */

vi.mock('~/components/UserAvatar/UserAvatar', async (importOriginal) => ({
  ...(await importOriginal<typeof UserAvatarMod>()),
  UserAvatar: ({ user }: { user: { username?: string | null } }) => <span>{user.username}</span>,
}));

const BASE = {
  appBlockId: null,
  version: '12.34.56',
  bundleSizeBytes: '10',
  bundleSha256: 'sha',
  fileSummary: {},
  reviewRepoUrl: 'https://forgejo.example/repo',
  submittedBy: { id: 7, username: 'onsite-dev', deletedAt: null, image: null },
};

function onsite(id: string, over: Record<string, unknown> = {}): OnsiteReviewRequest {
  return {
    ...BASE,
    id,
    slug: `slug-${id}`,
    submittedAt: '2026-01-01T00:00:00Z',
    manifest: {
      name: `Name ${id}`,
      scopes: ['ai:write:budgeted', 'buzz:read:self', 'models:read:self'],
    },
    manifestDiffSummary: { kind: 'first-version', fields: [] },
    previewState: null,
    ...over,
  } as unknown as OnsiteReviewRequest;
}

const OFFSITE: OffsiteReviewRequest = {
  id: 'fr1',
  appListingId: 'apl_1',
  slug: 'listing-slug',
  status: 'pending',
  submittedAt: '2026-02-01T00:00:00Z',
  changelog: null,
  appListing: {
    name: 'Wayfarer',
    externalUrl: 'https://ex.com',
    category: 'utility',
    contentRating: 'g',
  },
  submittedBy: { id: 9, username: 'offsite-dev', deletedAt: null, image: null },
};

const { UnifiedReviewList } = await import('./UnifiedReviewList');
const { renderWithProviders } = await import('../../../test/component-setup');

function renderPending(onsiteItems: OnsiteReviewRequest[], extra: { hideIds?: Set<string> } = {}) {
  renderWithProviders(
    <UnifiedReviewList
      onsiteItems={onsiteItems}
      offsiteItems={[OFFSITE]}
      direction="asc"
      showSignals
      hideIds={extra.hideIds}
      openOnsiteReview={vi.fn()}
      openOffsiteReview={vi.fn()}
      isLoading={false}
      emptyLabel="empty"
      dateLabel="Submitted"
      actionLabel="Review"
      hasMore={false}
      onLoadMore={vi.fn()}
    />
  );
}

const chip = (key: string, signal: string) =>
  document.querySelector(
    `[data-testid="apps-unified-review-signals-${key}"] [data-signal="${signal}"]`
  ) as HTMLElement | null;

beforeEach(async () => {
  await page.viewport(1124, 1305);
});

describe('pending rows carry the decision signals', () => {
  test.each([
    [null, 'none', 'Preview: not started'],
    ['preview-queued', 'queued', 'Preview: queued'],
    ['preview-building', 'building', 'Preview: building'],
    ['preview-deploying', 'building', 'Preview: building'],
    ['preview-live', 'live', 'Preview: live'],
    ['preview-failed', 'failed', 'Preview: failed'],
    ['preview-expired', 'expired', 'Preview: expired'],
  ])('preview %s → %s', async (previewState, state, label) => {
    renderPending([onsite('a', { previewState })]);
    await expect
      .element(page.getByTestId('apps-unified-review-signals-onsite:a'))
      .toBeInTheDocument();
    expect(chip('onsite:a', 'preview')?.getAttribute('data-state')).toBe(state);
    expect(chip('onsite:a', 'preview')?.textContent).toBe(label);
  });

  const summary = (status: string, severities: string[] = []) => ({
    status,
    severities,
    overBroad: 0,
    underDeclared: 0,
    inaccurate: 0,
  });
  test.each([
    [null, 'not-run', 'AI: not run'],
    [summary('running'), 'running', 'AI: running'],
    [summary('failed'), 'failed', 'AI: run failed'],
    [summary('complete', ['low']), 'reported', 'AI: 1 low'],
    [summary('complete', []), 'reported', 'AI: no findings'],
  ])('AI %o → %s', async (agentReview, state, label) => {
    renderPending([onsite('a', { agentReview })]);
    await expect
      .element(page.getByTestId('apps-unified-review-signals-onsite:a'))
      .toBeInTheDocument();
    expect(chip('onsite:a', 'ai')?.getAttribute('data-state')).toBe(state);
    expect(chip('onsite:a', 'ai')?.textContent).toBe(label);
  });

  test('🔴 1 high + 2 medium: the chip COUNTS them, worst first, in red — no verdict', async () => {
    renderPending([
      onsite('a', { agentReview: summary('complete', ['medium', 'high', 'medium']) }),
    ]);
    await expect
      .element(page.getByTestId('apps-unified-review-signals-onsite:a'))
      .toBeInTheDocument();
    const ai = chip('onsite:a', 'ai')!;
    expect(ai.textContent).toBe('AI: 1 high · 2 medium');
    expect(ai.getAttribute('data-worst')).toBe('high');
    expect(ai.getAttribute('style') ?? '').toContain('red');
  });

  test('🔴 zero findings reads "no findings" — the word "pass" never appears in the queue', async () => {
    renderPending([onsite('a', { agentReview: summary('complete', []) })]);
    await expect
      .element(page.getByTestId('apps-unified-review-signals-onsite:a'))
      .toBeInTheDocument();
    expect(chip('onsite:a', 'ai')?.textContent).toBe('AI: no findings');
    expect(document.body.textContent ?? '').not.toMatch(/\bpass\b/i);
  });

  test('🔴 no agentic surface (field ABSENT) → no AI chip at all, not "not run"', async () => {
    renderPending([onsite('a')]);
    await expect
      .element(page.getByTestId('apps-unified-review-signals-onsite:a'))
      .toBeInTheDocument();
    expect(chip('onsite:a', 'preview')).not.toBeNull();
    expect(chip('onsite:a', 'ai')).toBeNull();
  });

  test('the sensitive-permission count is the manifest’s SENSITIVE scopes only', async () => {
    renderPending([
      onsite('a'),
      onsite('b', { manifest: { name: 'B', scopes: ['models:read:self'] } }),
    ]);
    await expect
      .element(page.getByTestId('apps-unified-review-signals-onsite:b'))
      .toBeInTheDocument();
    expect(chip('onsite:a', 'sensitive')?.getAttribute('data-state')).toBe('2');
    expect(chip('onsite:a', 'sensitive')?.textContent).toBe('2 sensitive perms');
    expect(chip('onsite:b', 'sensitive')?.textContent).toBe('No sensitive perms');
  });

  test('a listing row (no code) has no signals — an em dash, not empty chips', async () => {
    renderPending([onsite('a')]);
    await expect
      .element(page.getByTestId('apps-unified-review-signals-offsite:fr1'))
      .toHaveTextContent('—');
  });

  test('🔴 Plays is NOT on the Pending tab — the column holds the signals', async () => {
    renderPending([onsite('a', { playCount: 12_400 })]);
    await expect
      .element(page.getByTestId('apps-unified-review-signals-onsite:a'))
      .toBeInTheDocument();
    const headers = [...document.querySelectorAll('th')].map((h) => h.textContent?.trim());
    expect(headers).toContain('Signals');
    expect(headers.some((h) => h?.includes('Plays'))).toBe(false);
    expect(page.getByTestId('apps-unified-review-plays-onsite:a').elements()).toHaveLength(0);
  });

  test('rows in their undo window are hidden', async () => {
    renderPending([onsite('a'), onsite('b')], { hideIds: new Set(['a']) });
    await expect.element(page.getByTestId('apps-unified-review-row-onsite:b')).toBeInTheDocument();
    expect(page.getByTestId('apps-unified-review-row-onsite:a').elements()).toHaveLength(0);
  });
});

describe('readability', () => {
  test('🔴 the DISPLAY NAME leads the App cell, the slug under it', async () => {
    renderPending([onsite('a')]);
    await expect
      .element(page.getByTestId('apps-unified-review-name-onsite:a'))
      .toHaveTextContent('Name a');
  });

  test.each([
    [1124, 1305],
    [390, 844],
  ])('🔴 Kind and Version render IN FULL at %ix%i — nothing clipped', async (w, h) => {
    await page.viewport(w, h);
    renderPending([onsite('a')]);
    const kind = page.getByTestId('apps-unified-review-kind-onsite:a');
    await expect.element(kind).toHaveTextContent('App');
    const label = kind.element().querySelector('[class*="label"]') as HTMLElement;
    // A clipped label is wider inside than its box.
    expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth + 1);
    const version = page.getByTestId('apps-unified-review-version-onsite:a');
    const code = version.element().querySelector('code') as HTMLElement;
    expect(code.textContent).toBe('12.34.56');
    expect(code.scrollWidth).toBeLessThanOrEqual(code.clientWidth + 1);
    const firstVersion = page.getByTestId('apps-unified-review-first-version-onsite:a');
    const fvLabel = firstVersion.element().querySelector('[class*="label"]') as HTMLElement;
    expect(fvLabel.scrollWidth).toBeLessThanOrEqual(fvLabel.clientWidth + 1);
  });

  test('the action is a chevron, not an external-link icon', async () => {
    renderPending([onsite('a')]);
    const btn = page.getByTestId('apps-unified-review-action-onsite:a');
    await expect.element(btn).toBeInTheDocument();
    expect(btn.element().querySelector('.tabler-icon-chevron-right')).not.toBeNull();
    expect(btn.element().querySelector('.tabler-icon-external-link')).toBeNull();
  });
});

describe('🔴 phone width: rows are cards, and every Review button is on screen', () => {
  test('at 390px no row needs a sideways scroll to reach its Review button', async () => {
    await page.viewport(390, 844);
    renderPending([onsite('a'), onsite('b'), onsite('c')]);
    await expect
      .element(page.getByTestId('apps-unified-review-action-onsite:c'))
      .toBeInTheDocument();
    for (const key of ['onsite:a', 'onsite:b', 'onsite:c', 'offsite:fr1']) {
      const btn = page.getByTestId(`apps-unified-review-action-${key}`).element() as HTMLElement;
      const r = btn.getBoundingClientRect();
      expect(r.width, `${key} button is laid out`).toBeGreaterThan(0);
      expect(r.left, `${key} button starts on screen`).toBeGreaterThanOrEqual(0);
      expect(r.right, `${key} button ends on screen`).toBeLessThanOrEqual(390);
    }
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390 + 1);
    // The table header is the desktop layout; the cards have none.
    const thead = document.querySelector('[data-testid="apps-unified-review-table"] thead');
    expect(getComputedStyle(thead as Element).display).toBe('none');
  });

  test('NEGATIVE CONTROL: at desktop width it is still a table with a header row', async () => {
    renderPending([onsite('a')]);
    await expect.element(page.getByTestId('apps-unified-review-table')).toBeInTheDocument();
    const thead = document.querySelector('[data-testid="apps-unified-review-table"] thead');
    expect(getComputedStyle(thead as Element).display).toBe('table-header-group');
  });
});
