import { dbWrite } from '~/server/db/client';

type TagActivities = 'moderateTag' | 'disableTag' | 'addTag' | 'deleteTag';

type ModelModActivity = {
  entityType: 'model';
  activity: TagActivities | 'review' | 'moderateFlag';
};

type ModelVersionModActivity = {
  entityType: 'modelVersion';
  activity: TagActivities | 'review';
};

type ImageTagModActivity = {
  entityType: 'tag';
  activity: TagActivities;
};

export type ImageModActivity = {
  entityType: 'image';
  activity: TagActivities | 'review' | 'setNsfwLevel' | 'resolveAppeal' | 'setNsfwLevelKono';
};

type ArticleModActivity = {
  entityType: 'article';
  activity: TagActivities;
};

type ReportModActivity = {
  entityType: 'report';
  activity: 'review';
};

type ImpersonateModActivity = {
  entityType: 'impersonate';
  activity: 'on' | 'off'; // off is currently not used
};

type UserModActivity = {
  entityType: 'user';
  activity: 'setRewardsEligibility' | 'removeContent' | 'autoMuteScam';
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
  | ImpersonateModActivity
  | UserModActivity
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
