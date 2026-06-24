import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * AuthorAffordance — git-provisioning SIDE-EFFECT GATING guard.
 *
 * `blocks.getMyAppRepo` is NOT a pure read: the router lazily provisions a scoped
 * Forgejo identity + grants the caller push on their repo as a side effect (see
 * AuthorViaGit's doc + blocks.router.ts). The safety guarantee is therefore that
 * it must be USER-INITIATED — it must never auto-provision on page/mount, only
 * after the user deliberately opts in.
 *
 * That gating is implemented purely by MOUNT (`{showGit && <AuthorViaGit>}` →
 * `{expanded && <GitAccessPanel>}`), and GitAccessPanel is the ONLY caller of
 * `getMyAppRepo.useQuery`. So spying on `getMyAppRepo.useQuery` (which only runs
 * when its component renders) is the smallest faithful seam for the side effect:
 * a call == the panel mounted == provisioning would fire.
 *
 * Unlike MySubmissionsList.browser.test.tsx (which stubs AuthorViaGit to a
 * marker), this test mounts the REAL AuthorAffordance + AuthorViaGit + the real
 * mount-gating, so a future regression that swaps the conditional mount for a
 * Mantine <Collapse> (which keeps children MOUNTED while collapsed → useQuery
 * fires immediately) would flip the on-mount/after-first-toggle call count from
 * 0 to 1 and fail here.
 */

const mocks = vi.hoisted(() => ({
  // Spy standing in for blocks.getMyAppRepo.useQuery. Call count == "the
  // side-effecting query ran" (i.e. GitAccessPanel mounted). Returns a benign
  // "not yet available" result so the panel renders without a token/network.
  getMyAppRepo: vi.fn((..._args: unknown[]) => ({
    data: { notYetAvailable: true, slug: 'my-app', firstVersionIsZip: true, message: '' },
    isLoading: false,
    isError: false,
    error: null,
  })),
}));

vi.mock('~/utils/trpc', () => ({
  trpc: {
    blocks: {
      getMyAppRepo: { useQuery: (...args: unknown[]) => mocks.getMyAppRepo(...args) },
    },
  },
}));

const { AuthorAffordance } = await import('./MySubmissionsList');

beforeEach(() => {
  mocks.getMyAppRepo.mockClear();
});

describe('AuthorAffordance git-provisioning gating', () => {
  test('getMyAppRepo is NOT called on mount, NOT after expanding "Advanced", and ONLY after the inner "Author via git" toggle (two clicks)', async () => {
    renderWithProviders(<AuthorAffordance appBlockId="block-guard" />);

    // (1) On mount: the CLI guidance shows, but the side-effecting query has NOT
    // run — git provisioning must be user-initiated.
    await expect.element(page.getByRole('link', { name: /civitai.*CLI/i })).toBeInTheDocument();
    expect(mocks.getMyAppRepo).toHaveBeenCalledTimes(0);

    // (2) First click — expand the "Advanced: author via git" footnote. This
    // mounts AuthorViaGit (its "Author via git" button), but GitAccessPanel is
    // still NOT mounted, so getMyAppRepo STILL hasn't fired.
    const advanced = page.getByRole('button', { name: /advanced.*git/i });
    await advanced.click();
    const innerToggle = page.getByRole('button', { name: /^author via git$/i });
    await expect.element(innerToggle).toBeInTheDocument();
    expect(mocks.getMyAppRepo).toHaveBeenCalledTimes(0);

    // (3) Second click — the inner "Author via git" toggle mounts GitAccessPanel,
    // which is the ONLY thing that runs getMyAppRepo. NOW (and only now) it fires.
    await innerToggle.click();
    await vi.waitFor(() => {
      expect(mocks.getMyAppRepo).toHaveBeenCalled();
    });
    // It was scoped to the right app block.
    expect(mocks.getMyAppRepo).toHaveBeenCalledWith({ appBlockId: 'block-guard' }, expect.anything());
  });

  test('collapsing the inner toggle unmounts the panel (provisioning does not run again on re-expand without intent)', async () => {
    renderWithProviders(<AuthorAffordance appBlockId="block-guard2" />);
    await page.getByRole('button', { name: /advanced.*git/i }).click();
    const innerToggle = page.getByRole('button', { name: /^author via git$/i });

    // Expand → panel mounts → query fires once.
    await innerToggle.click();
    await vi.waitFor(() => expect(mocks.getMyAppRepo).toHaveBeenCalled());

    // Collapse — the toggle now reads "Hide git access"; the panel is unmounted.
    const hide = page.getByRole('button', { name: /hide git access/i });
    await expect.element(hide).toBeInTheDocument();
    expect(page.getByRole('button', { name: /^author via git$/i }).elements()).toHaveLength(0);
  });
});
