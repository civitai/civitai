import { expect, test } from '@playwright/test';
import { storageStatePath } from './preview-fixtures';

/**
 * Buzz purchase + membership pricing entry-point tests for a deployed PR preview.
 *
 * Runs as the `gold` fixture (a gate-passing PAID member with Buzz) so we exercise
 * the real, prod-clone-backed purchase/pricing surfaces rather than the gate
 * redirect. We assert STRUCTURE only — the page loads behind the gate, shows
 * package/plan choices, and exposes a reachable purchase/checkout affordance — and
 * deliberately never transact (no click into a live Stripe/Paddle/crypto form).
 *
 * Both surfaces branch on the runtime "buzz type" (green vs. yellow domain) and on
 * feature flags, so the assertions below are written to tolerate EITHER branch:
 *   - /purchase/buzz renders <BuzzPurchaseLayout>, which is either the package grid
 *     (<BuzzPurchaseImproved>, green) OR the crypto-deposit tab + card upsell
 *     (yellow). The sidebar <BuzzFeatures> with the fixed title "What can you do
 *     with Buzz?" renders in BOTH branches, so it's the stable page-loaded anchor.
 *   - /pricing renders <MembershipPageWrapper>, whose <Meta> title is always
 *     "Memberships | Civitai", with either the <MembershipPlans> cards (green) or
 *     the YellowMembershipUnavailable cards (yellow) inside.
 *
 * Only runs under playwright.preview.config.ts (needs PREVIEW_URL + minted states).
 */

const ROLE = 'gold' as const;

// Assert we cleared the preview gate (not bounced to /login or /preview-restricted)
// and got a real (<400) response — mirrors preview-smoke.spec.ts.
function assertGatePassed(page: import('@playwright/test').Page, path: string) {
  expect(page.url(), `${path}: should not redirect to /login`).not.toContain('/login');
  expect(page.url(), `${path}: should not redirect to /preview-restricted`).not.toContain(
    '/preview-restricted'
  );
}

test.describe('buzz purchase + pricing entry (gold)', () => {
  test.use({ storageState: storageStatePath(ROLE) });

  test('/purchase/buzz renders package/purchase options and a checkout affordance', async ({
    page,
  }) => {
    const resp = await page.goto('/purchase/buzz', { waitUntil: 'domcontentloaded' });
    expect(resp?.status(), 'HTTP status for /purchase/buzz').toBeLessThan(400);
    assertGatePassed(page, '/purchase/buzz');

    // Page-loaded anchor present in BOTH purchase branches: the BuzzFeatures
    // sidebar is rendered by BuzzPurchaseLayout with this exact, hard-coded title.
    // NOTE: matched on the literal "What can you do with Buzz?" passed in
    // BuzzPurchaseLayout.tsx. If the heading copy changes, the per-branch
    // anchors below (Choose Your Package / Pay with a card / deposit) still gate.
    await expect(
      page.getByText('What can you do with Buzz?', { exact: false }).first()
    ).toBeVisible({ timeout: 30_000 });

    // A reachable purchase/checkout affordance exists. We don't assert WHICH
    // branch rendered (green package grid vs. yellow crypto + card upsell), only
    // that at least one known purchase control/CTA is on the page. Matched
    // controls, by branch:
    //   green  -> "Choose Your Package" heading + "Complete Purchase" / "Pay with Card"
    //   yellow -> NoCryptoUpsell "Prefer to pay with a card?" + "Buy Green Buzz",
    //             plus the crypto DepositAddressCard.
    // NOTE: this is a broad OR over stable copy strings rather than a CSS/testid
    // selector (none exists on these controls yet). If a preview run shows a
    // different label, widen this regex — the structural intent is "some
    // purchase/checkout entry is present".
    const purchaseAffordance = page
      .getByText(
        /Choose Your Package|Complete Purchase|Pay with Card|Prefer to pay with a card|Buy Green Buzz|Custom Amount|deposit/i
      )
      .first();
    await expect(purchaseAffordance).toBeVisible({ timeout: 30_000 });
  });

  test('/pricing renders membership plan options', async ({ page }) => {
    const resp = await page.goto('/pricing', { waitUntil: 'domcontentloaded' });
    expect(resp?.status(), 'HTTP status for /pricing').toBeLessThan(400);
    assertGatePassed(page, '/pricing');

    // Always-present anchor: MembershipPageWrapper renders <Meta title=
    // "Memberships | Civitai"> regardless of branch (green plans vs. yellow
    // "memberships unavailable" view). The document <title> is the most stable
    // signal that the membership page (not an error/redirect) rendered.
    // NOTE: a title check is resilient to the body branching; the body-text
    // assertion below is the structural "plan options present" check.
    await expect(page).toHaveTitle(/Memberships/i, { timeout: 30_000 });

    // At least one membership plan option / CTA is present. Matched copy by branch:
    //   green  -> <MembershipPlans> cards; tiers + "Memberships" heading.
    //   yellow -> YellowMembershipUnavailable: "Green Membership" / "Purchase Buzz"
    //             cards with "View Green Memberships" / "Go to Buzz Purchase" CTAs.
    // NOTE: broad OR over stable plan-related copy; widen if a preview shows
    // different tier labels. Asserts structure (a plan choice exists), never a
    // specific price/count.
    const planOption = page
      .getByText(
        /Membership|Memberships|View Green Memberships|Go to Buzz Purchase|Supporter|Bronze|Silver|Gold/i
      )
      .first();
    await expect(planOption).toBeVisible({ timeout: 30_000 });
  });

  test('/purchase/buzz and /pricing both stay behind the gate (no bounce)', async ({ page }) => {
    // Focused regression for the gate contract on these two paid surfaces:
    // a paid member must NOT be redirected to /login or /preview-restricted, and
    // both must return a real (<400) response. Kept separate from the rich-content
    // assertions above so a copy/selector drift can't mask a gate/redirect break.
    for (const path of ['/purchase/buzz', '/pricing']) {
      const resp = await page.goto(path, { waitUntil: 'domcontentloaded' });
      expect(resp?.status(), `HTTP status for ${path}`).toBeLessThan(400);
      assertGatePassed(page, path);
    }
  });
});
