import poiWords from '~/utils/metadata/lists/words-poi.json';
import { getWorkflow, type WorkflowEvent } from '@civitai/client';
import type { NextApiRequest } from 'next';
import { dbWrite } from '~/server/db/client';
import { internalOrchestratorClient } from '~/server/services/orchestrator/common';
import { clickhouse } from '~/server/clickhouse/client';
import { env } from '~/env/server';
import type { TagType } from '~/shared/utils/prisma/enums';
import { ImageIngestionStatus, TagSource } from '~/shared/utils/prisma/enums';
import {
  BlockedReason,
  NsfwLevel,
  SearchIndexUpdateQueueAction,
  SignalMessages,
} from '~/server/common/enums';
import {
  auditMetaData,
  getTagsFromPrompt,
  includesInappropriate,
  includesPoi,
} from '~/utils/metadata/audit';
import { getComputedTags, getConditionalTagsForReview } from '~/server/utils/tag-rules';
import { getTagRules } from '~/server/services/system-cache';
import { TtlCache } from '~/server/utils/ttl-cache';
import { Prisma } from '@prisma/client';
import { insertTagsOnImageNew } from '~/server/services/tagsOnImageNew.service';
import { isDefined } from '~/utils/type-guards';
import { normalizeText } from '~/utils/normalize-text';
import { styleTags, tagsNeedingReview } from '~/libs/tags';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { isValidAIGeneration } from '~/utils/image-utils';
import { createImageTagsForReview } from '~/server/services/image-review.service';
import { tagIdsForImagesCache } from '~/server/redis/caches';
import type { MediaMetadata } from '~/server/schema/media.schema';
import { deleteUserProfilePictureCache } from '~/server/services/user.service';
import { updatePostNsfwLevel } from '~/server/services/post.service';
import { queueImageSearchIndexUpdate } from '~/server/services/image.service';
import { signalClient } from '~/utils/signal-client';

type WdTaggingStep = {
  $type: 'wdTagging';
  output: { tags: Record<string, number>; rating: Record<string, number> };
};
type MediaRatingStep = {
  $type: 'mediaRating';
  output: { nsfwLevel: string; isBlocked: boolean; blockedReason?: string };
};
type MediaHashStep = {
  $type: 'mediaHash';
  output: { hashes: { perceptual: string } };
};
type ScanResultStep = WdTaggingStep | MediaRatingStep | MediaHashStep;

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

const tagCache = new TtlCache<TagWithId>({});

export async function processImageScanResult(req: NextApiRequest) {
  const event: WorkflowEvent = req.body;

  const { data, error, request } = await getWorkflow({
    client: internalOrchestratorClient,
    path: { workflowId: event.workflowId },
  });
  if (!data) throw new Error(`could not find workflow: ${event.workflowId}`);

  const imageId = data.metadata?.imageId as number | undefined;
  if (!imageId) throw new Error(`missing workflow metadata.imageId - ${event.workflowId}`);

  if (event.status !== 'succeeded') {
    const image = await dbWrite.image.findUnique({
      where: { id: imageId },
      select: { id: true, scanJobs: true },
    });
    if (image) {
      const scanJobs = (image.scanJobs ?? {}) as { retryCount?: number };
      scanJobs.retryCount = scanJobs.retryCount ?? 0;
      scanJobs.retryCount++;

      await dbWrite.image.updateMany({
        where: { id: image.id },
        data: {
          ingestion: ImageIngestionStatus.Error,
          scanJobs: scanJobs as any,
        },
      });
    }
  } else {
    const steps = (data.steps ?? []) as unknown as ScanResultStep[];

    const wdTagging = steps.find((x) => x.$type === 'wdTagging')?.output;
    const mediaRating = steps.find((x) => x.$type === 'mediaRating')?.output;
    const mediaHash = steps.find((x) => x.$type === 'mediaHash')?.output;

    const missingSteps: string[] = [];
    if (!wdTagging) missingSteps.push('wdTagging');
    if (!mediaRating) missingSteps.push('mediaRating');
    if (!mediaHash) missingSteps.push('mediaHash');

    if (missingSteps.length > 0)
      throw new Error(
        `Incomplete workflow: ${event.workflowId}. Missing steps: ${missingSteps.join(', ')}`
      );

    const { tags: wdTags } = wdTagging!;
    // TODO - convert nsfwLevel from orchestrator format to tag format (pg13 to pg-13)
    const { nsfwLevel } = mediaRating!;
    let { isBlocked, blockedReason } = mediaRating!;
    const { hashes } = mediaHash!;

    const pHash = BigInt('0x' + hashes.perceptual);

    if (!isBlocked) {
      isBlocked = await getIsImageBlocked('0x' + hashes.perceptual);
      if (isBlocked) blockedReason = 'Similar to blocked content';
    }
    if (isBlocked) {
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
        scanJobs: true,
        ingestion: true,
      },
    });

    if (!image) throw new Error(`image not found: ${imageId}`);

    const { prompt, negativePrompt } = (image.meta ?? {}) as {
      prompt?: string;
      negativePrompt?: string;
    };

    // split tags into source groups
    const tagsWithSource = {
      [TagSource.WD14]: wdTags,
      [TagSource.SpineRating]: { [nsfwLevel]: 100 },
    };
    const normalizedTags: NormalizedTag[] = Object.entries(tagsWithSource).flatMap(
      ([source, tagMap]) =>
        Object.entries(tagMap).map(([name, confidence]) => {
          if (source === TagSource.WD14) name = name.replace(/_/g, ' ');
          return {
            name,
            confidence,
            source: source as TagSource,
          };
        })
    );

    // compute tags based on tag rules and prompt and then get tags with ids and create tags that don't exist
    const tags = await processTags({ tags: normalizedTags, prompt });

    // add tag relations to image
    await insertTagsOnImageNew(
      tags.map((tag) => ({
        imageId: image.id,
        tagId: tag.id,
        source: tag.source,
        confidence: tag.confidence,
        automated: true,
      }))
    );

    const audit = await auditScanResults({
      imageId: image.id,
      userId: image.userId,
      prompt,
      negativePrompt,
    });

    const validAiGeneration = isValidAIGeneration({ ...image, tags, meta: image.meta as any });

    const toUpdate: Prisma.ImageUpdateInput = {
      updatedAt: new Date(),
      pHash,
    };
    if (audit.blockedFor) {
      toUpdate.ingestion = ImageIngestionStatus.Blocked;
      toUpdate.blockedFor = audit.blockedFor;
    } else if (audit.nsfw && !validAiGeneration) {
      toUpdate.ingestion = ImageIngestionStatus.Blocked;
      toUpdate.blockedFor = BlockedReason.AiNotVerified;
    } else {
      toUpdate.ingestion = ImageIngestionStatus.Scanned;
      toUpdate.scannedAt = image.scannedAt ?? new Date();
      toUpdate.needsReview = audit.reviewKey ?? null;
      toUpdate.minor = audit.minor ?? null;
      toUpdate.poi = audit.poi ?? null;
      toUpdate.blockedFor = null;
    }

    await dbWrite.image.update({ where: { id: image.id }, data: toUpdate });

    if (toUpdate.ingestion === ImageIngestionStatus.Blocked) {
      await queueImageSearchIndexUpdate({
        ids: [image.id],
        action: SearchIndexUpdateQueueAction.Delete,
      });
    } else if (toUpdate.ingestion === ImageIngestionStatus.Scanned) {
      await tagIdsForImagesCache.refresh(image.id);
      if (
        typeof image.metadata === 'object' &&
        (image.metadata as MediaMetadata | undefined)?.profilePicture
      ) {
        await deleteUserProfilePictureCache(image.userId);
      }

      if (image.postId) await updatePostNsfwLevel(image.postId);

      await queueImageSearchIndexUpdate({
        ids: [image.id],
        action: SearchIndexUpdateQueueAction.Update,
      });

      const tagsForReview = [...audit.poiTags, ...audit.minorTags, ...audit.reviewTags];
      if (tagsForReview.length > 0) {
        await createImageTagsForReview({
          imageId: image.id,
          tagIds: tagsForReview.map((x) => x.id),
        });
      }
    }

    await signalClient.send({
      target: SignalMessages.ImageIngestionStatus,
      data: { imageId: image.id, ingestion: toUpdate.ingestion, blockedFor: toUpdate.blockedFor },
      userId: image.userId,
    });
  }
}

async function getIsImageBlocked(hash: string) {
  if (!env.BLOCKED_IMAGE_HASH_CHECK || !clickhouse) return false;

  const [{ count }] = await clickhouse.$query<{ count: number }>`
    SELECT cast(count() as int) as count
    FROM blocked_images
    WHERE bitCount(bitXor(hash, ${hash})) < 5 AND disabled = false
  `;

  return count > 0;
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
    if (realPersonName)
      normalized.push({
        name: realPersonName.toLowerCase(),
        confidence: 100,
        source: TagSource.Computed,
      });

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

  // TODO - handle ignore tags

  // De-dupe incoming tags and keep tag with highest confidence
  const tagMap: Record<string, NormalizedTag> = {};
  for (const tag of normalized) {
    if (!tagMap[tag.name] || tagMap[tag.name].confidence < tag.confidence) tagMap[tag.name] = tag;
  }
  const deduped: NormalizedTag[] = Object.values(tagMap);

  const { found, missing } = tagCache.getMany(deduped.map((x) => x.name));
  let queriedTags: TagWithId[] = [];
  if (missing.length > 0) {
    queriedTags = await dbWrite.tag.findMany({
      where: { name: { in: missing } },
      select: { id: true, name: true, nsfwLevel: true, type: true },
    });
    tagCache.setMany(queriedTags.map((data) => ({ key: data.name, data })));
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
    tagCache.setMany(createdTags.map((data) => ({ key: data.name, data })));
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

async function auditScanResults(args: {
  imageId: number;
  userId: number;
  prompt?: string;
  negativePrompt?: string;
}) {
  const prompt = normalizeText(args.prompt);
  const negativePrompt = normalizeText(args.negativePrompt);
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

  // TODO- refactor this method to reduce repeat prompt normalization and poi checks
  const inappropriate = includesInappropriate({ prompt, negativePrompt }, nsfw);
  if (inappropriate === 'minor') minorReview = true;
  if (inappropriate === 'poi') poiReview = true;

  const associatedEntities = await getAssociatedEntities(args.imageId);
  if (associatedEntities.poi) poiReview = true;
  if (associatedEntities.minor) minorReview = true;

  if (!minorReview && !poiReview && !tagReview && nsfw) {
    newUserReview = await getIsNewUser(args.userId);
  }

  const minor = minorTags.length > 0 || associatedEntities.minor;
  const poi = poiTags.length > 0 || associatedEntities.poi;

  let reviewKey: string | undefined;
  if (poiReview) reviewKey = 'poi';
  else if (minorReview) reviewKey = 'minor';
  else if (tagReview) reviewKey = 'tag';
  else if (newUserReview) reviewKey = 'newUser';

  let blockedFor: string | undefined;
  if (nsfw && prompt) {
    const auditResult = auditMetaData({ prompt }, nsfw);
    if (!auditResult.success)
      blockedFor = auditResult.blockedFor.join(', ') ?? 'Failed audit, no explanation';
  }

  return {
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
