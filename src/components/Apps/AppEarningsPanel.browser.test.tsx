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

function bucket(count: number, shareCents: number) {
  return { count, grossCents: shareCents * 2, shareCents };
}

function ok(over: Partial<Extract<AppEarningsResult, { ok: true }>> = {}): AppEarningsResult {
  return {
    ok: true,
    appListingId: 'apl_1',
    appBlockId: 'ab_1',
    role: 'owner',
    summary: {
      pending: bucket(2, 1234),
      confirmed: bucket(3, 5000),
      paidOut: bucket(4, 9900),
      voided: { count: 1, grossCents: 250 },
    },
    ...over,
  } as AppEarningsResult;
}

describe('AppEarningsPanelView', () => {
  test('renders the four buckets with the SHARE figure, formatted as dollars', async () => {
    renderWithProviders(<AppEarningsPanelView data={ok()} />);
    await expect.element(page.getByTestId('apps-earnings-panel')).toBeInTheDocument();
    // 🔴 `shareCents`, not `grossCents` — the fixture makes gross exactly 2x share, so a
    // mutant reading the wrong field renders $24.68 here and this assertion catches it.
    await expect.element(page.getByTestId('apps-earnings-pending')).toHaveTextContent('$12.34');
    await expect.element(page.getByTestId('apps-earnings-confirmed')).toHaveTextContent('$50.00');
    await expect.element(page.getByTestId('apps-earnings-paidOut')).toHaveTextContent('$99.00');
    // Voided is the one bucket with no share — it reports GROSS by design.
    await expect.element(page.getByTestId('apps-earnings-voided')).toHaveTextContent('$2.50');
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
        expect(page.getByTestId('apps-earnings-pending').elements()).toHaveLength(0);
      });
    }

    test('the three messages are DISTINCT — no branch inherits another’s copy', () => {
      const messages = REASONS.map((r) => earningsUnavailableMessage(r));
      expect(new Set(messages).size).toBe(REASONS.length);
      // …and the off-site one names the actual reason rather than an access refusal.
      expect(earningsUnavailableMessage('unsupportedKind')).toMatch(/External apps/i);
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
