import { poiWords } from '@civitai/mod-utils/prompt-audit/lists';
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
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { createImageTagsForReview } from '~/server/services/image-review.service';
import {
  tagIdsForImagesCache,
  tagCacheByName,
  userImageVideoCountCaches,
} from '~/server/redis/caches';
import type { RedisKeyTemplateSys } from '~/server/redis/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { classifyImageScanFailure } from '~/server/services/image-scan-failure';
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
import { logToAxiom } from '~/server/logging/client';
import { evaluateRules } from '~/server/utils/mod-rules';
import { createNotification } from '~/server/services/notification.service';
import { decreaseDate } from '~/utils/date-helpers';
import { withRetries } from '~/utils/errorHandling';

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
  log = LEGACY_SCAN_LOG,
}: {
  imageId: number;
  userId: number | null;
  ingestion: ImageIngestionStatus;
  blockedFor?: string | null;
  log?: ScanLog;
}) {
  if (!userId) return;
  await signalClient
    .send({
      target: SignalMessages.ImageIngestionStatus,
      data: { imageId, ingestion, blockedFor },
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
}: {
  tags: NormalizedTag[];
  prompt?: string;
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
  blockedFor: string | null;
  reviewKey: string | null;
  /** Present only when the image was audited (i.e. not the `blocked` short-circuit). */
  audit?: Awaited<ReturnType<typeof auditScanResults>>;
};

/**
 * Resolve and persist the final state of the image row, returning the bits the
 * post-update side effects need. Three terminal shapes:
 *  - `blocked` (legacy mediaRating hard block, already written by the caller): only
 *    stamp provenance — re-auditing would recompute nsfwLevel/ingestion and silently
 *    un-block the image. A *prior* block is deliberately not sticky, so a moderator
 *    rescan can clear it. imageScanning never passes `blocked`, so on that path only
 *    `audit.blockedFor` and moderation rules re-block.
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
        log,
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
  log,
}: {
  imageId: number;
  userId: number;
  reason?: string | null;
  log: ScanLog;
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
