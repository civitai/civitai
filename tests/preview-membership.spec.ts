import { expect, test } from '@playwright/test';
import { storageStatePath } from './preview-fixtures';

/**
 * Tier-state tests for the membership surface on a deployed PR preview.
 *
 * Both `gold` (PAID, seeded tier=gold + gold subscription) and `tester` (FREE,
 * no subscription) clear the preview gate, so the distinguishing signal is what
 * /user/membership renders for each — NOT whether they get in.
 *
 * The decisive, deterministic signal lives in src/pages/user/membership.tsx
 * getServerSideProps: a logged-in user with NO subscriptionId, NOT in a bad
 * state, AND no `tier` is server-side-redirected to /pricing. Everyone else
 * stays on the membership page. Per tests/preview-auth.setup.ts, past the gate
 * SSR refreshes token.user from the seeded DB row (getSessionUser) — so
 * `tier`/`subscriptionId` reflect the seeded cnpg-cluster-dev rows:
 *   - gold   -> tier=gold + active subscription -> stays on /user/membership,
 *              renders the "My Membership Plan" current-member view.
 *   - tester -> no tier / no subscription      -> 307 -> /pricing.
 *
 * Assertions key on that SSR redirect + structural member content, not on plan
 * prices or exact marketing copy (this runs against PROD-CLONE data).
 */

const MEMBERSHIP_PATH = '/user/membership';

function assertGatePassed(url: string) {
  expect(url, 'should not be bounced to /login').not.toContain('/login');
  expect(url, 'should not be bounced to /preview-restricted').not.toContain('/preview-restricted');
}

test.describe('membership page — gold (paid, tier=gold)', () => {
  test.use({ storageState: storageStatePath('gold') });

  test('gold stays on /user/membership and sees the current-member view', async ({ page }) => {
    const resp = await page.goto(MEMBERSHIP_PATH, { waitUntil: 'domcontentloaded' });
    expect(resp?.status(), 'HTTP status for /user/membership').toBeLessThan(400);
    assertGatePassed(page.url());

    // A member with a seeded subscription is NOT redirected to /pricing — they
    // land on the membership page itself (getServerSideProps only redirects
    // users with no tier AND no subscription).
    await expect(page).toHaveURL(/\/user\/membership/);

    // The current-member view is titled "My Membership Plan" (membership.tsx
    // <Title>My Membership Plan</Title>), present in BOTH the has-subscription
    // and the no-active-subscription branches. This is the structural marker
    // that the membership view (not a redirect target) rendered.
    await expect(
      page.getByRole('heading', { name: /My Membership Plan/i })
    ).toBeVisible();

    // NOTE: distinguishing active-member affordance. For an active, non-canceled,
    // non-Civitai-provider subscription, membership.tsx renders a
    // CancelMembershipAction button (label "Cancel membership") and/or an
    // "Upgrade" button linking to /pricing. The exact set depends on the seeded
    // subscription's provider/canceled/canUpgrade state, so accept either as the
    // "manage an active membership" signal rather than asserting one specific
    // control. If the seeded gold sub is on the Civitai (prepaid) provider, the
    // Cancel button is suppressed — the "My Membership Plan" heading above is the
    // hard assertion; this manage-control check is best-effort.
    const manageControl = page
      .getByRole('button', { name: /Cancel membership/i })
      .or(page.getByRole('link', { name: /^Upgrade$/i }))
      .or(page.getByRole('button', { name: /Update Payment/i }));
    await expect(manageControl.first()).toBeVisible();
  });
});

test.describe('membership page — tester (free, no subscription)', () => {
  test.use({ storageState: storageStatePath('tester') });

  test('free user is server-side-redirected from /user/membership to /pricing', async ({
    page,
  }) => {
    const resp = await page.goto(MEMBERSHIP_PATH, { waitUntil: 'domcontentloaded' });
    expect(resp?.status(), 'HTTP status after membership redirect').toBeLessThan(400);
    assertGatePassed(page.url());

    // No tier + no subscription => getServerSideProps 307s to /pricing. This is
    // the deterministic free-vs-paid distinguishing behavior (not copy-based).
    await expect(page).toHaveURL(/\/pricing/);
  });

  test('free user sees a subscribe / upgrade CTA on /pricing', async ({ page }) => {
    const resp = await page.goto('/pricing', { waitUntil: 'domcontentloaded' });
    expect(resp?.status(), 'HTTP status for /pricing').toBeLessThan(400);
    assertGatePassed(page.url());

    // A non-member's pricing view offers a way to acquire a membership. The
    // primary plan-card CTA for a non-subscriber is "Subscribe to <tier>"
    // (PlanCard.tsx). On a yellow-default preview the page may instead render
    // YellowMembershipUnavailable / a buzz-type selector with a "Buy"/top-up
    // path, so accept any subscribe/buy/get-membership affordance — the point is
    // an UPGRADE CTA exists and NO active-membership "Manage"/"Cancel" control.
    // NOTE: /pricing rendering branches on Flipt flags (features.isGreen, default
    // buzzType) — this CTA selector is the most uncertain part of this spec and
    // is the prime candidate to tighten after a real preview run.
    const upgradeCta = page
      .getByRole('button', { name: /Subscribe|Buy Buzz|Get Buzz|Buy a membership/i })
      .or(page.getByRole('link', { name: /Subscribe|Buy Buzz|Visit civitai\.red/i }))
      .or(page.getByText(/Memberships/i));
    await expect(upgradeCta.first()).toBeVisible();

    // A free user must NOT see the active-member "Cancel membership" control here.
    await expect(page.getByRole('button', { name: /Cancel membership/i })).toHaveCount(0);
  });
});
