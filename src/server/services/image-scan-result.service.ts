import poiWords from '~/utils/metadata/lists/words-poi.json';
import { getWorkflow, type MediaRatingOutput, type WorkflowEvent } from '@civitai/client';
import type { NextApiRequest } from 'next';
import { dbWrite } from '~/server/db/client';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';
import { clickhouse } from '~/server/clickhouse/client';
import { env } from '~/env/server';
import type { TagType } from '~/shared/utils/prisma/enums';
import {
  ImageIngestionStatus,
  ModerationRuleAction,
  NewOrderRankType,
  TagSource,
} from '~/shared/utils/prisma/enums';
import {
  BlockedReason,
  BlocklistType,
  NotificationCategory,
  NsfwLevel,
  SearchIndexUpdateQueueAction,
  SignalMessages,
} from '~/server/common/enums';
import { stripBenignPhrases } from '~/server/services/blocklist.service';
import {
  auditMetaData,
  getTagsFromPrompt,
  includesInappropriate,
  includesPoi,
} from '~/utils/metadata/audit';
import { getComputedTags, getConditionalTagsForReview } from '~/server/utils/tag-rules';
import { getTagRules } from '~/server/services/system-cache';
import { Prisma } from '@prisma/client';
import { insertTagsOnImageNew } from '~/server/services/tagsOnImageNew.service';
import { isDefined } from '~/utils/type-guards';
import { normalizeText } from '~/utils/normalize-text';
import { styleTags, tagsNeedingReview } from '~/libs/tags';
import {
  orchestratorNsfwLevelMap,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { createImageTagsForReview } from '~/server/services/image-review.service';
import {
  tagIdsForImagesCache,
  tagCacheByName,
  userImageVideoCountCaches,
} from '~/server/redis/caches';
import type { MediaMetadata } from '~/server/schema/media.schema';
import { deleteUserProfilePictureCache } from '~/server/services/user.service';
import { bustCachesForPosts, updatePostNsfwLevel } from '~/server/services/post.service';
import {
  queueComicsForPanelImage,
  updateComicNsfwLevelsForImage,
  updateModel3DNsfwLevelForThumbnailImage,
} from '~/server/services/nsfwLevels.service';
import { getImagesModRules, queueImageSearchIndexUpdate } from '~/server/services/image.service';
import { signalClient } from '~/utils/signal-client';
import { addImageToQueue } from '~/server/services/games/new-order.service';
import { getFeatureFlagsLazy } from '~/server/services/feature-flags.service';
import { fanOutArticleImageUpdates } from '~/server/utils/webhook-debounce';
import { logToAxiom } from '~/server/logging/client';
import { recordImageScan } from '~/server/services/scanner-audit.service';
import { evaluateRules } from '~/server/utils/mod-rules';
import { createNotification } from '~/server/services/notification.service';
import { decreaseDate } from '~/utils/date-helpers';

export async function isExemptFromAiVerification(
  imageId: number,
  metadata?: MediaMetadata | null
): Promise<boolean> {
  // Fast path: check metadata flags (no DB query needed)
  if (metadata?.profilePicture) return true;
  if (metadata?.coverImage) return true;

  // DB fallback: check relationships for existing images without metadata flags
  const [result] = await dbWrite.$queryRaw<{ exempt: boolean }[]>`
    SELECT (
      EXISTS(SELECT 1 FROM "User" WHERE "profilePictureId" = ${imageId}) OR
      EXISTS(SELECT 1 FROM "UserProfile" WHERE "coverImageId" = ${imageId}) OR
      EXISTS(SELECT 1 FROM "Article" WHERE "coverId" = ${imageId}) OR
      EXISTS(SELECT 1 FROM "Challenge" WHERE "coverImageId" = ${imageId}) OR
      EXISTS(SELECT 1 FROM "ImageConnection" WHERE "imageId" = ${imageId} AND "entityType" IN ('Bounty', 'Article'))
    ) AS exempt
  `;
  return result?.exempt ?? false;
}

type WdTaggingStep = {
  $type: 'wdTagging';
  output: { tags: Record<string, number>; rating: Record<string, number> };
};
type MediaRatingStep = {
  $type: 'mediaRating';
  output: MediaRatingOutput;
};
type MediaHashStep = {
  $type: 'mediaHash';
  output: { hashes: { perceptual: string } };
};
type RepeatStep = {
  $type: 'repeat';
  output: {
    steps: Array<MediaRatingStep | WdTaggingStep>;
  };
};
export type ScanResultStep = WdTaggingStep | MediaRatingStep | MediaHashStep | RepeatStep;

type NormalizedTag = {
  name: string;
  confidence: number;
  source: TagSource;
};

type TagWithId = { id: number; name: string; nsfwLevel: number; type: TagType };
type ProcessedTag = {
  source: TagSource;
  confidence: number;
  id: number;
  name: string;
  nsfwLevel: number;
  type: TagType;
};

export async function processImageScanResult(req: NextApiRequest) {
  const event: WorkflowEvent = req.body;

  const { data } = await getWorkflow({
    client: internalOrchestratorClient,
    path: { workflowId: event.workflowId },
  });
  if (!data) throw new Error(`could not find workflow: ${event.workflowId}`);

  const imageId = data.metadata?.imageId as number | undefined;
  if (!imageId) throw new Error(`missing workflow metadata.imageId - ${event.workflowId}`);

  const featureFlags = getFeatureFlagsLazy({ req });
  await processImageScanWorkflow({
    workflowId: event.workflowId,
    status: event.status,
    steps: (data.steps ?? []) as unknown as ScanResultStep[],
    imageId,
    articleImageScanning: featureFlags.articleImageScanning,
    startedAt: data.startedAt,
    completedAt: data.completedAt,
  });
}

/**
 * Core image scan processing extracted so it can be called from both the webhook
 * handler (via `processImageScanResult`) and migration scripts that use `wait`
 * to get results inline.
 *
 * The flow reads top-to-bottom as a pipeline: parse the workflow steps, persist
 * the perceptual hash / hard-block, load the image, write its tags, resolve the
 * ingestion outcome (audit + moderation rules + the row UPDATE), then fire the
 * post-update side effects (audit log, article fan-out, cache/index updates,
 * realtime signal). Each phase is a single-responsibility helper below.
 */
export async function processImageScanWorkflow({
  workflowId,
  status,
  steps,
  imageId,
  articleImageScanning = false,
  startedAt,
  completedAt,
}: {
  workflowId: string;
  status: string;
  steps: ScanResultStep[];
  imageId: number;
  /** Enable debounced article ingestion updates (webhook path with feature flag) */
  articleImageScanning?: boolean;
  /** Workflow timing from the orchestrator response. Used by recordImageScan
   * for the scanner_label_results audit log. Optional so migration scripts
   * can still call this without supplying them. */
  startedAt?: Date | string | null;
  completedAt?: Date | string | null;
}) {
  if (status !== 'succeeded') {
    // Record WHICH orchestrator steps failed (wdTagging / mediaHash /
    // mediaRating) — this is the key diagnostic. The orchestrator emits only a
    // workflow-level status (`failed`/`canceled`; it never sends `expired`) with
    // no per-job error reason on the wire, so the failing-step name is the only
    // signal we have to tell transient decode/fetch churn apart from a genuine
    // rating failure. NOTE: `markImageScanError` still ALWAYS bumps retryCount
    // toward the 9-cap (see there). The expired-vs-failed "don't burn a retry"
    // behavior is deferred: with no `expired` status and no per-job reason we
    // can't yet distinguish a transient timeout from a real failure — this
    // step/reason logging is the data needed to design that fix.
    const failedSteps = extractFailedSteps(steps);
    const failureType = status === 'canceled' ? 'canceled' : 'workflow-failed';
    const { retryCount, mediaType } = await markImageScanError({
      workflowId,
      imageId,
      status,
      failureType,
      failedSteps,
    });
    logToAxiom(
      {
        name: 'image-scan-result',
        type: 'warning',
        message: `workflow not succeeded: ${status}`,
        source: 'image-scan-result.service',
        failureType,
        failedSteps,
        imageId,
        mediaType,
        workflowId,
        status,
        retryCount,
      },
      'webhooks'
    ).catch(() => null);
    if (articleImageScanning) await fanOutArticleImageUpdates(imageId);
    return;
  }

  const { wdTags, mediaRating, mediaHash } = parseScanSteps({ steps, workflowId });
  const pHash = computePerceptualHash(mediaHash?.hashes?.perceptual);

  // Log (don't act on) perceptual-hash matches against known-blocked content.
  if (!mediaRating.isBlocked && pHash) await logPerceptualHashMatch({ imageId, pHash });

  // The orchestrator content rating can hard-block the image outright.
  if (mediaRating.isBlocked) {
    await blockImageFromRating({ imageId, pHash, blockedReason: mediaRating.blockedReason });
  }

  const image = await loadImageForScan(imageId);
  const { prompt, negativePrompt } = (image.meta ?? {}) as {
    prompt?: string;
    negativePrompt?: string;
  };

  await buildAndInsertScanTags({
    imageId: image.id,
    wdTags,
    ratingLevel: mediaRating.nsfwLevel,
    prompt,
  });

  const outcome = await resolveScanOutcome({
    image,
    mediaRating,
    pHash,
    workflowId,
    prompt,
    negativePrompt,
  });

  // --- side effects (run after the image row reflects the resolved outcome) ---

  // Audit-log to scanner_label_results. Fire-and-forget — failures log but
  // can't block ingestion. Runs for every successful mediaRating output.
  await recordImageScan({
    workflowId,
    imageId: image.id,
    mediaRating,
    startedAt,
    completedAt,
  });

  // Fan out to articles for every terminal state (Scanned and Blocked).
  // Article ingestion must advance on Blocked too, otherwise articles whose last
  // image blocks stay stuck in Pending/Rescan.
  if (articleImageScanning) await fanOutArticleImageUpdates(image.id);

  await applyIngestionSideEffects({ image, outcome });

  await signalClient.send({
    target: SignalMessages.ImageIngestionStatus,
    data: { imageId: image.id, ingestion: outcome.ingestion, blockedFor: outcome.blockedFor },
    userId: image.userId,
  });
}

// Step parsing
// --------------------------------------------------
function parseScanSteps({ steps, workflowId }: { steps: ScanResultStep[]; workflowId: string }) {
  const wdTagging =
    steps.find((x) => x.$type === 'wdTagging')?.output ?? aggregateWdTaggingRepeater(steps);
  const mediaRating =
    steps.find((x) => x.$type === 'mediaRating')?.output ?? aggregateMediaRatingRepeater(steps);
  const mediaHash = steps.find((x) => x.$type === 'mediaHash')?.output;

  const missingSteps: string[] = [];
  if (!wdTagging) missingSteps.push('wdTagging');
  if (!mediaRating) missingSteps.push('mediaRating');

  if (missingSteps.length > 0)
    throw new Error(
      `Incomplete workflow: ${workflowId}. Missing steps: ${missingSteps.join(', ')}`
    );

  if (mediaRating?.nsfwLevel === 'na')
    throw new Error(`invalid media rating for workflow: ${workflowId}`);

  return { wdTags: wdTagging!.tags, mediaRating: mediaRating!, mediaHash };
}

function computePerceptualHash(perceptual?: string) {
  if (!perceptual) return undefined;
  return BigInt.asIntN(64, BigInt('0x' + perceptual));
}

function aggregateWdTaggingRepeater(steps: ScanResultStep[]) {
  const step = steps.find(
    (x) => x.$type === 'repeat' && x.output.steps[0].$type === 'wdTagging'
  ) as RepeatStep;
  if (!step) return;

  const wdTaggingSteps = step.output.steps as WdTaggingStep[];

  return wdTaggingSteps.reduce<WdTaggingStep['output']>(
    (acc, step) => {
      for (const [tag, confidence] of Object.entries(step.output.tags)) {
        const current = acc.tags[tag];
        if (!current) acc.tags[tag] = confidence;
        else if (confidence > current) acc.tags[tag] = confidence;
      }
      for (const [rating, confidence] of Object.entries(step.output.rating)) {
        const current = acc.rating[rating];
        if (!current) acc.rating[rating] = confidence;
        else if (confidence > current) acc.rating[rating] = confidence;
      }
      return acc;
    },
    { tags: {}, rating: {} }
  );
}

function aggregateMediaRatingRepeater(steps: ScanResultStep[]) {
  const step = steps.find(
    (x) => x.$type === 'repeat' && x.output.steps[0].$type === 'mediaRating'
  ) as RepeatStep;
  if (!step) return;

  const mediaRatingSteps = step.output.steps as MediaRatingStep[];

  return mediaRatingSteps.reduce<MediaRatingStep['output']>(
    (acc, step) => {
      const {
        nsfwLevel,
        isBlocked,
        blockedReason,
        ageClassification,
        faceRecognition,
        aiRecognition,
        animeRecognition,
      } = step.output;
      if (!acc.isBlocked) acc.isBlocked = isBlocked;
      if (!acc.blockedReason) acc.blockedReason = blockedReason;

      if (orchestratorNsfwLevelMap[nsfwLevel] > orchestratorNsfwLevelMap[acc.nsfwLevel])
        acc.nsfwLevel = nsfwLevel;

      if (ageClassification?.detections.length) {
        acc.ageClassification ??= { detections: [] };
        acc.ageClassification.detections.push(...ageClassification.detections);
      }
      if (faceRecognition?.faces.length) {
        acc.faceRecognition ??= { faces: [] };
        acc.faceRecognition.faces.push(...faceRecognition.faces);
      }
      if (
        aiRecognition &&
        (!acc.aiRecognition || aiRecognition.confidence > acc.aiRecognition.confidence)
      ) {
        acc.aiRecognition = aiRecognition;
      }
      if (
        animeRecognition &&
        (!acc.animeRecognition || animeRecognition.confidence > acc.animeRecognition.confidence)
      ) {
        acc.animeRecognition = animeRecognition;
      }

      return acc;
    },
    { nsfwLevel: 'pg', isBlocked: false }
  );
}

// Blocked-content detection
// --------------------------------------------------
async function getIsImageBlocked(hash: bigint) {
  if (!env.BLOCKED_IMAGE_HASH_CHECK || !clickhouse) return false;

  const [{ count }] = await clickhouse.$query<{ count: number }>`
    SELECT cast(count() as int) as count
    FROM blocked_images
    WHERE bitCount(bitXor(hash, ${hash})) < 5 AND disabled = false
  `;

  return count > 0;
}

async function logPerceptualHashMatch({ imageId, pHash }: { imageId: number; pHash: bigint }) {
  const pHashBlocked = await getIsImageBlocked(pHash);
  if (!pHashBlocked) return;

  // blockedReason = 'Similar to blocked content';
  logToAxiom(
    {
      name: 'image-phash-match',
      type: 'info',
      message: 'Image pHash matched a blocked image',
      imageId,
      pHash: pHash.toString(),
      source: 'image-scan-result.service',
    },
    'webhooks'
  ).catch(() => null);
}

async function blockImageFromRating({
  imageId,
  pHash,
  blockedReason,
}: {
  imageId: number;
  pHash?: bigint;
  blockedReason?: string | null;
}) {
  await dbWrite.image.updateMany({
    where: { id: imageId },
    data: {
      pHash,
      ingestion: ImageIngestionStatus.Blocked,
      nsfwLevel: NsfwLevel.Blocked,
      blockedFor: blockedReason,
    },
  });
}

/**
 * Which orchestrator steps reported `failed`, by step name (falling back to
 * `$type`). This is the only per-failure diagnostic we get — the workflow status
 * itself is just `failed`/`canceled` with no reason — so it's what tells a
 * tagging failure (`tags`/wdTagging) apart from a hash (`hash`/mediaHash) or
 * rating (`rating`/mediaRating) failure. Reads `status` off the raw workflow
 * steps (not modeled on `ScanResultStep`, which only carries outputs).
 */
function extractFailedSteps(steps: ScanResultStep[]): string[] {
  return (steps as Array<{ name?: string; $type?: string; status?: string }>)
    .filter((step) => step?.status === 'failed')
    .map((step) => step.name ?? step.$type ?? 'unknown');
}

/**
 * Flip an image to `Error`, increment its scan `retryCount`, and stamp a small
 * `scanJobs.error = { status, failureType, failedSteps, at }` so a plain
 * Postgres query can tell WHY a scan errored (and which step) without an
 * orchestrator lookup. Returns the new (post-increment) retryCount and the
 * image's mediaType so callers can log them; both are `null` when no row matched
 * (e.g. the image was deleted between scan request and callback).
 */
async function markImageScanError({
  workflowId,
  imageId,
  status,
  failureType,
  failedSteps,
}: {
  workflowId: string;
  imageId: number;
  status: string;
  failureType: string;
  failedSteps: string[];
}): Promise<{ retryCount: number | null; mediaType: string | null }> {
  const errorJson = JSON.stringify({
    status,
    failureType,
    failedSteps,
    at: new Date().toISOString(),
  });
  const rows = await dbWrite.$queryRaw<{ retryCount: number | null; mediaType: string | null }[]>`
    UPDATE "Image"
    SET
      "ingestion" = ${ImageIngestionStatus.Error}::"ImageIngestionStatus",
      "scanJobs" = jsonb_set(
        jsonb_set(
          jsonb_set(
            COALESCE("scanJobs", '{}'),
            '{retryCount}',
            to_jsonb(COALESCE(("scanJobs"->>'retryCount')::int, 0) + 1)
          ),
          '{workflowId}',
          ${JSON.stringify(workflowId)}::jsonb
        ),
        '{error}',
        ${errorJson}::jsonb
      )
    WHERE id = ${imageId}
    RETURNING ("scanJobs"->>'retryCount')::int as "retryCount", type as "mediaType"
  `;
  return { retryCount: rows[0]?.retryCount ?? null, mediaType: rows[0]?.mediaType ?? null };
}

// Image loading
// --------------------------------------------------
async function loadImageForScan(imageId: number) {
  const image = await dbWrite.image.findUnique({
    where: { id: imageId },
    select: {
      id: true,
      createdAt: true,
      scannedAt: true,
      type: true,
      userId: true,
      meta: true,
      metadata: true,
      postId: true,
      nsfwLevelLocked: true,
      nsfwLevel: true,
      ingestion: true,
    },
  });

  if (!image) throw new Error(`image not found: ${imageId}`);
  return image;
}
type ScanImage = Awaited<ReturnType<typeof loadImageForScan>>;

// Tagging
// --------------------------------------------------
async function buildAndInsertScanTags({
  imageId,
  wdTags,
  ratingLevel,
  prompt,
}: {
  imageId: number;
  wdTags: Record<string, number>;
  ratingLevel: string;
  prompt?: string;
}) {
  const tagsWithSource = {
    [TagSource.WD14]: wdTags,
    [TagSource.SpineRating]: { [ratingLevel]: 100 },
  };
  const normalizedTags: NormalizedTag[] = Object.entries(tagsWithSource).flatMap(
    ([source, tagMap]) =>
      Object.entries(tagMap).map(([name, confidence]) => {
        if (source === TagSource.WD14) name = name.replace(/_/g, ' ');
        return {
          name,
          confidence: Math.round(confidence * 100),
          source: source as TagSource,
        };
      })
  );

  const tags = await processTags({ tags: normalizedTags, prompt });

  await insertTagsOnImageNew(
    tags.map((tag) => ({
      imageId,
      tagId: tag.id,
      source: tag.source,
      confidence: tag.confidence,
      automated: true,
    }))
  );
}

async function processTags({
  tags: normalized,
  prompt,
}: {
  tags: NormalizedTag[];
  prompt?: string;
}): Promise<ProcessedTag[]> {
  if (prompt) {
    // Detect real person in prompt
    const realPersonName = includesPoi(prompt);
    if (realPersonName) {
      const tagName =
        typeof realPersonName === 'object' ? realPersonName.matchedText : realPersonName;
      normalized.push({
        name: tagName.toLowerCase(),
        confidence: 100,
        source: TagSource.Computed,
      });
    }

    // Detect tags from prompt
    const promptTags = getTagsFromPrompt(prompt);
    if (promptTags)
      normalized.push(
        ...promptTags.map((name) => ({ name, confidence: 70, source: TagSource.Computed }))
      );
  }

  // add computed tags
  const computedTags = getComputedTags(
    normalized.map((x) => x.name),
    'WD14'
  );
  normalized.push(
    ...computedTags.map((name) => ({ name, confidence: 70, source: TagSource.Computed }))
  );

  // apply tag rules
  const tagRules = await getTagRules();
  for (const rule of tagRules) {
    const match = normalized.find((x) => x.name === rule.toTag);
    if (!match) continue;

    if (rule.type === 'Replace') {
      match.name = rule.fromTag;
    } else if (rule.type === 'Append') {
      normalized.push({ name: rule.fromTag, confidence: 70, source: TagSource.Computed });
    }
  }

  // De-dupe incoming tags and keep tag with highest confidence
  const tagMap: Record<string, NormalizedTag> = {};
  for (const tag of normalized) {
    if (!tagMap[tag.name] || tagMap[tag.name].confidence < tag.confidence) tagMap[tag.name] = tag;
  }
  const deduped: NormalizedTag[] = Object.values(tagMap);

  const { found, missing } = await tagCacheByName.fetch(deduped.map((x) => x.name));
  let queriedTags: TagWithId[] = [];
  if (missing.length > 0) {
    queriedTags = await dbWrite.tag.findMany({
      where: { name: { in: missing } },
      select: { id: true, name: true, nsfwLevel: true, type: true },
    });
    await tagCacheByName.setMany(queriedTags.map((data) => ({ key: data.name, data })));
  }
  const queriedNames = new Set(queriedTags.map((t) => t.name));
  const tagsToCreate = missing.filter((name) => !queriedNames.has(name));

  let createdTags: TagWithId[] = [];
  if (tagsToCreate.length > 0) {
    const tagsToInsert = deduped.filter((x) => tagsToCreate.includes(x.name));

    const values = tagsToInsert.map((tag) => Prisma.sql`(${tag.name})`);

    createdTags = await dbWrite.$queryRaw<TagWithId[]>`
      INSERT INTO "Tag" (name)
      VALUES ${Prisma.join(values)}
      ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
      RETURNING id, name, "nsfwLevel", type
    `;
    await tagCacheByName.setMany(createdTags.map((data) => ({ key: data.name, data })));
  }

  const allTags = [...found.values(), ...queriedTags, ...createdTags]
    .map((tag) => {
      const match = normalized.find((x) => x.name === tag.name);
      if (!match) return null;
      return { ...tag, source: match.source, confidence: match.confidence };
    })
    .filter(isDefined);

  return allTags;
}

// Outcome resolution (audit + moderation rules + persist)
// --------------------------------------------------
type ScanOutcome = {
  ingestion: ImageIngestionStatus;
  blockedFor: string | null;
  reviewKey: string | null;
  /** Present only when the image was audited (i.e. not the isBlocked short-circuit). */
  audit?: Awaited<ReturnType<typeof auditScanResults>>;
};

/**
 * Resolve and persist the final state of the image row, returning the bits the
 * post-update side effects need. Three terminal shapes:
 *  - `isBlocked` (orchestrator content rating): keep the block written by
 *    `blockImageFromRating`, only stamp provenance — do NOT re-audit (that would
 *    recompute a fresh nsfwLevel/ingestion and silently un-block the image). A
 *    *prior* block is intentionally NOT sticky: a moderator rescan re-runs the
 *    workflow with ingestion still 'Blocked' (see `ingestImage`), so letting the
 *    audit run is what lets a rescan clear a block; hard violations re-block via
 *    `isBlocked` anyway.
 *  - `audit.blockedFor` (prompt TOS/CSAM): block.
 *  - otherwise: Scanned, with moderation rules applied last so a rule Block/Hold
 *    takes precedence over the audit decision.
 */
async function resolveScanOutcome({
  image,
  mediaRating,
  pHash,
  workflowId,
  prompt,
  negativePrompt,
}: {
  image: ScanImage;
  mediaRating: MediaRatingOutput;
  pHash?: bigint;
  workflowId: string;
  prompt?: string;
  negativePrompt?: string;
}): Promise<ScanOutcome> {
  const updatedAt = new Date();

  if (mediaRating.isBlocked) {
    await dbWrite.$executeRaw`
      UPDATE "Image"
      SET
        "updatedAt" = ${updatedAt},
        "pHash" = COALESCE(${pHash ?? null}, "pHash"),
        "scanJobs" = jsonb_set(COALESCE("scanJobs", '{}'), '{workflowId}', ${JSON.stringify(
          workflowId
        )}::jsonb)
      WHERE id = ${image.id}
    `;
    return {
      ingestion: ImageIngestionStatus.Blocked,
      blockedFor: mediaRating.blockedReason ?? null,
      reviewKey: null,
    };
  }

  const audit = await auditScanResults({
    imageId: image.id,
    userId: image.userId,
    prompt,
    negativePrompt,
  });
  let reviewKey = audit.reviewKey ?? null;

  const toUpdate: Prisma.ImageUpdateInput = { updatedAt, pHash };
  // AI-generation verification is no longer a blocking gate (per operations
  // 2026-05-11): nsfw images that we couldn't auto-verify as AI used to
  // land in `Blocked + AiNotVerified`, but the false-positive rate didn't
  // justify the friction. The remaining `audit.blockedFor` branch still
  // catches hard violations (TOS / Moderated / CSAM) — everything else
  // falls through to Scanned.
  if (audit.blockedFor) {
    toUpdate.ingestion = ImageIngestionStatus.Blocked;
    toUpdate.blockedFor = audit.blockedFor;
    toUpdate.nsfwLevel = NsfwLevel.Blocked;
  } else {
    toUpdate.ingestion = ImageIngestionStatus.Scanned;
    toUpdate.needsReview = reviewKey;
    toUpdate.minor = audit.minor;
    toUpdate.poi = audit.poi;
    toUpdate.blockedFor = null;
    // Respect a manually-locked nsfw level — never overwrite it from the scan.
    toUpdate.nsfwLevel = image.nsfwLevelLocked ? image.nsfwLevel : audit.nsfwLevel;

    // scannedAt reassignment: always stamp the first scan; afterwards only
    // re-stamp recent (<1 week old) non-Rescan images that haven't opted out
    // via metadata.skipScannedAtReassignment. Older/rescanned images keep
    // their original scannedAt.
    const now = new Date();
    if (!image.scannedAt) toUpdate.scannedAt = now;
    else if (
      !(image.metadata as any)?.skipScannedAtReassignment &&
      image.ingestion !== 'Rescan' &&
      new Date(image.createdAt).getTime() >= decreaseDate(now, 7, 'days').getTime()
    )
      toUpdate.scannedAt = now;
    else toUpdate.scannedAt = image.scannedAt;
  }

  // Moderation rules can block the image, hold it for review, or annotate its
  // metadata with the matched rule. Applied after the scan audit so a Block/Hold
  // takes precedence over the audit's own decision.
  const modRule = await evaluateImageModRules(image, audit.tags);
  let metadataUpdate: Record<string, any> | undefined;
  if (modRule) {
    metadataUpdate = modRule.metadata;
    if (modRule.ingestion) toUpdate.ingestion = modRule.ingestion;
    if (modRule.nsfwLevel != null) toUpdate.nsfwLevel = modRule.nsfwLevel;
    if (modRule.blockedFor) toUpdate.blockedFor = modRule.blockedFor;
    if (modRule.needsReview !== undefined) {
      toUpdate.needsReview = modRule.needsReview;
      if (typeof modRule.needsReview === 'string') reviewKey = modRule.needsReview;
    }
    // Notify the user only when a rule auto-blocked the image (not on Hold).
    if (modRule.ingestion === ImageIngestionStatus.Blocked) {
      await notifyImageAutoBlocked({
        imageId: image.id,
        userId: image.userId,
        reason: modRule.ruleReason,
      });
    }
  }

  await dbWrite.$executeRaw`
    UPDATE "Image"
    SET
      "updatedAt" = ${toUpdate.updatedAt},
      "pHash" = ${pHash ?? null},
      "ingestion" = ${toUpdate.ingestion as string}::"ImageIngestionStatus",
      "blockedFor" = ${(toUpdate.blockedFor as string) ?? null},
      "nsfwLevel" = ${toUpdate.nsfwLevel as number},
      "needsReview" = ${(toUpdate.needsReview as string) ?? null},
      "minor" = ${(toUpdate.minor as boolean) ?? false},
      "poi" = ${(toUpdate.poi as boolean) ?? false},
      "scannedAt" = ${(toUpdate.scannedAt as Date) ?? null},
      "metadata" = COALESCE(${
        metadataUpdate ? JSON.stringify(metadataUpdate) : null
      }::jsonb, "metadata"),
      "scanJobs" = jsonb_set(COALESCE("scanJobs", '{}'), '{workflowId}', ${JSON.stringify(
        workflowId
      )}::jsonb)
    WHERE id = ${image.id}
  `;

  return {
    ingestion: toUpdate.ingestion as ImageIngestionStatus,
    blockedFor: (toUpdate.blockedFor as string) ?? null,
    reviewKey,
    audit,
  };
}

async function auditScanResults(args: {
  imageId: number;
  userId: number;
  prompt?: string;
  negativePrompt?: string;
}) {
  // Moderator-managed benign phrases (proper nouns / technical terms that coincidentally
  // contain a detection token) are blanked up front so every downstream check — minor,
  // poi, blockedFor — sees the same cleaned text. A benign phrase is innocent content, so
  // it shouldn't feed any detector.
  const [prompt, negativePrompt] = await Promise.all([
    stripBenignPhrases(normalizeText(args.prompt), BlocklistType.PromptBenignPhrase),
    stripBenignPhrases(normalizeText(args.negativePrompt), BlocklistType.NegativeBenignPhrase),
  ]);
  const tags = await dbWrite.$queryRaw<
    { id: number; name: string; type: TagType; nsfwLevel: number; confidence: number }[]
  >`
    SELECT t.id, t.name, t."nsfwLevel", toi.confidence
    FROM "TagsOnImageDetails" toi
    JOIN "Tag" t ON t.id = toi."tagId"
    WHERE toi."imageId" = ${args.imageId} AND toi.automated AND NOT toi.disabled
  `;
  const nsfwLevel = Math.max(...[...tags.map((x) => x.nsfwLevel), 0]);
  const nsfw = nsfwLevel > sfwBrowsingLevelsFlag;
  const minorTags = tags.filter((tag) => tagsNeedingReview.includes(tag.name.toLowerCase()));
  const poiTags = tags.filter((tag) => poiWords.includes(tag.name.toLowerCase()));
  const reviewTags = [
    ...tags.filter((tag) => tag.nsfwLevel === NsfwLevel.Blocked),
    ...getConditionalTagsForReview(tags, nsfwLevel),
  ];
  const adultTags = tags.filter((tag) => tag.name === 'adult');
  const cartoonTags = tags.filter((tag) => styleTags.includes(tag.name));

  const tagReview = reviewTags.length > 0;
  let poiReview = poiTags.length > 0;
  let minorReview =
    minorTags.length > 0 && adultTags.length === 0 && (cartoonTags.length === 0 || nsfw);
  let newUserReview = false;

  const inappropriate = includesInappropriate({ prompt, negativePrompt }, nsfw);
  if (inappropriate === 'minor') minorReview = true;
  if (inappropriate === 'poi') poiReview = true;

  const associatedEntities = await getAssociatedEntities(args.imageId);
  // Associated poi/minor resources only escalate to review when the image is
  // nsfw — a sfw image with a poi/minor resource is still flagged (below) but
  // not queued for moderator review.
  if (associatedEntities.poi && nsfw) poiReview = true;
  if (associatedEntities.minor && nsfw) minorReview = true;

  if (!minorReview && !poiReview && !tagReview && nsfw) {
    newUserReview = await getIsNewUser(args.userId);
  }

  const minor = minorTags.length > 0 || !!associatedEntities.minor;
  const poi = poiTags.length > 0 || !!associatedEntities.poi || (!!prompt && !!includesPoi(prompt));

  let reviewKey: string | undefined;
  if (poiReview) reviewKey = 'poi';
  else if (minorReview) reviewKey = 'minor';
  else if (tagReview) reviewKey = 'tag';
  else if (newUserReview) reviewKey = 'newUser';

  let blockedFor: string | undefined;
  if (nsfw && prompt) {
    const auditResult = auditMetaData({ prompt }, nsfw);
    if (!auditResult.success)
      blockedFor = auditResult.blockedFor.join(',') ?? 'Failed audit, no explanation';
  }

  return {
    tags,
    nsfwLevel,
    nsfw,
    minorTags,
    poiTags,
    reviewTags,
    tagReview,
    poiReview,
    minorReview,
    newUserReview,
    minor,
    poi,
    reviewKey,
    blockedFor,
  };
}

async function getAssociatedEntities(imageId: number) {
  const [result] = await dbWrite.$queryRaw<
    { poi: boolean; minor: boolean; hasResource: boolean }[]
  >`
    WITH to_check AS (
      -- Check based on associated resources
      SELECT
        SUM(IIF(m.poi, 1, 0)) > 0 "poi",
        SUM(IIF(m.minor, 1, 0)) > 0 "minor",
        true "hasResource"
      FROM "ImageResourceNew" ir
      JOIN "ModelVersion" mv ON ir."modelVersionId" = mv.id
      JOIN "Model" m ON m.id = mv."modelId"
      WHERE ir."imageId" = ${imageId}
      UNION
      -- Check based on associated bounties
      SELECT
        SUM(IIF(b.poi, 1, 0)) > 0 "poi",
        false "minor",
        false "hasResource"
      FROM "Image" i
      JOIN "ImageConnection" ic ON ic."imageId" = i.id
      JOIN "Bounty" b ON ic."entityType" = 'Bounty' AND b.id = ic."entityId"
      WHERE ic."imageId" = ${imageId}
      UNION
      -- Check based on associated bounty entries
      SELECT
        SUM(IIF(b.poi, 1, 0)) > 0 "poi",
        false "minor",
        false "hasResource"
      FROM "Image" i
      JOIN "ImageConnection" ic ON ic."imageId" = i.id
      JOIN "BountyEntry" be ON ic."entityType" = 'BountyEntry' AND be.id = ic."entityId"
      JOIN "Bounty" b ON b.id = be."bountyId"
      WHERE ic."imageId" = ${imageId}
    )
    SELECT bool_or(poi) "poi", bool_or(minor) "minor", bool_or("hasResource") "hasResource" FROM to_check;
  `;

  return result;
}

async function getIsNewUser(userId: number) {
  const [{ isNewUser }] =
    (await dbWrite.$queryRaw<{ isNewUser: boolean }[]>`
        SELECT is_new_user(CAST(${userId} AS INT)) "isNewUser";
      `) ?? [];
  return isNewUser;
}

// Moderation rules
// --------------------------------------------------
/**
 * Evaluate the image moderation rules and return the row changes they imply
 * (block / hold / metadata annotation). Pure of side effects — the caller is
 * responsible for persisting the changes and, on a Block, calling
 * `notifyImageAutoBlocked`.
 */
async function evaluateImageModRules(
  image: { meta: Prisma.JsonValue; metadata: Prisma.JsonValue },
  tags: { name: string }[]
) {
  const imageModRules = await getImagesModRules();
  if (!imageModRules.length) return;

  const tagNames = tags.map((x) => x.name);
  const meta = (image.meta ?? {}) as Prisma.JsonObject;
  const appliedRule = evaluateRules(imageModRules, { ...meta, tags: tagNames });
  if (!appliedRule || appliedRule.action === ModerationRuleAction.Approve) return;

  const result: {
    metadata: Record<string, any>;
    ruleReason?: string | null;
    ingestion?: ImageIngestionStatus;
    nsfwLevel?: NsfwLevel;
    blockedFor?: string;
    needsReview?: string | null;
  } = {
    metadata: {
      ...((image.metadata ?? {}) as Record<string, any>),
      ruleId: appliedRule.id,
      ruleReason: appliedRule.reason,
    },
    ruleReason: appliedRule.reason,
  };

  if (appliedRule.action === ModerationRuleAction.Block) {
    result.ingestion = ImageIngestionStatus.Blocked;
    result.nsfwLevel = NsfwLevel.Blocked;
    result.blockedFor = BlockedReason.Moderated;
    result.needsReview = null;
  } else if (appliedRule.action === ModerationRuleAction.Hold) {
    result.needsReview = 'modRule';
  }

  return result;
}

async function notifyImageAutoBlocked({
  imageId,
  userId,
  reason,
}: {
  imageId: number;
  userId: number;
  reason?: string | null;
}) {
  await createNotification({
    category: NotificationCategory.System,
    key: `image-block:${imageId}`,
    type: 'system-message',
    userId,
    details: {
      message: `One of your images has been blocked due to a moderation rule violation${
        reason ? ` by the following reason: ${reason}` : ''
      }. If you believe this is a mistake, you can appeal this decision.`,
      url: `/images/${imageId}`,
    },
  }).catch((error) =>
    logToAxiom({
      name: 'image-scan-result',
      type: 'error',
      message: 'Could not create notification when blocking image',
      data: {
        imageId,
        error: error.message,
        cause: error.cause,
        stack: error.stack,
      },
    })
  );
}

// Post-update side effects
// --------------------------------------------------
async function applyIngestionSideEffects({
  image,
  outcome,
}: {
  image: ScanImage;
  outcome: ScanOutcome;
}) {
  // handle blocked image updates
  if (outcome.ingestion === ImageIngestionStatus.Blocked) {
    await queueImageSearchIndexUpdate({
      ids: [image.id],
      action: SearchIndexUpdateQueueAction.Delete,
    });
    // A previously-cached Blocked image can still satisfy the showcase query
    // filters (needsReview IS NULL, nsfwLevel != 0) so drop it from the showcase.
    if (image.postId) await bustCachesForPosts(image.postId);
    await updateModel3DNsfwLevelForThumbnailImage({ imageId: image.id, postId: image.postId });
    // If this image belongs to a comic panel, the parent project may
    // have been search-indexed under the old (unblocked) state. Re-queue
    // it so the next index pass re-evaluates visibility against the
    // moderation gates in `comics.search-index.ts:WHERE`.
    await queueComicsForPanelImage(image.id);
    return;
  }

  // handle scanned image updates
  if (outcome.ingestion === ImageIngestionStatus.Scanned) {
    // Scanning is what makes an already-published image countable. Bust rather
    // than refresh: this fires once per image, so a re-query here would be N
    // identical counts for an N-image post.
    await userImageVideoCountCaches.bust(image.userId);
    await tagIdsForImagesCache.refresh(image.id);
    if (
      typeof image.metadata === 'object' &&
      (image.metadata as MediaMetadata | undefined)?.profilePicture
    ) {
      await deleteUserProfilePictureCache(image.userId);
    }

    if (image.postId) {
      await updatePostNsfwLevel(image.postId);
      // Without this, the showcase cache stays empty until its 24h TTL for any model version whose images hadn't scanned yet on first read.
      await bustCachesForPosts(image.postId);
    }
    await updateModel3DNsfwLevelForThumbnailImage({ imageId: image.id, postId: image.postId });
    await updateComicNsfwLevelsForImage(image.id);
    // Refresh the comic project in the search index — even on a clean
    // Scanned, `needsReview` may have been set, which the index treats
    // as a visibility gate.
    await queueComicsForPanelImage(image.id);

    await queueImageSearchIndexUpdate({
      ids: [image.id],
      action: SearchIndexUpdateQueueAction.Update,
    });

    const { audit, reviewKey } = outcome;
    if (audit) {
      const tagsForReview = [...audit.poiTags, ...audit.minorTags, ...audit.reviewTags];
      // Only persist review-tags when the image is actually queued for review
      // (matches the legacy `if (reviewKey)` gate).
      if (reviewKey && tagsForReview.length > 0) {
        await createImageTagsForReview({
          imageId: image.id,
          tagIds: tagsForReview.map((x) => x.id),
        });
      }

      if (!reviewKey && image.type === 'image') {
        await addToNewOrderQueue({ imageId: image.id, nsfw: audit.nsfw });
      }
    }
  }
}

const KONO_NSFW_SAMPLING_RATE = 0.3; // 30%
async function addToNewOrderQueue({ imageId, nsfw }: { imageId: number; nsfw: boolean }) {
  let shouldAddToQueue = true;
  let priority: 1 | 2 | 3 = 1;
  const rankType = NewOrderRankType.Knight;
  if (nsfw) {
    priority = 2;
    shouldAddToQueue = Math.random() < KONO_NSFW_SAMPLING_RATE;
  }
  if (shouldAddToQueue) {
    await addImageToQueue({
      imageIds: [imageId],
      rankType,
      priority,
    });
  }
}
