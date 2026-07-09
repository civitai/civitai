import { expect, test } from '@playwright/test';
import { storageStatePath } from './preview-fixtures';
import { trpcMutation, trpcQuery, uniqueToken } from './preview-trpc';

/**
 * Mutation smoke: the collections write path — create a collection and save an
 * item into it. Collections are a common engagement surface ("save to
 * collection" on every model/image/post) and were untested by the suite.
 *
 * Fully API-driven + per-run self-seeded (same pattern as preview-engagement /
 * preview-report): the tester creates its OWN collection and its OWN post, then
 * saves the post into the collection — no dependency on shared content, no
 * collision on the dev clone across concurrent previews.
 *
 * Runs as `tester` (free member that PASSES the preview gate). All three
 * procedures are reachable for a gate-passing user:
 *  - collection.upsert is a guardedProcedure (onboarding-complete + not muted;
 *    the ci-smoke `tester` is seeded with onboarding=15, so it clears it).
 *  - collection.saveItem / getUserCollectionItemsByItem are protectedProcedures
 *    gated by isFlagProtected('collections'); the `collections` feature flag is
 *    `['public']` (feature-flags.service.ts) — available to every logged-in user,
 *    so the fixtures pass.
 *
 * Verified tRPC shapes (civitai repo, paths relative to civitai/src):
 *  - collection.upsert  input upsertCollectionInput (collection.schema.ts:167):
 *    `name` is required (z.string().max(30).nonempty()), `type` defaults to Model.
 *    We pass type:'Post' so the collection accepts a post item. upsertCollectionHandler
 *    (collection.controller.ts:325) returns `{ ...collection, isOwner }`, so `.id`
 *    is the new collection's numeric id. NOTE: name max length is 30 — we use a
 *    short `e2e-coll-<rand>` name (the full uniqueToken is ~31 chars and would fail
 *    zod); isolation comes from the seeded POST's token + the returned collection id,
 *    not the collection name.
 *  - post.create        guarded; returns the post incl. numeric `.id` (see
 *    preview-engagement.spec.ts).
 *  - collection.saveItem  input saveCollectionItemInputSchema (collection.schema.ts:35)
 *    = collectionItemSchema ({ type, articleId/postId/modelId/imageId, note }) extended
 *    with `collections: [{ collectionId, ... }]`. We pass
 *    { type:'Post', postId, collections:[{ collectionId }] }. saveItemHandler returns
 *    `{ status }` ('added' on a fresh save). We don't over-assert the exact status
 *    string — the read-back below is the deterministic proof.
 *  - collection.getUserCollectionItemsByItem  input getUserCollectionItemsByItemSchema
 *    (collection.schema.ts:191): collectionItemSchema with a refine requiring EXACTLY
 *    one resource id — we pass { type:'Post', postId }. Returns an array of the
 *    caller's CollectionItem rows that contain the item, each keyed by
 *    `collectionId` (NOT `id`) — verified against a live preview response:
 *    [{ collectionId, addedById, tagId, collection:{...}, canRemoveItem }]. We
 *    assert our collection id is among them.
 */

const ROLE = 'tester' as const;

test.describe('tester creates a collection and saves an item into it (mutation flow)', () => {
  test.use({ storageState: storageStatePath(ROLE) });

  test('collection.upsert + saveItem round-trip, verified by read-back', async ({ page }) => {
    // Warm the request context against the preview origin so page.request shares the
    // auth cookie + a real navigated origin (preview-trpc stamps Origin/Referer for
    // the CSRF gate, but navigating once is the safe baseline — mirrors the sibling
    // tRPC-driven preview specs). domcontentloaded only: NEVER networkidle.
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const token = uniqueToken('coll');
    // Collection name is capped at 30 chars; keep it short + identifiable. The full
    // token lives on the seeded post (below) for isolation; the collection is matched
    // by the id upsert returns, not by name.
    const collectionName = `e2e-coll-${token.slice(-8)}`;

    // 1. Create an isolated Post-type collection owned by the tester.
    const collection = await trpcMutation<{ id: number } | null>(page.request, 'collection.upsert', {
      name: collectionName,
      type: 'Post',
    });
    expect(typeof collection?.id, 'collection.upsert should return a numeric collection id').toBe(
      'number'
    );

    // 2. Self-seed a Post to save into it (carries the unique token).
    const post = await trpcMutation<{ id: number } | null>(page.request, 'post.create', {
      title: token,
      detail: token,
    });
    expect(typeof post?.id, 'post.create should return a numeric post id').toBe('number');

    // 3. Save the post into the collection. saveItem returns { status } ('added');
    // reaching here (the helper throws on any tRPC error) means it was accepted.
    const saved = await trpcMutation<{ status?: string } | null>(
      page.request,
      'collection.saveItem',
      { type: 'Post', postId: post!.id, collections: [{ collectionId: collection!.id }] }
    );
    expect(saved, 'collection.saveItem should resolve to a truthy result').toBeTruthy();

    // 4. DETERMINISTIC read-back: the tester's collections containing this post must
    // include the collection we just saved into. This proves the write persisted
    // (not just 200-OK'd) — independent of saveItem's exact status string.
    const owning = await trpcQuery<Array<{ collectionId: number }>>(
      page.request,
      'collection.getUserCollectionItemsByItem',
      { type: 'Post', postId: post!.id }
    );
    // Each entry is a CollectionItem row keyed by `collectionId` (NOT `id`) —
    // verified against a live preview response:
    // [{ collectionId, addedById, tagId, collection:{...}, canRemoveItem }].
    const owningIds = (owning ?? []).map((c) => c.collectionId);
    expect(
      owningIds,
      `the post should now live in the seeded collection (${collection!.id}); saw: ${owningIds.join(
        ','
      )}`
    ).toContain(collection!.id);
  });
});
