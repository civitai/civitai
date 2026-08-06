import { dbWrite } from '~/server/db/client';

type TagActivities = 'moderateTag' | 'disableTag' | 'addTag' | 'deleteTag';

type ModelModActivity = {
  entityType: 'model';
  activity:
    | TagActivities
    | 'review'
    | 'moderateFlag'
    | 'setMinor'
    | 'unsetMinor'
    | 'setMinorAutoHash'
    | 'rollbackMinorAutoHash'
    | 'dismissMinorHashMatch';
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
  activity: TagActivities | 'ratingReview';
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

type ComicProjectModActivity = {
  entityType: 'comicProject';
  activity: 'tosViolation' | 'unpublishChapter' | 'setNsfwLevel';
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
  | ComicProjectModActivity
);

// `ON CONFLICT DO NOTHING` carries NO conflict target on purpose: a targetless clause is valid whether or
// not a unique index exists, so this survives the pending migration that drops ModActivity's
// (activity, entityType, entityId) unique index and makes the table append-only. Naming the target would
// fail with 42P10 the moment that index goes; omitting the clause entirely would fail with 23505 until it
// does. Do not add a target back.
export async function trackModActivity(userId: number, input: ModActivity) {
  if (!input.entityId) {
    await dbWrite.$executeRaw`
      INSERT INTO "ModActivity" ("userId", "entityType", activity)
      VALUES (${userId}, ${input.entityType}, ${input.activity})
      ON CONFLICT DO NOTHING
    `;
    return;
  }

  if (input.entityId && !Array.isArray(input.entityId)) input.entityId = [input.entityId];
  await dbWrite.$executeRaw`
    INSERT INTO "ModActivity" ("userId", "entityType", activity, "entityId")
    SELECT ${userId}, ${input.entityType}, ${input.activity}, UNNEST(${input.entityId})
    ON CONFLICT DO NOTHING
  `;
}
