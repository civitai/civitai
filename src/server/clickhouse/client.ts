import { createClient } from '@clickhouse/client';
import { env } from '~/env/server.mjs';
import requestIp from 'request-ip';
import { NextApiRequest } from 'next';
import { ReviewReactions, ReportReason, ReportStatus } from '@prisma/client';

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
export type ModelEngagementType = 'Hide' | 'Favorite';
export type TagEngagementType = 'Hide' | 'Allow';
export type UserEngagementType = 'Follow' | 'Hide';
export type CommentType = 'Model' | 'Image' | 'Post' | 'Comment' | 'Review';
export type PostActivityType = 'Create' | 'Publish' | 'Tags';
export type ImageActivityType = 'Create' | 'Delete' | 'DeleteTOS' | 'Tags' | 'Resources';
export type QuestionType = 'Create' | 'Delete';
export type AnswerType = 'Create' | 'Delete';

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

export async function trackModelEvent(
  req: NextApiRequest,
  type: ModelActivty,
  modelId: number,
  nsfw: boolean
) {
  const ip = requestIp.getClientIp(req);
  const userAgent = req.headers['user-agent'];

  clickhouse.insert({
    table: 'modelEvents',
    values: [
      {
        type,
        userId: 0, // todo:
        modelId,
        nsfw,
        ip,
        userAgent,
      },
    ],
    format: 'JSONEachRow',
  });
}

export async function trackModelVersionEvent(
  req: NextApiRequest,
  type: ModelVersionActivty,
  modelId: number,
  modelVersionId: number,
  nsfw: boolean
) {
  const ip = requestIp.getClientIp(req);
  const userAgent = req.headers['user-agent'];

  clickhouse.insert({
    table: 'modelVersionEvents',
    values: [
      {
        type,
        userId: 0, // todo:
        modelId,
        modelVersionId,
        nsfw,
        ip,
        userAgent,
      },
    ],
    format: 'JSONEachRow',
  });
}

export async function trackUserActivity(req: NextApiRequest, type: UserActivityType) {
  const ip = requestIp.getClientIp(req);
  const userAgent = req.headers['user-agent'];

  clickhouse.insert({
    table: 'userActivities',
    values: [
      {
        type,
        userId: 0, // todo:
        ip,
        userAgent,
      },
    ],
    format: 'JSONEachRow',
  });
}

export async function trackResourceReview(req: NextApiRequest, type: ResourceReviewType) {
  const ip = requestIp.getClientIp(req);
  const userAgent = req.headers['user-agent'];

  clickhouse.insert({
    table: 'resourceReviews',
    values: [
      {
        type,
        userId: 0, // todo:
        ip,
        userAgent,
      },
    ],
    format: 'JSONEachRow',
  });
}

export async function trackReaction(
  req: NextApiRequest,
  type: ReactionType,
  entityId: number,
  reaction: ReviewReactions
) {
  const ip = requestIp.getClientIp(req);
  const userAgent = req.headers['user-agent'];

  clickhouse.insert({
    table: 'reactions',
    values: [
      {
        type,
        userId: 0, // todo:
        entityId,
        reaction,
        ip,
        userAgent,
      },
    ],
    format: 'JSONEachRow',
  });
}

export async function trackReport(
  req: NextApiRequest,
  type: ReportType,
  userId: number,
  reason: ReportReason,
  status: ReportStatus
) {
  const ip = requestIp.getClientIp(req);
  const userAgent = req.headers['user-agent'];

  clickhouse.insert({
    table: 'reports',
    values: [
      {
        type,
        userId,
        reason,
        status,
        ip,
        userAgent,
      },
    ],
    format: 'JSONEachRow',
  });
}

export async function trackModelEngagement(
  req: NextApiRequest,
  type: ModelEngagementType,
  modelId: number
) {
  const ip = requestIp.getClientIp(req);
  const userAgent = req.headers['user-agent'];

  clickhouse.insert({
    table: 'modelEngagement',
    values: [
      {
        type,
        userId: 0, // todo
        modelId,
        ip,
        userAgent,
      },
    ],
    format: 'JSONEachRow',
  });
}

export async function trackTagEngagement(
  req: NextApiRequest,
  type: TagEngagementType,
  tagId: number
) {
  const ip = requestIp.getClientIp(req);
  const userAgent = req.headers['user-agent'];

  clickhouse.insert({
    table: 'tagEngagement',
    values: [
      {
        type,
        userId: 0, // todo
        tagId,
        ip,
        userAgent,
      },
    ],
    format: 'JSONEachRow',
  });
}

export async function trackUserEngagement(
  req: NextApiRequest,
  type: UserEngagementType,
  targetUserId: number
) {
  const ip = requestIp.getClientIp(req);
  const userAgent = req.headers['user-agent'];

  clickhouse.insert({
    table: 'userEngagement',
    values: [
      {
        type,
        userId: 0, // todo
        targetUserId,
        ip,
        userAgent,
      },
    ],
    format: 'JSONEachRow',
  });
}

export async function trackComment(
  req: NextApiRequest,
  type: CommentType,
  entityId: number,
  nsfw: boolean
) {
  const ip = requestIp.getClientIp(req);
  const userAgent = req.headers['user-agent'];

  clickhouse.insert({
    table: 'comments',
    values: [
      {
        type,
        userId: 0, // todo
        entityId,
        nsfw,
        ip,
        userAgent,
      },
    ],
    format: 'JSONEachRow',
  });
}

export async function trackPost(
  req: NextApiRequest,
  type: PostActivityType,
  postId: number,
  nsfw: boolean,
  tags: string[]
) {
  const ip = requestIp.getClientIp(req);
  const userAgent = req.headers['user-agent'];

  clickhouse.insert({
    table: 'posts',
    values: [
      {
        type,
        userId: 0, // todo
        postId,
        tags,
        nsfw,
        ip,
        userAgent,
      },
    ],
    format: 'JSONEachRow',
  });
}

export async function trackImage(
  req: NextApiRequest,
  type: ImageActivityType,
  imageId: number,
  nsfw: boolean,
  tags: string[]
) {
  const ip = requestIp.getClientIp(req);
  const userAgent = req.headers['user-agent'];

  clickhouse.insert({
    table: 'images',
    values: [
      {
        type,
        userId: 0, // todo
        imageId,
        tags,
        nsfw,
        ip,
        userAgent,
      },
    ],
    format: 'JSONEachRow',
  });
}

export async function trackQuestion(req: NextApiRequest, type: QuestionType, questionId: number) {
  const ip = requestIp.getClientIp(req);
  const userAgent = req.headers['user-agent'];

  clickhouse.insert({
    table: 'questions',
    values: [
      {
        type,
        userId: 0, // todo
        questionId,
        ip,
        userAgent,
      },
    ],
    format: 'JSONEachRow',
  });
}

export async function trackAnswer(
  req: NextApiRequest,
  type: AnswerType,
  questionId: number,
  answerId: number
) {
  const ip = requestIp.getClientIp(req);
  const userAgent = req.headers['user-agent'];

  clickhouse.insert({
    table: 'answers',
    values: [
      {
        type,
        userId: 0, // todo
        questionId,
        answerId,
        ip,
        userAgent,
      },
    ],
    format: 'JSONEachRow',
  });
}
