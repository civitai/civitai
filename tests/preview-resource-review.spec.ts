import { expect, test } from '@playwright/test';
import { storageStatePath } from './preview-fixtures';
import { trpcMutation, trpcQuery, uniqueToken } from './preview-trpc';

/**
 * Mutation smoke: the resource-review write path (resourceReview.upsert) — rating a
 * model is a top engagement action, otherwise untested.
 *
 * Isolation: a review row is keyed by (userId, modelVersionId). We can't self-seed
 * a model, so we review a REAL public model version — but we pick a RANDOM one from
 * a page of the public API each run, so concurrent previews almost never touch the
 * same (tester, version) row (a FIXED target — e.g. a follow edge — would collide;
 * a random one effectively isolates). We use `upsert` (idempotent: creates or
 * updates the tester's review for that version, so a leftover row from a prior run
 * doesn't break it) and DELETE our review at the end. The read-back asserts only
 * that a review EXISTS for tester→version (tolerant of a concurrent run overwriting
 * the row's contents), so it can't flake on a same-version race.
 *
 * Runs as `tester` (free member that PASSES the preview gate). resourceReview.upsert
 * is a guardedProcedure (onboarding-complete + not muted — ci-smoke `tester` is
 * seeded onboarding=15). getUserResourceReview / delete are protectedProcedures.
 *
 * Verified shapes (civitai repo, paths relative to civitai/src):
 *  - /api/v1/models  public REST; items[] each have `id` (modelId) + `modelVersions`
 *    [{ id }] (verified against the live API — model 257749 → version 290640).
 *  - resourceReview.upsert  guarded; input upsertResourceReviewSchema
 *    (resourceReview.schema.ts:55): { modelId, modelVersionId, rating: number,
 *    recommended: boolean, details? } all required except id/details.
 *    upsertResourceReviewHandler → upsertResourceReview returns the review incl. `.id`.
 *  - resourceReview.getUserResourceReview  protected; input { modelId?, modelVersionId? }
 *    (resourceReview.schema.ts:27); returns an ARRAY of the caller's reviews for the
 *    version (verified live: [{ id, modelVersionId, ... }]), not a single object —
 *    we read element [0]. Used both to make the upsert idempotent and to read back.
 *  - resourceReview.delete  protected; input getByIdSchema ({ id }); owner cleanup.
 */

const ROLE = 'tester' as const;
const MODELS_PAGE = 20;

test.describe('tester reviews a model (mutation flow)', () => {
  test.use({ storageState: storageStatePath(ROLE) });

  test('resourceReview.upsert on a random public model version, verified by read-back', async ({
    page,
  }) => {
    // Warm the request context against the preview origin (auth cookie + a real
    // navigated origin). domcontentloaded only: NEVER networkidle.
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // 1. Resolve a RANDOM public model version (the isolation key — different runs
    // pick different versions, so concurrent previews don't collide on one row).
    const res = await page.request.get(`/api/v1/models?limit=${MODELS_PAGE}&nsfw=false`);
    expect(res.ok(), `/api/v1/models returned HTTP ${res.status()}`).toBeTruthy();
    const body = (await res.json()) as {
      items?: Array<{ id: number; modelVersions?: Array<{ id: number }> }>;
    };
    const candidates = (body.items ?? []).filter((m) => typeof m?.modelVersions?.[0]?.id === 'number');
    expect(candidates.length, 'public API should yield a model with a version to review').toBeGreaterThan(
      0
    );
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    const modelId = pick.id;
    const modelVersionId = pick.modelVersions![0].id;

    // 2. Make the write idempotent: a review is unique per (userId, modelVersionId),
    // and upsert WITHOUT an id always takes the create path (which throws a CONFLICT
    // on a leftover/concurrent row). So look up any existing tester review for this
    // version first and pass its id (→ update path) when present; otherwise create.
    // NOTE: getUserResourceReview returns an ARRAY of the caller's reviews for the
    // version (verified live: [{ id, modelVersionId, ... }]), NOT a single object.
    const existing = await trpcQuery<Array<{ id?: number }>>(
      page.request,
      'resourceReview.getUserResourceReview',
      { modelVersionId }
    );
    const existingId = existing?.[0]?.id;
    const review = await trpcMutation<{ id: number } | null>(page.request, 'resourceReview.upsert', {
      ...(typeof existingId === 'number' ? { id: existingId } : {}),
      modelId,
      modelVersionId,
      rating: 5, // a consistent positive review (recommended:true)
      recommended: true,
      details: uniqueToken('review'), // plain token (no links) — clears throwOnBlockedLinkDomain
    });
    expect(typeof review?.id, 'resourceReview.upsert should return a numeric review id').toBe('number');

    // 3. DETERMINISTIC read-back: the tester now has a review for this version.
    // getUserResourceReview returns an ARRAY — assert at least one entry has a numeric
    // id (a review EXISTS), NOT its exact contents, so a concurrent run reviewing the
    // same version can't flake this.
    const mine = await trpcQuery<Array<{ id?: number }>>(
      page.request,
      'resourceReview.getUserResourceReview',
      { modelVersionId }
    );
    expect(typeof mine?.[0]?.id, 'getUserResourceReview should return the tester review').toBe(
      'number'
    );

    // 4. Best-effort cleanup: delete our review so it doesn't pollute the model's
    // aggregates on the shared dev clone. Non-fatal — the assertions above are the point.
    try {
      await trpcMutation(page.request, 'resourceReview.delete', { id: review!.id });
    } catch {
      // create + read-back already passed; leftover-review cleanup is non-critical.
    }
  });
});
