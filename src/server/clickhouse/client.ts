import { createClient } from '@clickhouse/client';
import { env } from '~/env/server.mjs';
import requestIp from 'request-ip';
import { NextApiRequest, NextApiResponse } from 'next';
import {
  ReviewReactions,
  ReportReason,
  ReportStatus,
  NsfwLevel,
  ArticleEngagementType,
} from '@prisma/client';
import { getServerAuthSession } from '../utils/get-server-auth-session';

const shouldConnect = env.CLICKHOUSE_HOST && env.CLICKHOUSE_USERNAME && env.CLICKHOUSE_PASSWORD;
export const clickhouse = shouldConnect
  ? createClient({
      host: env.CLICKHOUSE_HOST,
      username: env.CLICKHOUSE_USERNAME,
      password: env.CLICKHOUSE_PASSWORD,
    })
  : null;

export type ViewType =
  | 'ProfileView'
  | 'ImageView'
  | 'PostView'
  | 'ModelView'
  | 'ModelVersionView'
  | 'ArticleView';
export type EntityType = 'User' | 'Image' | 'Post' | 'Model' | 'ModelVersion' | 'Article';

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
  | 'Unmuted'
  | 'RemoveContent';
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
export type ResourceReviewType = 'Create' | 'Delete' | 'Exclude' | 'Include' | 'Update';
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
export type TagEngagementType = 'Hide' | 'Allow';
export type UserEngagementType = 'Follow' | 'Hide' | 'Delete';
export type CommentType = 'Model' | 'Image' | 'Post' | 'Comment' | 'Review';
export type CommentActivity = 'Create' | 'Delete' | 'Update' | 'Hide' | 'Unhide';
export type PostActivityType = 'Create' | 'Publish' | 'Tags';
export type ImageActivityType = 'Create' | 'Delete' | 'DeleteTOS' | 'Tags' | 'Resources';
export type QuestionType = 'Create' | 'Delete';
export type AnswerType = 'Create' | 'Delete';
export type PartnerActivity = 'Run' | 'Update';

export type TrackRequest = {
  userId: number;
  ip: string;
  userAgent: string;
};

export class Tracker {
  private actor: TrackRequest = {
    userId: 0,
    ip: 'unknown',
    userAgent: 'unknown',
  };
  private session: Promise<number> | undefined;

  constructor(req?: NextApiRequest, res?: NextApiResponse) {
    if (req && res) {
      this.actor.ip = requestIp.getClientIp(req) ?? this.actor.ip;
      this.actor.userAgent = req.headers['user-agent'] ?? this.actor.userAgent;
      this.session = getServerAuthSession({ req, res }).then((session) => {
        this.actor.userId = session?.user?.id ?? this.actor.userId;
        return this.actor.userId;
      });
      this.session.catch(() => {
        // ignore
      });
    }
  }

  private async track(table: string, custom: object) {
    if (!clickhouse) return;

    if (this.session) await this.session;

    const data = {
      ...this.actor,
      ...custom,
    };

    // Perform the clickhouse insert in the background
    await clickhouse.insert({
      table: table,
      values: [data],
      format: 'JSONEachRow',
      query_params: {
        async_insert: 1,
        wait_for_async_insert: 1,
      },
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
    time?: Date;
  }) {
    return this.track('modelVersionEvents', values);
  }

  public partnerEvent(values: {
    type: PartnerActivity;
    partnerId: number;
    modelId?: number;
    modelVersionId?: number;
    nsfw?: boolean;
  }) {
    return this.track('partnerEvents', values);
  }

  public userActivity(values: { type: UserActivityType; targetUserId: number }) {
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
    nsfw: NsfwLevel;
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

  public commentEvent(values: { type: CommentActivity; commentId: number }) {
    return this.track('commentEvents', values);
  }

  public post(values: { type: PostActivityType; postId: number; nsfw: boolean; tags: string[] }) {
    return this.track('posts', values);
  }

  public image(values: {
    type: ImageActivityType;
    imageId: number;
    nsfw: NsfwLevel;
    tags: string[];
  }) {
    return this.track('images', values);
  }

  public modelEngagement(values: { type: ModelEngagementType; modelId: number }) {
    return this.track('modelEngagements', values);
  }

  public articleEngagement(values: { type: ArticleEngagementType; articleId: number }) {
    return this.track('articleEngagements', values);
  }

  public tagEngagement(values: { type: TagEngagementType; tagId: number }) {
    return this.track('tagEngagements', values);
  }

  public userEngagement(values: { type: UserEngagementType; targetUserId: number }) {
    return this.track('userEngagements', values);
  }

  public report(values: {
    type: ReportType;
    entityType: string;
    entityId: number;
    reason: ReportReason;
    status: ReportStatus;
  }) {
    return this.track('reports', values);
  }
}
