import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';
import {
  ChallengeReviewCostType,
  ChallengeSource,
  ChallengeStatus,
  PoolTrigger,
  PrizeMode,
} from '~/shared/utils/prisma/enums';

/**
 * D6-seed — mod "Customize judging categories" toggle. `ChallengeUpsertForm.judging-categories
 * .test.ts` unit-tests the pure helpers (initial toggle state, submit-payload decision) but does
 * NOT exercise the interactive seed-on-toggle-on mechanism in `handleCustomizeCategoriesChange`
 * (ChallengeUpsertForm.tsx) — the actual thing that prevents the broken empty-`[]` editor state
 * (CategoryWeights requires an always-present locked Theme row). This is a real-browser render
 * test of that mechanism: toggle OFF hides the editor; toggling ON seeds `DEFAULT_CATEGORY_ROWS`
 * (asserted via the locked Theme row's weight contributing to a 100% total, not an empty editor).
 */

// Only the `trpc` client itself is overridden — the rest of `~/utils/trpc`'s real exports
// (setTrpcBatchingEnabled, trpcVanilla, queryClient, ...) are kept via importOriginal so any
// transitively-imported consumer elsewhere in the tree (e.g. session/provider chains) still
// gets a real binding instead of the whack-a-mole of hand-naming every export they touch.
vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/utils/trpc')>();
  const noopQuery = () => ({ data: undefined, isLoading: false });
  const noopMutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    ...actual,
    trpc: {
      useUtils: () => ({
        challenge: {
          getModeratorList: { invalidate: vi.fn() },
          getById: { invalidate: vi.fn() },
          getInfinite: { invalidate: vi.fn() },
        },
      }),
      challenge: {
        getJudges: { useQuery: () => ({ data: [], isLoading: false }) },
        // undefined data → CategoryWeights falls back to the preset constants
        getJudgingCategories: { useQuery: noopQuery },
        getEvents: { useQuery: () => ({ data: [], isLoading: false }) },
        upsert: { useMutation: noopMutation },
        upsertUserChallenge: { useMutation: noopMutation },
      },
      modelVersion: {
        getVersionsByIds: { useQuery: noopQuery },
      },
    },
  };
});

vi.mock('~/hooks/useCFImageUpload', () => ({
  useCFImageUpload: () => ({ uploadToCF: vi.fn(), files: [], resetFiles: vi.fn(), removeImage: vi.fn() }),
}));

// The cover-image preview pulls in EdgeMedia -> BrowserSettingsProvider -> session/env machinery
// unrelated to the judging-categories toggle under test — stub to a plain img (same pattern as
// PostingToModel3DCard.browser.test.tsx).
vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({
  EdgeMedia: ({ src }: { src?: string }) => <img src={src} alt="" />,
}));

vi.mock('~/utils/notifications', () => ({
  showSuccessNotification: vi.fn(),
  showErrorNotification: vi.fn(),
}));

const { ChallengeUpsertForm } = await import('../ChallengeUpsertForm');

// A mod editing an EXISTING challenge with no categories yet (`judgingCategories` is `undefined` —
// as `getById` returns for a challenge that predates custom categories, or never had them set).
// This is the one case where the initial toggle is OFF (see resolveInitialCustomizeCategories):
// a brand-new mod challenge or the user variant both start ON, so neither exercises the seed path.
const existingChallengeNoCategories = {
  id: 1,
  title: 'Neon Dreams',
  description: 'A challenge about neon dreams',
  theme: 'Neon Dreams',
  invitation: null,
  coverImage: { id: 1, url: 'https://cdn.example.com/cover.png' },
  modelVersionIds: [],
  nsfwLevel: 1,
  allowedNsfwLevel: 1,
  judgeId: 1,
  eventId: null,
  judgingPrompt: null,
  reviewPercentage: 100,
  maxEntriesPerUser: 20,
  entryPrizeRequirement: 10,
  prizePool: 5000,
  operationBudget: 0,
  reviewCostType: ChallengeReviewCostType.None,
  reviewCost: 0,
  startsAt: new Date('2026-01-01T00:00:00Z'),
  endsAt: new Date('2026-01-02T00:00:00Z'),
  visibleAt: new Date('2026-01-01T00:00:00Z'),
  status: ChallengeStatus.Scheduled,
  source: ChallengeSource.Mod,
  prizes: [],
  entryPrize: null,
  prizeMode: PrizeMode.Fixed,
  basePrizePool: 2500,
  buzzPerAction: 1,
  poolTrigger: PoolTrigger.Entry,
  maxPrizePool: null,
  prizeDistribution: null,
  themeElements: null,
  judgingCategories: undefined,
};

describe('ChallengeUpsertForm — mod judging-categories toggle', () => {
  test('starts OFF (default-rubric note shown, no CategoryWeights editor) for an existing null-category challenge', async () => {
    renderWithProviders(
      <ChallengeUpsertForm challenge={existingChallengeNoCategories} variant="moderator" />
    );

    await expect
      .element(page.getByText(/judged against the default rubric/i))
      .toBeInTheDocument();
    expect(page.getByText(/Total weight/).elements()).toHaveLength(0);
  });

  test('switching ON seeds DEFAULT_CATEGORY_ROWS (not an empty editor)', async () => {
    // Widen the default (narrow, mobile-sized) test viewport so the row Group (wrap="nowrap")
    // and card footer lay out the same as a real desktop viewport for the Task 3 screenshot below.
    await page.viewport(1000, 900);

    renderWithProviders(
      <ChallengeUpsertForm challenge={existingChallengeNoCategories} variant="moderator" />
    );

    await page.getByRole('switch', { name: /Customize judging categories/i }).click();

    // The default-rubric note is replaced by the live CategoryWeights editor.
    expect(page.getByText(/judged against the default rubric/i).elements()).toHaveLength(0);

    // DEFAULT_CATEGORY_ROWS sums to exactly 100 (theme 50 / wittiness 15 / humor 15 / aesthetic 20).
    // The footer splits the old "Total weight: X%" string into a label + a separate Badge — an
    // empty-seed regression would render 0 rows and a "0%" badge instead of "100%".
    await expect.element(page.getByText('Total weight')).toBeInTheDocument();
    // `exact: true` — the mod form's (visually-hidden but still-mounted) Dynamic-pool prize-split
    // line also contains the substring "100%", so a substring match here would be ambiguous.
    await expect.element(page.getByText('100%', { exact: true })).toBeInTheDocument();

    // The locked Theme row is present (non-removable) plus 3 removable rows — 3 "Remove category"
    // buttons confirms 4 total rows, matching DEFAULT_CATEGORY_ROWS, not a single empty/blank row.
    expect(page.getByRole('button', { name: 'Remove category' }).elements()).toHaveLength(3);
    await expect
      .element(page.getByText(/How well the entry fits and interprets the challenge theme/))
      .toBeInTheDocument();
  });

  test('switching back OFF hides the editor again', async () => {
    renderWithProviders(
      <ChallengeUpsertForm challenge={existingChallengeNoCategories} variant="moderator" />
    );

    const toggle = page.getByRole('switch', { name: /Customize judging categories/i });
    await toggle.click();
    await expect.element(page.getByText('Total weight')).toBeInTheDocument();

    await toggle.click();
    await expect
      .element(page.getByText(/judged against the default rubric/i))
      .toBeInTheDocument();
    expect(page.getByText(/Total weight/).elements()).toHaveLength(0);
  });

  // Regression test for the bug CategoryWeights.tsx's fix addresses: the Category select used to
  // be BOTH name-bound (RHF writes `.key`) AND carry an onChange that called
  // `update(index, {...makeRow(key), weight})`. The two writes raced, so picking a new category
  // could desync the shown criteria from the selected key and/or reset that row's weight to 0.
  // Now the select is solely name-bound, criteria is derived at render from `row.key` (never
  // stored), and weight has its own untouched name-bound field.
  test("changing a non-theme row's category swaps its criteria and preserves its weight", async () => {
    renderWithProviders(
      <ChallengeUpsertForm challenge={existingChallengeNoCategories} variant="moderator" />
    );

    await page.getByRole('switch', { name: /Customize judging categories/i }).click();
    await expect.element(page.getByText('Total weight')).toBeInTheDocument();

    // Rows render in DEFAULT_CATEGORY_ROWS order: theme(0), wittiness(1), humor(2), aesthetic(3).
    const categoryInputs = page.getByLabelText('Category');
    const weightInputs = page.getByLabelText('Weight %');

    await expect.element(weightInputs.nth(1)).toHaveValue('15');
    await expect
      .element(page.getByText(/Cleverness and conceptual wit of the idea/))
      .toBeInTheDocument();

    await categoryInputs.nth(1).click();
    await page.getByRole('option', { name: 'Creativity' }).click();

    // Criteria swaps to the newly selected category's text...
    await expect
      .element(page.getByText(/Originality and inventiveness of the concept; higher for fresh/))
      .toBeInTheDocument();
    // ...and the old Wittiness criteria is gone (no stale/desynced label+criteria pairing).
    expect(page.getByText(/Cleverness and conceptual wit of the idea/).elements()).toHaveLength(0);

    // The bug this guards against: the category change must not reset this row's weight to 0.
    await expect.element(weightInputs.nth(1)).toHaveValue('15');
  });
});
