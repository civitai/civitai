import { createClient } from '@clickhouse/client';
import { env } from '~/env/server.mjs';
import requestIp from 'request-ip';
import { NextApiRequest, NextApiResponse } from 'next';
import { ReviewReactions, ReportReason, ReportStatus } from '@prisma/client';
import { getServerAuthSession } from '../utils/get-server-auth-session';

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
export type ResourceReviewType = 'Create' | 'Delete';
export type ReactionType =
  | 'Images_Create'
  | 'Images_Delete'
  | 'Comment_Create'
  | 'Comment_Delete'
  | 'Review_Create'
  | 'Review_Delete'
  | 'Question_Create'
  | 'Question_Delete'
  | 'Answer_Create'
  | 'Answer_Delete';
export type ReportType = 'Create' | 'StatusChange';
export type ModelEngagementType = 'Hide' | 'Favorite' | 'Delete';
export type TagEngagementType = 'Hide' | 'Allow' | 'Delete';
export type UserEngagementType = 'Follow' | 'Hide' | 'Delete';
export type CommentType = 'Model' | 'Image' | 'Post' | 'Comment' | 'Review';
export type PostActivityType = 'Create' | 'Publish' | 'Tags';
export type ImageActivityType = 'Create' | 'Delete' | 'DeleteTOS' | 'Tags' | 'Resources';
export type QuestionType = 'Create' | 'Delete';
export type AnswerType = 'Create' | 'Delete';

export type TrackRequest = {
  userId: number;
  ip: string;
  userAgent: string;
};

export class Tracker {
  constructor(private req: NextApiRequest, private res: NextApiResponse) {}

  private async track(table: string, custom: object) {
    const values = {
      ip: requestIp.getClientIp(this.req),
      userAgent: this.req.headers['user-agent'],
      userId: (await getServerAuthSession({ req: this.req, res: this.res }))?.user?.id,
      ...custom,
    };
    // do not await as we do not want to fail on tracker issues
    await clickhouse.insert({
      table: table,
      values: [values],
      format: 'JSONEachRow',
    });
  }

  public view(values: { type: ViewType; entityType: EntityType; entityId: number }) {
    return this.track('views', values);
  }

  public modelEvent(values: { type: ModelActivty; modelId: number; nsfw: boolean }) {
    return this.track('modelEvents', values);
  }

  public modelVersionEvent(values: {
    type: ModelVersionActivty;
    modelId: number;
    modelVersionId: number;
    nsfw: boolean;
  }) {
    return this.track('modelVersionEvents', values);
  }

  public userActivity(values: { type: UserActivityType; byId: number }) {
    return this.track('userActivities', values);
  }

  public resourceReview(values: {
    type: ResourceReviewType;
    modelId: number;
    modelVersionId: number;
    nsfw: boolean;
    rating: number;
  }) {
    return this.track('resourceReviews', values);
  }

  public reaction(values: {
    type: ReactionType;
    entityId: number;
    reaction: ReviewReactions;
    nsfw: boolean;
  }) {
    return this.track('reactions', values);
  }

  public question(values: { type: QuestionType; questionId: number }) {
    return this.track('questions', values);
  }

  public answer(values: { type: AnswerType; questionId: number; answerId: number }) {
    return this.track('answers', values);
  }

  public comment(values: { type: CommentType; entityId: number; nsfw: boolean }) {
    return this.track('comments', values);
  }

  public post(values: { type: PostActivityType; postId: number; nsfw: boolean; tags: string[] }) {
    return this.track('posts', values);
  }

  public image(values: {
    type: ImageActivityType;
    imageId: number;
    nsfw: boolean;
    tags: string[];
  }) {
    return this.track('images', values);
  }

  public modelEngagement(values: { type: ModelEngagementType; modelId: number }) {
    return this.track('modelEngagements', values);
  }

  public tagEngagement(values: { type: TagEngagementType; tagId: number }) {
    return this.track('tagEngagements', values);
  }

  public userEngagement(values: { type: UserEngagementType; targetUserId: number }) {
    return this.track('userEngagements', values);
  }

  public report(values: {
    type: ReportType;
    userId: number;
    entityType: string;
    entityId: number;
    reason: ReportReason;
    status: ReportStatus;
  }) {
    return this.track('reports', values);
  }
}
