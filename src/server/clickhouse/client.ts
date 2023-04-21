import { createClient } from '@clickhouse/client';
import { env } from '~/env/server.mjs';
import requestIp from 'request-ip';
import { NextApiRequest } from 'next';

export const clickhouse = createClient({
  host: env.CLICKHOUSE_HOST,
  username: env.CLICKHOUSE_USERNAME,
  password: env.CLICKHOUSE_PASSWORD,
});

export type ViewType = 'ProfileView' | 'ImageView' | 'PostView' | 'ModelView' | 'ModelVersionView';
export type EntityType = 'User' | 'Image' | 'Post' | 'Model' | 'ModelVersion';

export type UserActivityType =
  | 'Registration'
  | 'Account closure'
  | 'Subscribe'
  | 'Cancel'
  | 'Donate'
  | 'Adjust Moderated Content Settings'
  | 'Banned'
  | 'Unbanned'
  | 'Muted'
  | 'Unmuted';
export type ModelVersionActivty = 'Create' | 'Publish' | 'Download' | 'Unpublish';
export type ModelActivty =
  | 'Create'
  | 'Publish'
  | 'Update'
  | 'Unpublish'
  | 'Archive'
  | 'Takedown'
  | 'Delete'
  | 'PermanentDelete';
export type ResourceReviews = 'Create' | 'Deleted';
export type Reactions =
  | 'Images_Create'
  | 'Images_Delete'
  | 'Commen_Create'
  | 'Comment_Delete'
  | 'Review_Create'
  | 'Review_Delete'
  | 'Question_Create'
  | 'Question_Delete'
  | 'Answer_Create'
  | 'Answer_Delete';
export type Reports = 'Create' | 'StatusChange';
export type ModelEngagement = 'Hide' | 'Favorite';
export type TagEngagement = 'Hide' | 'Allow';
export type UserEngagements = 'Follow' | 'Hide';
export type Comments = 'Model' | 'Image' | 'Post' | 'Comment' | 'Review';
export type PostActivities = 'Create' | 'Publish' | 'Tags';
export type ImageActivities = 'Create' | 'Delete' | 'DeleteTOS' | 'Tags' | 'Resources';
export type Questions = 'Create' | 'Delete';
export type Answers = 'Create' | 'Delete';

export async function trackView(
  req: NextApiRequest,
  type: ViewType,
  entityType: EntityType,
  entityId: number
) {
  const ip = requestIp.getClientIp(req);
  const userAgent = req.headers['user-agent'];

  clickhouse.insert({
    table: 'views',
    values: [
      {
        type,
        userId: 0, // todo:
        entityType,
        entityId,
        ip,
        userAgent,
      },
    ],
    format: 'JSONEachRow',
  });
}
