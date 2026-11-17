import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';

import { renderWithProviders } from '../../../test/component-setup';
import {
  AppEarningsPanelView,
  earningsUnavailableMessage,
} from '~/components/Apps/AppEarningsPanel';
import type { AppEarningsResult } from '~/server/services/blocks/app-collaborator-earnings.service';

/**
 * The app-scoped earnings panel — the client that makes the invite disclosure's earnings
 * promise TRUE. Props-only view; the container's tRPC wiring is out of frame.
 */

const FEES = {
  paidWindowDays: 90,
  accrued: { count: 2, feeBuzz: 3, byBuzzType: { yellow: 3 } },
  settled: { count: 2, feeBuzz: 12, byBuzzType: { blue: 4, yellow: 8 } },
  byApp: [
    {
      appBlockId: 'ab_1',
      accrued: { count: 2, feeBuzz: 3, byBuzzType: { yellow: 3 } },
      settled: { count: 2, feeBuzz: 12, byBuzzType: { blue: 4, yellow: 8 } },
    },
  ],
  recent: [
    {
      id: 'bafa_1',
      appBlockId: 'ab_1',
      feeBuzz: 8,
      buzzType: 'yellow',
      status: 'settled',
      accruedAt: new Date('2026-11-09T10:00:00Z'),
      settledAt: new Date('2026-11-10T02:30:00Z'),
    },
  ],
};
const GOODS = {
  sales: {
    count: 1,
    grossBuzz: 10,
    shareBuzz: 7,
    shareUsdCents: 0,
    grossUsdCents: 1,
    blueGrossBuzz: 0,
  },
  refunded: { count: 0, grossBuzz: 0 },
};

function ok(over: Partial<Extract<AppEarningsResult, { ok: true }>> = {}): AppEarningsResult {
  return {
    ok: true,
    appListingId: 'apl_1',
    appBlockId: 'ab_1',
    role: 'owner',
    authorFees: FEES,
    goods: GOODS,
    ...over,
  } as AppEarningsResult;
}

/** The card-purchase share's labels. That share is recorded but never paid out. */
const CARD_SHARE_LABELS = ['Pending', 'Confirmed (unpaid)', 'Paid out', 'Voided'];

describe('AppEarningsPanelView', () => {
  test('renders the app’s author fees and goods sales', async () => {
    renderWithProviders(<AppEarningsPanelView data={ok()} />);
    await expect.element(page.getByTestId('apps-earnings-panel')).toBeInTheDocument();
    await expect.element(page.getByTestId('author-fees-pending-buzz')).toHaveTextContent(/^3$/);
    await expect.element(page.getByTestId('author-fees-paid-buzz')).toHaveTextContent(/^12$/);
    await expect.element(page.getByTestId('goods-share-buzz')).toHaveTextContent(/^7$/);
    // One app: no per-app list, and the recent table has no App column.
    expect(page.getByTestId('author-fees-by-app').elements()).toHaveLength(0);
    const header = page.getByTestId('author-fees-recent').getByRole('row').elements()[0];
    expect(header.textContent).toBe('DateFeeBuzz typeStatus');
  });

  test('does NOT render the card-purchase share, even if the payload carries it', async () => {
    const legacy: Record<string, unknown> = {
      ...ok(),
      summary: {
        pending: { count: 2, grossCents: 2468, shareCents: 1234 },
        confirmed: { count: 3, grossCents: 10000, shareCents: 5000 },
        paidOut: { count: 4, grossCents: 19800, shareCents: 9900 },
        voided: { count: 1, grossCents: 250 },
      },
    };
    renderWithProviders(<AppEarningsPanelView data={legacy as AppEarningsResult} />);
    await expect.element(page.getByTestId('apps-earnings-panel')).toBeInTheDocument();
    for (const label of CARD_SHARE_LABELS)
      expect(page.getByText(label, { exact: true }).elements(), label).toHaveLength(0);
    for (const dollars of ['$12.34', '$50.00', '$99.00', '$2.50'])
      expect(page.getByText(dollars).elements(), dollars).toHaveLength(0);
  });

  test('an app with no fees and no sales says so for the APP, not "attributed to you"', async () => {
    const zero = {
      accrued: { count: 0, feeBuzz: 0, byBuzzType: {} },
      settled: { count: 0, feeBuzz: 0, byBuzzType: {} },
      byApp: [],
      recent: [],
      paidWindowDays: 90,
    };
    const noGoods = {
      sales: { ...GOODS.sales, count: 0, grossBuzz: 0, shareBuzz: 0, grossUsdCents: 0 },
      refunded: { count: 0, grossBuzz: 0 },
    };
    renderWithProviders(
      <AppEarningsPanelView data={ok({ role: 'editor', authorFees: zero, goods: noGoods })} />
    );
    await expect
      .element(page.getByTestId('author-fees-empty'))
      .toHaveTextContent(/^No author fees on this app\.$/);
    await expect
      .element(page.getByText('No digital goods sales on this app yet.'))
      .toBeInTheDocument();
    expect(page.getByText(/attributed to you/).elements()).toHaveLength(0);
    // An empty window is not "never earned": the note says which period was read.
    await expect.element(page.getByTestId('author-fees-window')).toHaveTextContent(/^Last 90 days/);
  });

  test('an older API payload without authorFees/goods says could-not-load, never zero', async () => {
    const payload: Record<string, unknown> = { ...ok() };
    delete payload.authorFees;
    delete payload.goods;
    renderWithProviders(<AppEarningsPanelView data={payload as AppEarningsResult} />);
    await expect.element(page.getByTestId('author-fees-unavailable')).toBeInTheDocument();
    await expect.element(page.getByTestId('goods-unavailable')).toBeInTheDocument();
    expect(page.getByTestId('author-fees-empty').elements()).toHaveLength(0);
    expect(page.getByTestId('goods-share-buzz').elements()).toHaveLength(0);
  });

  test('an EDITOR is told the figures are shared with everyone seated on the app', async () => {
    renderWithProviders(<AppEarningsPanelView data={ok({ role: 'editor' })} />);
    await expect
      .element(page.getByTestId('apps-earnings-scope-note'))
      .toHaveTextContent(/shared with everyone seated on it/i);
  });

  test('an OWNER is not told that — the note is role-aware', async () => {
    renderWithProviders(<AppEarningsPanelView data={ok({ role: 'owner' })} />);
    const note = page.getByTestId('apps-earnings-scope-note');
    await expect.element(note).toHaveTextContent(/this app only/i);
    await expect.element(note).not.toHaveTextContent(/shared with everyone/i);
  });

  /**
   * 🔴 EVERY REFUSAL RENDERS ITS OWN SENTENCE, AND NONE RENDERS A ZERO. `getAppEarnings`
   * returns an explicit reason precisely so "you may not see this" stays distinguishable
   * from "this app earned nothing"; rendering a zeroed summary for any of them would put
   * the silent zero back that the service refuses to emit.
   */
  describe('refusals', () => {
    const REASONS = ['notPermitted', 'notFound', 'unsupportedKind'] as const;

    for (const reason of REASONS) {
      test(`\`${reason}\` renders its own message and NO figures`, async () => {
        renderWithProviders(
          <AppEarningsPanelView data={{ ok: false, appListingId: 'apl_1', reason }} />
        );
        const alert = page.getByTestId(`apps-earnings-unavailable-${reason}`);
        await expect.element(alert).toBeInTheDocument();
        await expect.element(alert).toHaveTextContent(earningsUnavailableMessage(reason));
        // The commit proof above makes this absence an observation, not a race.
        expect(page.getByTestId('apps-earnings-panel').elements()).toHaveLength(0);
        expect(page.getByTestId('author-fees-card').elements()).toHaveLength(0);
      });
    }

    test('the three messages are DISTINCT — no branch inherits another’s copy', () => {
      const messages = REASONS.map((r) => earningsUnavailableMessage(r));
      expect(new Set(messages).size).toBe(REASONS.length);
      // …and the standalone one names the actual reason rather than an access
      // refusal. Pinned as the WHOLE string, not a keyword: the store's kind label was
      // realigned on "Standalone" (it read "External apps" here while the store card
      // beside it said "Standalone"), and a keyword guard is exactly what let those
      // two surfaces drift apart in the first place.
      expect(earningsUnavailableMessage('unsupportedKind')).toBe(
        'Standalone apps don\u2019t earn Buzz through Civitai, so there are no earnings to show.'
      );
      expect(earningsUnavailableMessage('notPermitted')).toMatch(/access/i);
    });
  });

  test('a transport error shows the error, never an empty or zeroed panel', async () => {
    renderWithProviders(<AppEarningsPanelView errorMessage="Apps authoring is not enabled" />);
    await expect.element(page.getByTestId('apps-earnings-error')).toBeInTheDocument();
    expect(page.getByTestId('apps-earnings-panel').elements()).toHaveLength(0);
  });

  test('loading shows a spinner, not a zeroed summary', async () => {
    renderWithProviders(
      <div data-testid="earnings-host">
        <AppEarningsPanelView isLoading />
      </div>
    );
    await expect.element(page.getByTestId('earnings-host')).toBeInTheDocument();
    expect(page.getByTestId('apps-earnings-panel').elements()).toHaveLength(0);
  });
});
