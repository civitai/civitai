import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * App Blocks — AGENTIC MOD CODE-REVIEW report renderer: deep-link-to-a-finding
 * (Phase 2.3 fast-follow) — browser-mode component tests.
 *
 * `ReportTabs` is prop-only + router-agnostic: it reads/writes the URL hash
 * directly (never next/router). Deep-linking is GATED on the route — active only
 * on the dedicated review page (`/apps/review/<id>`), inert in the review modal
 * (`/apps/review`). When active, a deep link `#finding-<tab>-<index>` opens the
 * right tab, scrolls the target card into view with a transient highlight, and
 * each finding card carries a subtle "copy link" affordance.
 *
 * Covers:
 *  - on the page route, landing on `#finding-security-1` activates the Security
 *    audit tab, the card carries `id="finding-security-1"`, `scrollIntoView`
 *    fires (deterministic post-commit scroll), and a copy-link renders;
 *  - a bare tab hash (`#code`) activates that tab with no finding target;
 *  - on the modal route there is NO deep-linking (no copy-link, no anchor id).
 *
 * The Summary tab renders `summaryMd` through CustomMarkdown, which reads
 * `useCurrentUser()`. We keep `summaryMd` null here so that surface is never hit,
 * and boundary-stub the hook anyway (null user is fine — the standard pattern in
 * the sibling AgentReview tests).
 */

vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => null,
}));

const { ReportTabs } = await import('./ReportTabs');

// The dedicated review PAGE route enables deep-linking (`/apps/review/<id>`).
const PAGE_PATH = '/apps/review/pubreq_test';

// Two security findings in severity order (critical, then high) → the second
// card (index 1) is the `high` one, so `#finding-security-1` targets it.
const REPORT = {
  status: 'complete',
  summaryMd: null,
  codeReview: {
    findings: [{ severity: 'medium', title: 'A code finding', detail: 'code detail' }],
  },
  securityAudit: {
    findings: [
      { severity: 'critical', title: 'Critical sec finding', detail: 'sandbox escape' },
      { severity: 'high', title: 'High sec finding', detail: 'broad host' },
    ],
  },
  scopeVerdicts: {},
};

beforeEach(() => {
  // Land on the PAGE route + deep link BEFORE render so the mount-time route
  // resolution enables deep-linking and the hash sync reads the anchor.
  window.history.replaceState(null, '', `${PAGE_PATH}#finding-security-1`);
});

afterEach(() => {
  vi.restoreAllMocks();
  // Reset to a neutral URL so neither the path nor the hash leaks to the next test.
  window.history.replaceState(null, '', '/');
});

describe('ReportTabs — deep-link to a finding (page route)', () => {
  test('landing on #finding-security-1 activates the Security audit tab', async () => {
    renderWithProviders(<ReportTabs report={REPORT} costCapped={false} />);

    // The Security audit tab is selected (not the default Summary).
    await expect
      .element(page.getByRole('tab', { name: /Security audit/ }))
      .toHaveAttribute('aria-selected', 'true');
    await expect
      .element(page.getByRole('tab', { name: /Summary/ }))
      .toHaveAttribute('aria-selected', 'false');

    // The targeted finding is visible in the now-active tab.
    await expect.element(page.getByText('High sec finding')).toBeVisible();
  });

  test('the target finding card carries id="finding-security-1"', async () => {
    renderWithProviders(<ReportTabs report={REPORT} costCapped={false} />);

    await expect.element(page.getByText('High sec finding')).toBeVisible();
    const el = document.getElementById('finding-security-1');
    expect(el).not.toBeNull();
    // It is a finding card (carries the finding-card testid).
    expect(el?.getAttribute('data-testid')).toBe('finding-card');
    // And it renders the `high` finding (index 1 of the severity-sorted list).
    expect(el?.textContent).toContain('High sec finding');
    // The index-0 card exists too and is the `critical` finding.
    const first = document.getElementById('finding-security-0');
    expect(first?.textContent).toContain('Critical sec finding');
  });

  test('scrollIntoView fires on the target card AFTER its tab commits', async () => {
    // Covers the deterministic post-commit scroll: the scroll runs in an effect
    // keyed on the active tab, so it can't fire against a still-hidden panel.
    const spy = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    renderWithProviders(<ReportTabs report={REPORT} costCapped={false} />);

    await expect.element(page.getByText('High sec finding')).toBeVisible();
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());

    // At least one call's target was the deep-linked card.
    const target = document.getElementById('finding-security-1');
    expect(spy.mock.contexts).toContain(target);
  });

  test('each finding card renders a copy-link ActionIcon', async () => {
    renderWithProviders(<ReportTabs report={REPORT} costCapped={false} />);

    await expect.element(page.getByText('High sec finding')).toBeVisible();
    // The two security cards each expose a copy-link affordance (keepMounted, so
    // the code tab's card counts too — assert at least the security ones exist).
    const copyLinks = page.getByTestId('finding-copy-link').elements();
    expect(copyLinks.length).toBeGreaterThanOrEqual(2);
  });

  test('a bare tab hash (#code) activates that tab without a finding target', async () => {
    // Keep the page path (relative hash-only update), switch the hash to #code.
    window.history.replaceState(null, '', `${PAGE_PATH}#code`);
    renderWithProviders(<ReportTabs report={REPORT} costCapped={false} />);

    await expect
      .element(page.getByRole('tab', { name: /Code review/ }))
      .toHaveAttribute('aria-selected', 'true');
    await expect.element(page.getByText('A code finding')).toBeVisible();
  });
});

describe('ReportTabs — modal route (deep-linking inert)', () => {
  test('on /apps/review the hash is ignored: no copy-link, no anchor ids, Summary stays active', async () => {
    // The modal lives at exactly /apps/review (no trailing id) → deep-linking off.
    window.history.replaceState(null, '', '/apps/review#finding-security-1');
    renderWithProviders(<ReportTabs report={REPORT} costCapped={false} />);

    // Default Summary tab stays active — the finding hash is NOT honored.
    await expect
      .element(page.getByRole('tab', { name: /Summary/ }))
      .toHaveAttribute('aria-selected', 'true');

    // No copy-link affordances and no per-finding anchor id anywhere (pre-feature
    // behavior), so a copy-link can't produce a URL that reopens nothing.
    expect(page.getByTestId('finding-copy-link').elements().length).toBe(0);
    expect(document.getElementById('finding-security-1')).toBeNull();
    expect(document.getElementById('finding-security-0')).toBeNull();
  });
});
