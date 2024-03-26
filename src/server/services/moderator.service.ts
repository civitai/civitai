import { dbWrite } from '~/server/db/client';

type TagActivities = 'moderateTag' | 'disableTag' | 'addTag' | 'deleteTag';

type ModelModActivity = {
  entityType: 'model';
  activity: TagActivities | 'review';
};

type ModelVersionModActivity = {
  entityType: 'modelVersion';
  activity: TagActivities | 'review';
};

type ImageTagModActivity = {
  entityType: 'tag';
  activity: TagActivities;
};

type ImageModActivity = {
  entityType: 'image';
  activity: TagActivities | 'review' | 'setNsfwLevel';
};

type ArticleModActivity = {
  entityType: 'article';
  activity: TagActivities;
};

type ReportModActivity = {
  entityType: 'report';
  activity: 'review';
};

type ModActivity = {
  entityId?: number | number[];
} & (
  | ModelModActivity
  | ModelVersionModActivity
  | ImageTagModActivity
  | ImageModActivity
  | ReportModActivity
  | ArticleModActivity
);

export async function trackModActivity(userId: number, input: ModActivity) {
  if (!input.entityId) {
    await dbWrite.$executeRaw`
      INSERT INTO "ModActivity" ("userId", "entityType", activity)
      VALUES (${userId}, ${input.entityType}, ${input.activity})
      ON CONFLICT ("entityType", activity, "entityId") DO UPDATE SET "createdAt" = NOW(), "userId" = ${userId}
    `;
    return;
  }

  if (input.entityId && !Array.isArray(input.entityId)) input.entityId = [input.entityId];
  await dbWrite.$executeRaw`
    INSERT INTO "ModActivity" ("userId", "entityType", activity, "entityId")
    SELECT ${userId}, ${input.entityType}, ${input.activity}, UNNEST(${input.entityId})
    ON CONFLICT ("entityType", activity, "entityId") DO UPDATE SET "createdAt" = NOW(), "userId" = ${userId}
  `;
}
