import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * App Blocks — AGENTIC MOD CODE-REVIEW report renderer: deep-link-to-a-finding
 * (Phase 2.3 fast-follow) — browser-mode component tests.
 *
 * `ReportTabs` is prop-only + router-agnostic: it reads/writes the URL hash
 * directly (never next/router) so a deep link `#finding-<tab>-<index>` opens the
 * right tab, scrolls the target card into view with a transient highlight, and
 * each finding card carries a subtle "copy link" affordance.
 *
 * Covers:
 *  - landing on `#finding-security-1` activates the Security audit tab;
 *  - the target finding card carries `id="finding-security-1"`;
 *  - each finding card renders a "copy link" ActionIcon.
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
  // Land on the deep link BEFORE render so the mount-time hash sync reads it.
  window.history.replaceState(null, '', '#finding-security-1');
});

afterEach(() => {
  // Clear the hash so it never leaks into the next test.
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
});

describe('ReportTabs — deep-link to a finding', () => {
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

  test('each finding card renders a copy-link ActionIcon', async () => {
    renderWithProviders(<ReportTabs report={REPORT} costCapped={false} />);

    await expect.element(page.getByText('High sec finding')).toBeVisible();
    // The two security cards each expose a copy-link affordance (keepMounted, so
    // the code tab's card counts too — assert at least the security ones exist).
    const copyLinks = page.getByTestId('finding-copy-link').elements();
    expect(copyLinks.length).toBeGreaterThanOrEqual(2);
  });

  test('a bare tab hash (#code) activates that tab without a finding target', async () => {
    window.history.replaceState(null, '', '#code');
    renderWithProviders(<ReportTabs report={REPORT} costCapped={false} />);

    await expect
      .element(page.getByRole('tab', { name: /Code review/ }))
      .toHaveAttribute('aria-selected', 'true');
    await expect.element(page.getByText('A code finding')).toBeVisible();
  });
});
