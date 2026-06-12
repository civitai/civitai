import { expect, test } from '@playwright/test';
import { storageStatePath } from './preview-fixtures';
import { trpcMutation, trpcQuery, uniqueToken } from './preview-trpc';

/**
 * Model authoring + publish e2e for a deployed PR preview.
 *
 * The real "upload and post a model" UX is a wizard (create model -> version ->
 * file dropzone -> publish). Under the hood it's a tRPC chain; this covers the
 * model -> version -> publish portion, which is the highest-value, regression-prone
 * write+publish contract and is fully preview-seedable. The binary file upload is
 * deliberately OUT of scope here — it's the same B2 presigned PUT already covered
 * end-to-end by preview-post-upload.spec.ts, and publishModelById has NO file/scan
 * precondition (the scan gate is UI-only), so a fileless draft publishes through the
 * real mutation + its base-model guards. Mirrors preview-article.spec.ts.
 *
 * Role: tester (free member, passes the gate; model.upsert / modelVersion.upsert /
 * model.publish are guardedProcedures with no rate limit — unlike article.upsert —
 * so no need to force mod).
 */

test.describe('upload + post a model (tester)', () => {
  test.use({ storageState: storageStatePath('tester') });

  test('model.upsert -> modelVersion.upsert -> model.publish round-trip', async ({ page }) => {
    // Warm the request context against the preview origin (auth cookie + CSRF origin).
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const token = uniqueToken('model');

    // 1. Create a draft Model. Required: name, type, uploadType, status (clean token
    //    so the profanity filter doesn't flip nsfw). Returns the model incl. numeric id.
    const model = await trpcMutation<{ id: number } | null>(page.request, 'model.upsert', {
      name: token,
      type: 'Checkpoint',
      uploadType: 'Created',
      status: 'Draft',
    });
    expect(typeof model?.id, 'model.upsert should return a numeric model id').toBe('number');

    // 2. Create a draft ModelVersion under it. Required: modelId, name, baseModel.
    //    'SD 1.5' is a current, non-deprecated, non-nsfw-restricted base model, so the
    //    publish-time base-model guards pass. status omitted -> Draft.
    const version = await trpcMutation<{ id: number } | null>(
      page.request,
      'modelVersion.upsert',
      {
        modelId: model!.id,
        name: `${token}-v1`,
        baseModel: 'SD 1.5',
      }
    );
    expect(typeof version?.id, 'modelVersion.upsert should return a numeric version id').toBe(
      'number'
    );

    // 3. Read the model back (model.getById is public) — proves persistence.
    const fetched = await trpcQuery<{ name?: string; status?: string }>(
      page.request,
      'model.getById',
      { id: model!.id }
    );
    expect(fetched?.name, 'model.getById round-trips the created name').toBe(token);

    // 4. Publish the model (+ its named version) through the real publish mutation,
    //    which runs the NSFW / deprecated-/restricted-base-model guards. No file or
    //    scan is required server-side (publishModelById has no such precondition).
    await trpcMutation(page.request, 'model.publish', {
      id: model!.id,
      versionIds: [version!.id],
    });

    // 5. Verify it went Published.
    const published = await trpcQuery<{ status?: string }>(page.request, 'model.getById', {
      id: model!.id,
    });
    expect(published?.status, 'model should be Published after publish').toBe('Published');

    // 6. Best-effort cleanup (shared dev DB hygiene). Non-fatal — the unique token
    //    keeps a leftover from colliding with concurrent previews anyway.
    try {
      await trpcMutation(page.request, 'model.delete', { id: model!.id });
    } catch {
      // ignore — cleanup is opportunistic
    }
  });
});
