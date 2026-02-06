import type { Prisma } from '@prisma/client';
import dayjs from '~/shared/utils/dayjs';
import { dbRead, dbWrite } from '~/server/db/client';
import { dailyChallengeConfig } from '~/server/games/daily-challenge/daily-challenge.utils';
import {
  ChallengeSource,
  ChallengeStatus,
  CollectionMode,
  CollectionReadConfiguration,
  CollectionWriteConfiguration,
} from '~/shared/utils/prisma/enums';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

type ArticleChallenge = {
  articleId: number;
  title: string;
  content: string;
  coverId: number | null;
  userId: number;
  publishedAt: Date | null;
  modelId: number | null;
  resourceUserId: number | null;
  collectionId: number | null;
  theme: string | null;
  invitation: string | null;
  challengeDate: Date | null;
  status: string | null;
  prizes: string | null;
  entryPrize: string | null;
  entryPrizeRequirement: number | null;
};

async function migrateChallenge(
  article: ArticleChallenge
): Promise<'migrated' | 'skipped' | 'failed'> {
  try {
    // Check if already migrated
    const existing = await dbRead.challenge.findFirst({
      where: {
        metadata: {
          path: ['articleId'],
          equals: article.articleId,
        },
      },
    });

    if (existing) return 'skipped';

    // Skip if no collection - collectionId is required
    if (!article.collectionId) return 'skipped';

    // Parse and normalize prizes to ensure { buzz, points } shape
    const rawPrizes = article.prizes ? JSON.parse(article.prizes) : dailyChallengeConfig.prizes;
    const prizes = (rawPrizes as any[]).map((p: any) => ({
      buzz: p.buzz ?? 0,
      points: p.points ?? 0,
    }));

    const rawEntryPrize = article.entryPrize
      ? JSON.parse(article.entryPrize)
      : dailyChallengeConfig.entryPrize;
    const entryPrize = { buzz: rawEntryPrize.buzz ?? 0, points: rawEntryPrize.points ?? 0 };

    const entryPrizeRequirement =
      article.entryPrizeRequirement ?? dailyChallengeConfig.entryPrizeRequirement;

    // Determine status using date-based logic
    const challengeDate = article.challengeDate ?? article.publishedAt ?? new Date();
    let status: ChallengeStatus;
    if (article.status === 'complete') {
      status = ChallengeStatus.Completed;
    } else if (article.status === 'active') {
      status = ChallengeStatus.Active;
    } else if (dayjs(challengeDate).add(1, 'day').isBefore(dayjs())) {
      status = ChallengeStatus.Completed;
    } else if (dayjs(challengeDate).isBefore(dayjs())) {
      status = ChallengeStatus.Active;
    } else {
      status = ChallengeStatus.Scheduled;
    }

    // Calculate dates
    const startsAt = challengeDate;
    const endsAt = dayjs(challengeDate).add(1, 'day').toDate();
    const visibleAt = challengeDate;

    const maxItemsPerUser = entryPrizeRequirement * 2;

    // Get model version IDs for the model (if modelId exists)
    let modelVersionIds: number[] = [];
    if (article.modelId) {
      const versions = await dbRead.$queryRaw<{ id: number }[]>`
        SELECT mv.id
        FROM "ModelVersion" mv
        WHERE mv."modelId" = ${article.modelId}
        AND mv.status = 'Published'
        ORDER BY mv.index ASC
      `;
      modelVersionIds = versions.map((v) => v.id);
    }

    // Create Challenge record
    const challenge = await dbWrite.challenge.create({
      data: {
        startsAt,
        endsAt,
        visibleAt,
        title: article.title,
        description: article.content,
        theme: article.theme,
        invitation: article.invitation,
        coverImageId: article.coverId,
        nsfwLevel: 1,
        allowedNsfwLevel: 1,
        modelVersionIds,
        collectionId: article.collectionId,
        maxEntriesPerUser: maxItemsPerUser,
        entryPrizeRequirement,
        prizes: prizes as Prisma.InputJsonValue,
        entryPrize: entryPrize as Prisma.InputJsonValue,
        prizePool: prizes.reduce((sum, p) => sum + p.buzz, 0),
        createdById: article.userId,
        judgeId: dailyChallengeConfig.defaultJudgeId,
        source: ChallengeSource.System,
        status,
        metadata: {
          articleId: article.articleId,
          resourceModelId: article.modelId,
          resourceUserId: article.resourceUserId,
          challengeType: 'world-morph',
          migratedAt: new Date().toISOString(),
        } as Prisma.InputJsonValue,
      },
      select: { id: true },
    });

    // Update associated collection to Contest mode
    await dbWrite.collection.update({
      where: { id: article.collectionId },
      data: {
        mode: CollectionMode.Contest,
        read: CollectionReadConfiguration.Public,
        write:
          status === ChallengeStatus.Active
            ? CollectionWriteConfiguration.Review
            : CollectionWriteConfiguration.Private,
        metadata: {
          modelId: article.modelId,
          maxItemsPerUser,
          endsAt,
          disableTagRequired: true,
          disableFollowOnSubmission: true,
        },
      },
    });

    console.log(
      `Migrated challenge: articleId=${article.articleId} -> challengeId=${challenge.id}`
    );
    return 'migrated';
  } catch (error) {
    const err = error as Error;
    console.error(`Failed to migrate challenge articleId=${article.articleId}: ${err.message}`);
    return 'failed';
  }
}

async function migrateActiveChallenge() {
  const articles = await dbRead.$queryRaw<ArticleChallenge[]>`
    SELECT
      a.id as "articleId",
      a.title,
      a.content,
      a."coverId",
      a."userId",
      a."publishedAt",
      cast(a.metadata->'modelId' as int) as "modelId",
      cast(a.metadata->'userId' as int) as "resourceUserId",
      cast(a.metadata->'collectionId' as int) as "collectionId",
      (a.metadata->>'theme') as theme,
      (a.metadata->>'invitation') as invitation,
      (a.metadata->>'challengeDate')::timestamp as "challengeDate",
      (a.metadata->>'status') as status,
      (a.metadata->'prizes')::text as prizes,
      (a.metadata->'entryPrize')::text as "entryPrize",
      (a.metadata->>'entryPrizeRequirement')::int as "entryPrizeRequirement"
    FROM "CollectionItem" ci
    JOIN "Article" a ON a.id = ci."articleId"
    WHERE ci."collectionId" = ${dailyChallengeConfig.challengeCollectionId}
      AND (a.metadata->>'status') = 'active'
    ORDER BY a."publishedAt" DESC NULLS LAST
    LIMIT 1
  `;

  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  for (const article of articles) {
    const result = await migrateChallenge(article);
    if (result === 'migrated') migrated++;
    else if (result === 'skipped') skipped++;
    else failed++;
  }

  return { migrated, skipped, failed, total: articles.length };
}

export default WebhookEndpoint(async (req, res) => {
  const result = await migrateActiveChallenge();
  res.status(200).json(result);
});
