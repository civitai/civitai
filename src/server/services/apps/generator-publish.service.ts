import { TRPCError } from '@trpc/server';
import { dbRead } from '~/server/db/client';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import { getIsSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import {
  collectGeneratorVersionIds,
  type GeneratorValue,
} from '~/server/schema/apps/generator-value.schema';

/**
 * Publish-time validation for a structured "published generator" value (Custom
 * Generators PR-B). Two fail-closed checks that run BEFORE a generator row can
 * land in shared_kv:
 *   - G7: EVERY pinned resource (each button's checkpoint + every LoRA versionId)
 *     is generatable, validated through the platform's CANONICAL
 *     generation-entitlement gate (`resolveCanGenerateForVersions`) — the exact
 *     same gate the generation-time path uses. No new gate is invented.
 *   - backgroundImageRef: the opaque already-moderated image id (produced by a
 *     SEPARATE PR) is re-validated to exist + be `Scanned` + within a SFW ceiling.
 */

/**
 * G7 — validate that EVERY pinned resource in the generator (checkpoints + LoRAs
 * across all buttons) is available for generation FOR THE PUBLISHING VIEWER.
 *
 * Reuses the platform's canonical gate verbatim:
 *   - `resolvePageResourceContext` resolves each bare modelVersionId to the
 *     platform gate fields (status / availability / usageControl / coverage /
 *     baseModel / modelType / alias) — the STATELESS resolver (no modelId
 *     binding; a published generator has no bound model), throwing NOT_FOUND for
 *     a missing/unpublished version.
 *   - `resolveCanGenerateForVersions` then applies the SAME entitlement +
 *     coverage + base-model-supported check the generation form / block page
 *     gate (`assertViewerCanGeneratePageResources`) uses.
 *
 * FAIL-CLOSED: a version missing from the result Map OR `canGenerate === false`
 * → FORBIDDEN. Dynamic-imported so the heavy generation service graph is not
 * pulled into the router's module load.
 */
export async function assertGeneratorResourceStackGeneratable(opts: {
  generator: GeneratorValue;
  viewer: { id: number; isModerator: boolean };
  sfwOnly?: boolean;
}): Promise<void> {
  const { generator, viewer } = opts;
  const versionIds = collectGeneratorVersionIds(generator);
  if (!versionIds.length) {
    // A generator with buttons always pins at least one checkpoint (schema
    // guarantees ≥1 button, each with a checkpointVersionId), so this is
    // defensive — reject rather than vacuously pass.
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'generator pins no resources' });
  }

  const { resolvePageResourceContext } = await import('~/server/services/blocks/workflow.service');
  const { resolveCanGenerateForVersions } = await import(
    '~/server/services/generation/generation.service'
  );
  type GateVersion = Parameters<typeof resolveCanGenerateForVersions>[0][number];

  // Resolve each version to its gate bag. A missing/unpublished version throws
  // NOT_FOUND here (fail-closed before the entitlement gate even runs). The gate
  // bag's DB column types are wider than the gate's string enums (same cast the
  // block page gate uses in blocks.router `buildGateVersion`).
  const gates = await Promise.all(
    versionIds.map(async (id) => {
      const { gate } = await resolvePageResourceContext(id);
      return gate as unknown as GateVersion;
    })
  );

  const states = await resolveCanGenerateForVersions(gates, {
    user: { id: viewer.id, isModerator: viewer.isModerator },
    sfwOnly: opts.sfwOnly ?? false,
    // Generators pin checkpoints + LoRAs, never wildcard sets.
    wildcardsEnabled: false,
  });

  for (const gate of gates) {
    const canGenerate = states.get(gate.id)?.canGenerate ?? false;
    if (!canGenerate) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'a pinned resource is not available for generation',
      });
    }
  }
}

/**
 * Validate an optional `backgroundImageRef`. The id is an OPAQUE,
 * already-moderated civitai Image id — the upload/scan/gate that PRODUCES a
 * valid id is a SEPARATE PR (PR-C OPEN_IMAGE_UPLOAD). Here we do a lightweight
 * re-check (no upload, no scan, no ownership coupling to the listing-asset
 * machinery): the image must EXIST, be terminally `Scanned`, and sit within a
 * SFW browsing-level ceiling (a published generator's background is
 * community-facing forced-SFW, mirroring the text belt's `isGreen`).
 *
 * Fail-closed: missing → NOT_FOUND; not yet `Scanned` (or terminally
 * Blocked/NotFound) → BAD_REQUEST; moderator-flagged (`tosViolation`) or pending
 * human review (`needsReview` non-null) → BAD_REQUEST; NSFW level → BAD_REQUEST.
 * The tos/review checks matter because a `Scanned` + SFW-level image can still be
 * moderator-flagged or awaiting manual review — the automated scan level alone is
 * not a clean bill of health.
 */
export async function validateGeneratorBackgroundImage(imageRef: string): Promise<void> {
  const imageId = Number(imageRef);
  if (!Number.isInteger(imageId) || imageId <= 0) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'invalid background image reference' });
  }
  const image = await dbRead.image.findUnique({
    where: { id: imageId },
    select: { id: true, ingestion: true, nsfwLevel: true, tosViolation: true, needsReview: true },
  });
  if (!image) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'background image not found' });
  }
  if (image.ingestion !== ImageIngestionStatus.Scanned) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'background image is not available (still scanning or was rejected)',
    });
  }
  // A Scanned + SFW image can still be moderator-flagged (tosViolation) or pending
  // human review (needsReview non-null) — fail-closed on both.
  if (image.tosViolation || image.needsReview != null) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'background image is flagged or pending review',
    });
  }
  // SFW ceiling — a published generator is community-facing forced-SFW.
  if (!getIsSafeBrowsingLevel(image.nsfwLevel)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'background image exceeds the allowed content rating',
    });
  }
}
