import { poiWords } from '@civitai/mod-utils/prompt-audit/lists';
import { isMinorRestrictedLevel } from '@civitai/shared/minor-content-gate';
import { dbWrite } from '~/server/db/client';
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
  auditPostImageMeta,
  getTagsFromPrompt,
  includesInappropriate,
  includesPoi,
} from '~/utils/metadata/audit';
import { getComputedTags, getConditionalTagsForReview } from '~/server/utils/tag-rules';
import { getTagRules } from '~/server/services/system-cache';
import { Prisma } from '@prisma/client';
import { captureImageKeptSql, ownerHeld, ownerHeldSql } from '~/server/services/legal-hold.service';
import { insertTagsOnImageNew } from '~/server/services/tagsOnImageNew.service';
import { isDefined } from '~/utils/type-guards';
import { normalizeText } from '~/utils/normalize-text';
import { styleTags, tagsNeedingReview } from '~/libs/tags';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { createImageTagsForReview } from '~/server/services/image-review.service';
import {
  tagIdsForImagesCache,
  tagCacheByName,
  thumbnailCache,
  userImageVideoCountCaches,
} from '~/server/redis/caches';
import type { RedisKeyTemplateSys } from '~/server/redis/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { classifyImageScanFailure } from '~/server/services/image-scan-failure';
import type { MediaMetadata } from '~/server/schema/media.schema';
import {
  deleteUserProfilePictureCache,
  refreshProfilePicturesForImages,
} from '~/server/services/user.service';
import { bustCachesForPosts, updatePostNsfwLevel } from '~/server/services/post.service';
import {
  queueComicsForPanelImage,
  updateComicNsfwLevelsForImage,
  updateModel3DNsfwLevelForThumbnailImage,
} from '~/server/services/nsfwLevels.service';
import { getImagesModRules, queueImageSearchIndexUpdate } from '~/server/services/image.service';
import { getPendingAppealImageIds } from '~/server/services/image-appeal-flag';
import { hasBlockMarker } from '~/server/common/image-visibility';
import { judgeRatingFloorSql } from '~/server/common/judge-rating';
import { signalClient } from '~/utils/signal-client';
import { addImageToQueue } from '~/server/services/games/new-order.service';
import { logToAxiom } from '~/server/logging/client';
import {
  logShadowSexualPromptError,
  submitShadowSexualPromptScan,
} from '~/server/services/shadow-sexual-prompt.service';
import { evaluateRules } from '~/server/utils/mod-rules';
import { createNotification } from '~/server/services/notification.service';
import { decreaseDate } from '~/utils/date-helpers';
import { withRetries } from '~/utils/errorHandling';
import {
  FEEDBACK_CAPTURE_OWNER_ID,
  isFeedbackCaptureOwner,
} from '@civitai/shared/feedback-capture';

// Ingestion stages shared by the legacy (wdTagging + mediaRating) and imageScanning result handlers.

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

// TTL for a stashed job reason. Comfortably longer than the orchestrator's 10-min
// workflow expiry so the terminal workflow event can still read it.
const JOB_REASON_TTL_SECONDS = 15 * 60;

const jobReasonKey = (workflowId: string) =>
  `${REDIS_SYS_KEYS.WEBHOOKS.IMAGE_SCAN_JOB_REASON}:${workflowId}` as RedisKeyTemplateSys;

/** Orchestrator job-level event shape we care about (a subset of WorkflowStepJobEvent). */
export type OrchestratorJobEvent = {
  $type?: string;
  workflowId?: string;
  jobId?: string;
  reason?: string | null;
};

// Stash the job's failure `reason` keyed by workflowId. No DB/orchestrator round-trip:
// just a short-lived Redis write so the terminal workflow event can classify.
//
// Correlation contract: job events fire before the terminal workflow event, so the
// reason is stashed by the time the workflow event reads it. Across a workflow's
// several jobs this is last-write-wins (fine — image scans typically have one failing
// job; the reason strings we classify on are equivalent). If the reason is missing
// (race, or a job event that never arrived) the failure classifies as Unknown, which
// retries conservatively under the bounded cap — safe by construction. The TTL bounds
// a stash that never gets a following workflow event so it can't linger.
export async function captureJobFailureReason(event: OrchestratorJobEvent) {
  const workflowId = event.workflowId;
  const reason = typeof event.reason === 'string' ? event.reason.trim() : '';
  if (!workflowId || !reason) return;
  await sysRedis
    .set(jobReasonKey(workflowId), reason, { EX: JOB_REASON_TTL_SECONDS })
    .catch(() => null);
}

export async function readJobFailureReason(workflowId: string): Promise<string | null> {
  const reason = await sysRedis.get(jobReasonKey(workflowId)).catch(() => null);
  if (reason) sysRedis.del(jobReasonKey(workflowId)).catch(() => null);
  return reason ?? null;
}

/** Axiom `name`/`source` a pipeline's logs carry, so each pipeline can be queried alone. */
export type ScanLog = { name: string; source: string };
export const LEGACY_SCAN_LOG: ScanLog = {
  name: 'image-scan-result',
  source: 'image-scan-result.service',
};

/**
 * Push the resolved ingestion state to the uploader's open editor. The editor renders
 * Pending as an in-progress spinner, so any state that LEAVES Pending has to send —
 * Error included, retryable though it is — or the card goes on claiming to analyze
 * until the page is reloaded.
 */
export async function sendIngestionSignal({
  imageId,
  userId,
  ingestion,
  blockedFor,
  nsfwLevel,
  log = LEGACY_SCAN_LOG,
}: {
  imageId: number;
  userId: number | null;
  ingestion: ImageIngestionStatus;
  blockedFor?: string | null;
  nsfwLevel?: number;
  log?: ScanLog;
}) {
  if (!userId) return;
  await signalClient
    .send({
      target: SignalMessages.ImageIngestionStatus,
      data: { imageId, ingestion, blockedFor, nsfwLevel },
      userId,
    })
    .catch((error) =>
      logToAxiom(
        {
          name: log.name,
          type: 'warning',
          message: `signal send failed: ${
            error instanceof Error ? error.message : 'Unknown error'
          }`,
          imageId,
          source: log.source,
        },
        'webhooks'
      ).catch(() => null)
    );
}

// Blocked-content detection
// --------------------------------------------------
async function getIsImageBlocked(hash: bigint) {
  if (!env.BLOCKED_IMAGE_HASH_CHECK || !clickhouse) return false;

  const client = clickhouse;
  // $query has no retry of its own, and the observed failure is a dropped socket.
  const rows = await withRetries(
    () => client.$query<{ count: number }>`
      SELECT cast(count() as int) as count
      FROM blocked_images
      WHERE bitCount(bitXor(hash, ${hash})) < 5 AND disabled = false
    `,
    2,
    250
  );

  return (rows?.[0]?.count ?? 0) > 0;
}

export async function logPerceptualHashMatch({
  imageId,
  pHash,
  log = LEGACY_SCAN_LOG,
}: {
  imageId: number;
  pHash: bigint;
  log?: ScanLog;
}) {
  // Nothing branches on this result, so an exhausted retry must not fail the webhook and
  // discard a scan that already produced tags and a rating.
  const pHashBlocked = await getIsImageBlocked(pHash).catch((error) => {
    logToAxiom(
      {
        name: 'image-phash-match',
        type: 'warning',
        message: 'pHash blocklist check failed',
        imageId,
        error: error instanceof Error ? error.message : 'Unknown error',
        source: log.source,
      },
      'webhooks'
    ).catch(() => null);
    return false;
  });
  if (!pHashBlocked) return;

  // blockedReason = 'Similar to blocked content';
  logToAxiom(
    {
      name: 'image-phash-match',
      type: 'info',
      message: 'Image pHash matched a blocked image',
      imageId,
      pHash: pHash.toString(),
      source: log.source,
    },
    'webhooks'
  ).catch(() => null);
}

/**
 * Which orchestrator steps reported `failed`, by name (else `$type`). The workflow status
 * carries no reason, so this is the only way to tell a scan-step failure from a `hash` failure.
 */
export function extractFailedSteps(steps: unknown[]): string[] {
  return (steps as Array<{ name?: string; $type?: string; status?: string }>)
    .filter((step) => step?.status === 'failed')
    .map((step) => step.name ?? step.$type ?? 'unknown');
}

/**
 * Flip an image to `Error`, increment its scan `retryCount`, and stamp a small
 * `scanJobs.error = { status, failureType, failedSteps, reason, failureClass, at }`
 * so a plain Postgres query can tell WHY a scan errored (and which step) without an
 * orchestrator lookup — and so the `ingest-images` cron can pick a retry ceiling
 * from `failureClass`. retryCount ALWAYS increments: it's the absolute attempt
 * count the per-class ceilings are applied against. Returns the new (post-increment)
 * retryCount, the image's mediaType, and the computed failureClass; retryCount /
 * mediaType are `null` when no row matched (e.g. the image was deleted between scan
 * request and callback).
 */
export async function markImageScanError({
  workflowId,
  imageId,
  status,
  failureType,
  failedSteps,
  reason,
  middleware,
}: {
  workflowId: string;
  imageId: number;
  status: string;
  failureType: string;
  failedSteps: string[];
  /** Human failure reason from the job-level callback, if captured. */
  reason?: string | null;
  /** Orchestrator middleware locus, if known. Not exposed on the v2 job event today. */
  middleware?: string | null;
}): Promise<{
  retryCount: number | null;
  mediaType: string | null;
  userId: number | null;
  failureClass: string;
}> {
  const failureClass = classifyImageScanFailure({ reason, failureType, middleware, failedSteps });
  // undefined keys are dropped by JSON.stringify, so absent reason/middleware
  // simply don't appear in the stored blob.
  const errorJson = JSON.stringify({
    status,
    failureType,
    failedSteps,
    reason: reason ?? undefined,
    middleware: middleware ?? undefined,
    failureClass,
    at: new Date().toISOString(),
  });
  const rows = await dbWrite.$queryRaw<
    { retryCount: number | null; mediaType: string | null; userId: number | null }[]
  >`
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
    RETURNING ("scanJobs"->>'retryCount')::int as "retryCount", type as "mediaType",
      "userId"
  `;
  return {
    retryCount: rows[0]?.retryCount ?? null,
    mediaType: rows[0]?.mediaType ?? null,
    userId: rows[0]?.userId ?? null,
    failureClass,
  };
}

// Image loading
// --------------------------------------------------
export async function loadImageForScan(imageId: number) {
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
      blockedFor: true,
      needsReview: true,
    },
  });

  if (!image) throw new Error(`image not found: ${imageId}`);
  return image;
}
export type ScanImage = Awaited<ReturnType<typeof loadImageForScan>>;

// Tagging
// --------------------------------------------------
export async function buildAndInsertScanTags({
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
  promptKeywords = false,
}: {
  tags: NormalizedTag[];
  prompt?: string;
  /** Also derive tags from prompt keywords. They feed safety checks only, never the stored tags. */
  promptKeywords?: boolean;
}): Promise<ProcessedTag[]> {
  if (prompt) {
    // Strip moderator-whitelisted phrases first, or a whitelisted proper noun is written as a
    // confidence-100 POI tag that reaches the image search index.
    const realPersonName = includesPoi(
      // Normalized first, as both audit paths do. Stripping the raw text while the audit that
      // runs next reads the normalized copy means two different alphabets decide what counts
      // as whitelisted for the same prompt.
      await stripBenignPhrases(normalizeText(prompt), BlocklistType.PromptBenignPhrase)
    );
    if (realPersonName) {
      const tagName =
        typeof realPersonName === 'object' ? realPersonName.matchedText : realPersonName;
      normalized.push({
        name: tagName.toLowerCase(),
        confidence: 100,
        source: TagSource.Computed,
      });
    }

    const promptTags = promptKeywords && getTagsFromPrompt(prompt);
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

    // Raw SQL bypasses Prisma's @updatedAt stamp, and neither column has a DB
    // default — both are NOT NULL, so omitting either raises 23502.
    const now = new Date();
    const values = tagsToInsert.map(
      (tag) => Prisma.sql`(${tag.name}, ${now}, ARRAY['Image']::"TagTarget"[])`
    );

    createdTags = await dbWrite.$queryRaw<TagWithId[]>`
      INSERT INTO "Tag" (name, "updatedAt", target)
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
export type ScanOutcome = {
  ingestion: ImageIngestionStatus;
  /** The level the row was written with; absent when the short-circuit left the row's level alone. */
  nsfwLevel?: number;
  blockedFor: string | null;
  reviewKey: string | null;
  /** Present only when the image was audited (i.e. not the `blocked` short-circuit). */
  audit?: Awaited<ReturnType<typeof auditScanResults>>;
};

/** Whether the owner is held or a hold kept the image. A read that fails counts as held. */
function isBlockKeptByHold(imageId: number) {
  return ownerHeld(
    dbWrite,
    Prisma.sql`FROM "Image" m WHERE m.id = ${imageId}`,
    Prisma.sql`(${ownerHeldSql(Prisma.raw('m."userId"'))}
      OR EXISTS (SELECT 1 FROM "EvidenceHoldImage" k WHERE k."imageId" = m.id)
      OR ${captureImageKeptSql('m')})`
  );
}

/**
 * Resolve and persist the final state of the image row, returning the bits the
 * post-update side effects need. Three terminal shapes:
 *  - `blocked` (legacy mediaRating hard block, already written by the caller): only
 *    stamp provenance — re-auditing would recompute nsfwLevel/ingestion and silently
 *    un-block the image. A *prior* block is deliberately not sticky, so a moderator
 *    rescan can clear it, unless the owner is banned or held, a hold kept the image, or the
 *    image is under appeal.
 *    imageScanning never passes `blocked`, so on that path only `audit.blockedFor` and
 *    moderation rules re-block.
 *  - `audit.blockedFor` (prompt TOS/CSAM): block.
 *  - otherwise: Scanned, with moderation rules applied last so a rule Block/Hold
 *    takes precedence over the audit decision.
 */
export async function resolveScanOutcome({
  image,
  blocked,
  pHash,
  workflowId,
  prompt,
  negativePrompt,
  log = LEGACY_SCAN_LOG,
}: {
  image: ScanImage;
  blocked?: { reason: string | null };
  pHash?: bigint;
  workflowId: string;
  prompt?: string;
  negativePrompt?: string;
  log?: ScanLog;
}): Promise<ScanOutcome> {
  const updatedAt = new Date();

  if (blocked) {
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
      blockedFor: blocked.reason,
      reviewKey: null,
    };
  }

  // A collection judge's floor, read before the audit so its checks run at the level the image
  // will be written at, not only the level its tags carry.
  const [floorRow] = await dbWrite.$queryRaw<{ judgeFloor: number }[]>`
    SELECT ${judgeRatingFloorSql()} AS "judgeFloor" FROM "Image" WHERE id = ${image.id}
  `;
  const audit = await auditScanResults({
    imageId: image.id,
    userId: image.userId,
    prompt,
    negativePrompt,
    floorLevel: typeof floorRow?.judgeFloor === 'number' ? floorRow.judgeFloor : 0,
  });
  let reviewKey = audit.reviewKey ?? null;

  const toUpdate: Prisma.ImageUpdateInput = { updatedAt, pHash };
  // Set before the verdict: a block that dropped minor/poi would leave a later-unblocked image unflagged.
  toUpdate.minor = audit.minor;
  toUpdate.poi = audit.poi;

  const now = new Date();
  if (!image.scannedAt) toUpdate.scannedAt = now;
  else if (
    !(image.metadata as any)?.skipScannedAtReassignment &&
    image.ingestion !== 'Rescan' &&
    new Date(image.createdAt).getTime() >= decreaseDate(now, 7, 'days').getTime()
  )
    toUpdate.scannedAt = now;
  else toUpdate.scannedAt = image.scannedAt;

  if (audit.blockedFor) {
    // A block outranks a locked rating: it is a ToS decision, not a rating.
    toUpdate.ingestion = ImageIngestionStatus.Blocked;
    toUpdate.blockedFor = audit.blockedFor;
    toUpdate.nsfwLevel = NsfwLevel.Blocked;
  } else {
    toUpdate.ingestion = ImageIngestionStatus.Scanned;
    toUpdate.needsReview = reviewKey;
    toUpdate.blockedFor = null;
    // Respect a manually-locked nsfw level — never overwrite it from the scan.
    toUpdate.nsfwLevel = image.nsfwLevelLocked ? image.nsfwLevel : audit.nsfwLevel;
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
        log,
      });
    }
  }

  // The appeal is the open decision on this image's block: a scan may tighten it, never lift it.
  // A rescan request may already have cleared `ingestion` and `blockedFor`; it leaves the Blocked level.
  if ((await getPendingAppealImageIds([image.id])).size) {
    toUpdate.needsReview = 'appeal';
    reviewKey = 'appeal';
    if (hasBlockMarker(image) && toUpdate.ingestion !== ImageIngestionStatus.Blocked) {
      toUpdate.ingestion = ImageIngestionStatus.Blocked;
      toUpdate.blockedFor = image.blockedFor ?? BlockedReason.Moderated;
      toUpdate.nsfwLevel = NsfwLevel.Blocked;
    }
  }

  // This review flag outranks an appeal and is only ever lifted by a moderator, never by a scan. The
  // SET re-checks the stored value for a flag that lands after the image was loaded.
  if (image.needsReview === 'csam') {
    toUpdate.needsReview = 'csam';
    reviewKey = 'csam';
  }

  // A block on a banned or held owner's image, or on one a hold kept, is that decision, not a stale
  // automated one, so a scan never lifts it. Read fresh, not from `image`: the ban or hold can block
  // the row after this scan loaded it.
  if (toUpdate.ingestion !== ImageIngestionStatus.Blocked) {
    const [current] = await dbWrite.$queryRaw<
      {
        ingestion: ImageIngestionStatus;
        blockedFor: string | null;
        nsfwLevel: number;
        ownerBanned: boolean;
      }[]
    >`
      SELECT i.ingestion, i."blockedFor", i."nsfwLevel", u."bannedAt" IS NOT NULL AS "ownerBanned"
      FROM "Image" i
      JOIN "User" u ON u.id = i."userId"
      WHERE i.id = ${image.id}
    `;
    if (
      current &&
      hasBlockMarker(current) &&
      (current.ownerBanned || (await isBlockKeptByHold(image.id)))
    ) {
      toUpdate.ingestion = ImageIngestionStatus.Blocked;
      toUpdate.blockedFor = current.blockedFor ?? BlockedReason.Moderated;
      toUpdate.nsfwLevel = NsfwLevel.Blocked;
    }
  }

  const scanLevel = toUpdate.nsfwLevel as number;
  // The rule's keys, merged over the stored row so no other key is replaced.
  const metadataJson = metadataUpdate ? JSON.stringify(metadataUpdate) : null;
  await dbWrite.$executeRaw`
    UPDATE "Image"
    SET
      "updatedAt" = ${toUpdate.updatedAt},
      "pHash" = ${pHash ?? null},
      "ingestion" = ${toUpdate.ingestion as string}::"ImageIngestionStatus",
      "blockedFor" = ${(toUpdate.blockedFor as string) ?? null},
      "nsfwLevel" = ${scanLevel},
      "needsReview" = CASE WHEN "needsReview" = 'csam' THEN 'csam'
        ELSE ${(toUpdate.needsReview as string) ?? null} END,
      "minor" = ${(toUpdate.minor as boolean) ?? false},
      "poi" = ${(toUpdate.poi as boolean) ?? false},
      "scannedAt" = ${(toUpdate.scannedAt as Date) ?? null},
      "metadata" = CASE WHEN ${metadataJson}::jsonb IS NULL THEN "metadata"
        ELSE COALESCE("metadata", '{}'::jsonb) || ${metadataJson}::jsonb END,
      "scanJobs" = jsonb_set(COALESCE("scanJobs", '{}'), '{workflowId}', ${JSON.stringify(
        workflowId
      )}::jsonb)
    WHERE id = ${image.id}
  `;

  // A collection judge's rating is a floor under an unlocked, unblocked level. Read from the row
  // after the write above, so a rating that landed after this scan loaded the image still holds; the
  // judge write takes the greater level too, so either order ends at the higher of the two. A floor
  // above the level the audit ran at sends the image back for a rescan, so its checks run there.
  let nsfwLevel = scanLevel;
  let ingestion = toUpdate.ingestion as ImageIngestionStatus;
  if (scanLevel !== NsfwLevel.Blocked && !image.nsfwLevelLocked) {
    const floor = judgeRatingFloorSql();
    const rescan = Prisma.sql`(${floor} > ${audit.checkedLevel}::int AND ${floor} > ${sfwBrowsingLevelsFlag}::int)`;
    try {
      const [raised] = await dbWrite.$queryRaw<
        { nsfwLevel: number; ingestion: ImageIngestionStatus }[]
      >`
        UPDATE "Image" SET
          -- A rescan keeps the level until its checks have run at the floor; it applies it then.
          "nsfwLevel" = CASE WHEN ${rescan} THEN "nsfwLevel" ELSE ${floor} END,
          ingestion = CASE WHEN ${rescan} THEN ${ImageIngestionStatus.Rescan}::"ImageIngestionStatus"
            ELSE ingestion END,
          "needsReview" = CASE
            WHEN "needsReview" IN ('csam', 'appeal') THEN "needsReview"
            WHEN ("scanJobs"->'hasMinor')::boolean AND ${floor} > 1 AND ${floor} < ${NsfwLevel.Blocked}
            THEN 'minor'
            ELSE "needsReview"
          END
        WHERE id = ${image.id}
          AND NOT "nsfwLevelLocked"
          AND ingestion != ${ImageIngestionStatus.Blocked}::"ImageIngestionStatus"
          AND "blockedFor" IS NULL
          AND "nsfwLevel" != ${NsfwLevel.Blocked}
          AND ${floor} > "nsfwLevel"
        RETURNING "nsfwLevel", ingestion
      `;
      if (typeof raised?.nsfwLevel === 'number') {
        nsfwLevel = raised.nsfwLevel;
        ingestion = raised.ingestion;
      }
    } catch (error) {
      // The verdict above has landed; a failure here must not turn it into a scan error. Where the
      // floor sits above the level the checks ran at, the image is still sent back for a rescan (a
      // queue row alone is pruned for a Scanned image; the Rescan state queues it).
      logToAxiom({
        type: 'error',
        name: 'scan-judge-floor',
        imageId: image.id,
        message: (error as Error).message,
      }).catch(() => null);
      await dbWrite.$executeRaw`
        UPDATE "Image" SET ingestion = ${ImageIngestionStatus.Rescan}::"ImageIngestionStatus"
        WHERE id = ${image.id}
          AND ingestion = ${ImageIngestionStatus.Scanned}::"ImageIngestionStatus"
          AND NOT "nsfwLevelLocked"
          AND "blockedFor" IS NULL
          AND "needsReview" IS NULL
          AND ${rescan}
      `.catch(() => null);
      await dbWrite.$executeRaw`
        INSERT INTO "JobQueue" (type, "entityType", "entityId")
        VALUES ('ImageScan'::"JobQueueType", 'Image'::"EntityType", ${image.id})
        ON CONFLICT DO NOTHING
      `.catch(() => null);
    }
  }

  return {
    ingestion,
    nsfwLevel,
    blockedFor: (toUpdate.blockedFor as string) ?? null,
    reviewKey,
    audit,
  };
}

type AuditTag = {
  id: number;
  name: string;
  type?: TagType;
  nsfwLevel: number;
  confidence: number;
  source: TagSource;
};

async function withPromptKeywordTags(tags: AuditTag[], prompt?: string): Promise<AuditTag[]> {
  if (!prompt) return tags;
  const derived = await processTags({
    tags: tags
      .filter((tag) => tag.source !== TagSource.Computed)
      .map(({ name, confidence, source }) => ({ name, confidence, source })),
    prompt,
    promptKeywords: true,
  });
  const present = new Set(tags.map((tag) => tag.id));
  return [
    ...tags,
    ...derived
      .filter((tag) => !present.has(tag.id))
      .map(({ id, name, type, nsfwLevel, confidence, source }) => ({
        id,
        name,
        type,
        nsfwLevel,
        confidence,
        source,
      })),
  ];
}

/** Log event for an unrated scan that would take the newer minor review routing. */
export const UNRATED_MINOR_REVIEW_EVENT = 'unrated-minor-review-candidate';

async function auditScanResults(args: {
  imageId: number;
  userId: number;
  prompt?: string;
  negativePrompt?: string;
  /** A collection judge's level: every check below runs at no less than it. */
  floorLevel?: number;
}) {
  // Moderator-managed benign phrases (proper nouns / technical terms that coincidentally
  // contain a detection token) are blanked up front so every downstream check — minor,
  // poi, blockedFor — sees the same cleaned text. A benign phrase is innocent content, so
  // it shouldn't feed any detector.
  const [prompt, negativePrompt] = await Promise.all([
    stripBenignPhrases(normalizeText(args.prompt), BlocklistType.PromptBenignPhrase),
    stripBenignPhrases(normalizeText(args.negativePrompt), BlocklistType.NegativeBenignPhrase),
  ]);
  const imageTags = await dbWrite.$queryRaw<AuditTag[]>`
    SELECT t.id, t.name, t."nsfwLevel", toi.confidence, toi.source
    FROM "TagsOnImageDetails" toi
    JOIN "Tag" t ON t.id = toi."tagId"
    WHERE toi."imageId" = ${args.imageId} AND toi.automated AND NOT toi.disabled
  `;
  const ratingLevel = Math.max(...[...imageTags.map((x) => x.nsfwLevel), 0]);
  // Prompt keywords no longer rate the image, but every check below still reads them, so no image
  // is checked less than when they did.
  const tags = await withPromptKeywordTags(imageTags, args.prompt);
  const nsfwLevel = Math.max(...[...tags.map((x) => x.nsfwLevel), 0], args.floorLevel ?? 0);
  const nsfw = nsfwLevel > sfwBrowsingLevelsFlag;
  const minorTags = tags.filter((tag) => tagsNeedingReview.includes(tag.name.toLowerCase()));
  const poiTags = tags.filter((tag) => poiWords.includes(tag.name.toLowerCase()));
  const reviewTags = [
    ...tags.filter((tag) => tag.nsfwLevel === NsfwLevel.Blocked),
    ...getConditionalTagsForReview(tags, nsfwLevel),
  ];
  const adultTags = tags.filter((tag) => tag.name === 'adult');
  const cartoonTags = tags.filter((tag) => styleTags.includes(tag.name));

  // An unrated scan keeps its earlier minor review routing for now: the minor content rule's
  // unrated arm does not reach this queue yet.
  const minorRestrictedScan = nsfwLevel !== 0 && isMinorRestrictedLevel(nsfwLevel);

  const tagReview = reviewTags.length > 0;
  let poiReview = poiTags.length > 0;
  let minorReview =
    minorTags.length > 0 &&
    adultTags.length === 0 &&
    (cartoonTags.length === 0 || minorRestrictedScan);
  let newUserReview = false;

  const inappropriate = includesInappropriate({ prompt, negativePrompt }, nsfw);
  if (inappropriate === 'minor') minorReview = true;
  if (inappropriate === 'poi') poiReview = true;

  const associatedEntities = await getAssociatedEntities(args.imageId);
  // Associated poi/minor resources only escalate to review when the image is
  // nsfw — a sfw image with a poi/minor resource is still flagged (below) but
  // not queued for moderator review.
  if (associatedEntities.poi && nsfw) poiReview = true;
  if (associatedEntities.minor && minorRestrictedScan) minorReview = true;

  // Log, without routing, when an unrated scan would take the newer minor review routing.
  if (nsfwLevel === 0 && !minorReview && !poiReview) {
    const arms = [
      ...(associatedEntities.minor ? ['resource'] : []),
      ...(minorTags.length > 0 && adultTags.length === 0 ? ['tag'] : []),
    ];
    for (const arm of arms)
      logToAxiom({
        name: UNRATED_MINOR_REVIEW_EVENT,
        type: 'info',
        imageId: args.imageId,
        arm,
        at: new Date().toISOString(),
      }).catch(() => null);
  }

  // The capture account is no one's new account: its captures get only the content keys.
  if (!minorReview && !poiReview && !tagReview && nsfw && !isFeedbackCaptureOwner(args.userId)) {
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
    // The post editor's own verdict, so the scan never blocks what the editor let through.
    const auditResult = auditPostImageMeta({ prompt }, nsfw);
    if (!auditResult.success)
      blockedFor = auditResult.blockedFor.join(',') ?? 'Failed audit, no explanation';
    else if (auditResult.softBlockedFor?.length)
      logToAxiom({
        name: 'image-prompt-soft-block-pass',
        type: 'info',
        userId: args.userId,
        imageId: args.imageId,
        details: {
          triggers: auditResult.softBlockedFor.map((word) => ({
            category: 'nsfw_blocklist',
            matchedWord: word,
          })),
        },
      }).catch(() => null);
  }

  return {
    tags,
    nsfwLevel: ratingLevel,
    /** The level the checks above ran at. */
    checkedLevel: nsfwLevel,
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
    // Only the rule's keys: the write merges them over the stored row.
    metadata: {
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
  log,
}: {
  imageId: number;
  userId: number;
  reason?: string | null;
  log: ScanLog;
}) {
  if (isFeedbackCaptureOwner(userId)) return;
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
      name: log.name,
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
export async function applyIngestionSideEffects({
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
    await refreshProfilePicturesForImages([image.id]);
    return;
  }

  // handle scanned image updates
  if (outcome.ingestion === ImageIngestionStatus.Scanned) {
    // Scanning is what makes an already-published image countable. Bust rather
    // than refresh: this fires once per image, so a re-query here would be N
    // identical counts for an N-image post.
    await userImageVideoCountCaches.bust(image.userId);
    await tagIdsForImagesCache.refresh(image.id);
    // A custom video thumbnail is cached under its video with this scan's level. The refresh in
    // insertTagsOnImageNew runs before the final nsfwLevel write, so it can cache the old one.
    const thumbnailParentId = (image.metadata as { parentId?: number } | null)?.parentId;
    if (thumbnailParentId) await thumbnailCache.refresh(thumbnailParentId);
    if (
      typeof image.metadata === 'object' &&
      (image.metadata as MediaMetadata | undefined)?.profilePicture
    ) {
      await deleteUserProfilePictureCache(image.userId);
    } else {
      // A rescan of an image picked as an avatar after its upload can change its rating too.
      await refreshProfilePicturesForImages([image.id]);
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

    // Not awaited, and never allowed to throw: the shadow must not fail or slow ingestion.
    try {
      submitShadowSexualPromptScan({
        ...image,
        nsfwLevel: outcome.nsfwLevel ?? image.nsfwLevel,
      }).catch((e) => logShadowSexualPromptError(e, image.id));
    } catch (e) {
      logShadowSexualPromptError(e, image.id);
    }

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

      if (!reviewKey && image.type === 'image' && image.userId !== FEEDBACK_CAPTURE_OWNER_ID) {
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
