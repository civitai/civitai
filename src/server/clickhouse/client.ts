import type { ClickHouseClient } from '@clickhouse/client';
import { createClient } from '@clickhouse/client';
import dayjs from '~/shared/utils/dayjs';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { Session } from 'next-auth';
import requestIp from 'request-ip';
import { isProd } from '~/env/other';
import { env } from '~/env/server';
import type { NewOrderImageRatingStatus, NsfwLevel } from '~/server/common/enums';
import type { AllModKeys } from '~/server/jobs/entity-moderation';
import { logToAxiom } from '~/server/logging/client';
import type { AddImageRatingInput } from '~/server/schema/games/new-order.schema';
import type { ProhibitedSources } from '~/server/schema/user.schema';
import type { NsfwLevelDeprecated } from '~/shared/constants/browsingLevel.constants';
import type {
  ArticleEngagementType,
  BountyEngagementType,
  EntityMetric_EntityType_Type,
  EntityMetric_MetricType_Type,
  EntityType,
  NewOrderRankType,
  ReportReason,
  ReportStatus,
  ReviewReactions,
} from '~/shared/utils/prisma/enums';
import { createLogger } from '~/utils/logging';
import { getServerAuthSession } from '../utils/get-server-auth-session';

export type CustomClickHouseClient = ClickHouseClient & {
  $query: <T extends object>(
    query: TemplateStringsArray | string,
    ...values: any[]
  ) => Promise<T[]>;
};

declare global {
  // eslint-disable-next-line no-var, vars-on-top
  var globalClickhouse: CustomClickHouseClient | undefined;
}

const log = createLogger('clickhouse', 'blue');

function getClickHouse() {
  console.log('Creating ClickHouse client');
  const client = createClient({
    host: env.CLICKHOUSE_HOST,
    username: env.CLICKHOUSE_USERNAME,
    password: env.CLICKHOUSE_PASSWORD,
    clickhouse_settings: {
      async_insert: 1,
      wait_for_async_insert: 0,
      output_format_json_quote_64bit_integers: 0, // otherwise they come as strings
    },
  }) as CustomClickHouseClient;

  client.$query = async function <T extends object>(
    query: TemplateStringsArray | string,
    ...values: any[]
  ) {
    if (typeof query !== 'string') {
      query = query.reduce((acc, part, i) => acc + part + formatSqlType(values[i] ?? ''), '');
    }

    log('$query', query);

    const response = await client.query({
      query,
      format: 'JSONEachRow',
    });
    const data = await response?.json<T>();
    return data;
  };

  return client;
}

export let clickhouse: CustomClickHouseClient | undefined;
const shouldConnect = env.CLICKHOUSE_HOST && env.CLICKHOUSE_USERNAME;
if (shouldConnect) {
  if (isProd) clickhouse = getClickHouse();
  else {
    if (!global.globalClickhouse) global.globalClickhouse = getClickHouse();
    clickhouse = global.globalClickhouse;
  }
}

function formatSqlType(value: any): string {
  // Catch any dates being passed in as a string
  if (
    typeof value === 'string' &&
    (value.endsWith('(Coordinated Universal Time)') || /\.\d{3}Z$/.test(value))
  ) {
    value = new Date(value);
  }
  if (value instanceof Date) return "parseDateTimeBestEffort('" + dayjs(value).toISOString() + "')";
  if (typeof value === 'object') {
    if (Array.isArray(value)) return value.map(formatSqlType).join(',');
    if (value === null) return 'null';
    return JSON.stringify(value);
  }

  return value;
}

export type ViewType =
  | 'ProfileView'
  | 'ImageView'
  | 'PostView'
  | 'ModelView'
  | 'ModelVersionView'
  | 'ArticleView'
  | 'CollectionView'
  | 'BountyView'
  | 'BountyEntryView';

export type UserActivityType =
  | 'Registration'
  | 'Login'
  | 'Account closure'
  | 'Subscribe'
  | 'Cancel'
  | 'Donate'
  | 'Adjust Moderated Content Settings'
  | 'Banned'
  | 'Unbanned'
  | 'Muted'
  | 'Unmuted'
  | 'RemoveContent'
  | 'ExcludedFromLeaderboard'
  | 'UnexcludedFromLeaderboard';
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
  | 'Answer_Delete'
  | 'BountyEntry_Create'
  | 'BountyEntry_Delete'
  | 'Article_Create'
  | 'Article_Delete';
export type ReportType = 'Create' | 'StatusChange';
export type ModelEngagementType = 'Hide' | 'Favorite' | 'Delete' | 'Notify';
export type TagEngagementType = 'Hide' | 'Allow';
export type UserEngagementType = 'Follow' | 'Hide' | 'Delete';
export type CommentType =
  | 'Model'
  | 'Image'
  | 'Post'
  | 'Comment'
  | 'Review'
  | 'Bounty'
  | 'BountyEntry';
export type CommentActivity = 'Create' | 'Delete' | 'Update' | 'Hide' | 'Unhide';
export type PostActivityType = 'Create' | 'Publish' | 'Tags' | 'Delete';
export type ImageActivityType =
  | 'Create'
  | 'Delete'
  | 'DeleteTOS'
  | 'Tags'
  | 'Resources'
  | 'Restore';
export type QuestionType = 'Create' | 'Delete';
export type AnswerType = 'Create' | 'Delete';
export type PartnerActivity = 'Run' | 'Update';
export type BountyActivity = 'Create' | 'Update' | 'Delete' | 'Expire' | 'Refund';
export type BountyEntryActivity = 'Create' | 'Update' | 'Delete' | 'Award';
export type BountyBenefactorActivity = 'Create';

export type FileActivity = 'Download';
export type ModelFileActivity = 'Create' | 'Delete' | 'Update';

export const ActionType = [
  'AddToBounty_Click',
  'AddToBounty_Confirm',
  'AwardBounty_Click',
  'AwardBounty_Confirm',
  'Tip_Click',
  'Tip_Confirm',
  'TipInteractive_Click',
  'TipInteractive_Cancel',
  'NotEnoughFunds',
  'PurchaseFunds_Cancel',
  'PurchaseFunds_Confirm',
  'LoginRedirect',
  'Membership_Cancel',
  'Membership_Downgrade',
  'CSAM_Help_Triggered',
] as const;
export type ActionType = (typeof ActionType)[number];

export type TrackRequest = {
  userId: number;
  ip: string;
  userAgent: string;
  fingerprint?: string;
};

export class Tracker {
  private actor: TrackRequest = {
    userId: 0,
    ip: 'unknown',
    userAgent: 'unknown',
    fingerprint: 'unknown',
  };
  private session: Session | null = null;
  private req: NextApiRequest | undefined;
  private res: NextApiResponse | undefined;

  private async resolveSession() {
    if (!this.session && this.req && this.res) {
      try {
        await getServerAuthSession({ req: this.req, res: this.res }).then((session) => {
          this.session = session;
          this.actor.userId = session?.user?.id ?? this.actor.userId;
          return session;
        });
      } catch (e) {
        const error = e as Error;
        logToAxiom(
          {
            type: 'error',
            name: 'Failed session',
            message: error.message,
            stack: error.stack,
            cause: error.cause,
          },
          'clickhouse'
        );
      }
    }
  }

  constructor(req?: NextApiRequest, res?: NextApiResponse) {
    if (req && res) {
      this.req = req;
      this.res = res;
      this.actor.ip = requestIp.getClientIp(req) ?? this.actor.ip;
      this.actor.userAgent = req.headers['user-agent'] ?? this.actor.userAgent;
      this.actor.fingerprint = (req.headers['x-fingerprint'] as string) ?? this.actor.fingerprint;
    }
  }

  private async send(
    table: string,
    data: object | ((args: { session: Session | null; actor: TrackRequest }) => object)
  ) {
    if (!env.CLICKHOUSE_TRACKER_URL) return;
    await this.resolveSession();

    const body =
      typeof data === 'function' ? data({ session: this.session, actor: this.actor }) : data;

    // Perform the clickhouse insert in the background
    fetch(`${env.CLICKHOUSE_TRACKER_URL}/track/${table}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        'Content-Type': 'application/json',
      },
    }).catch((e) => {
      const error = e as Error;
      logToAxiom(
        {
          type: 'error',
          name: 'Failed to track',
          details: { table, data: JSON.stringify(data) },
          message: error.message,
          stack: error.stack,
          cause: error.cause,
        },
        'clickhouse'
      ).catch();
    });
  }

  private async sendMany(
    table: string,
    data: object[] | ((args: { session: Session | null; actor: TrackRequest }) => object[])
  ) {
    if (!clickhouse) return;
    await this.resolveSession();
    const values =
      typeof data === 'function' ? data({ session: this.session, actor: this.actor }) : data;

    try {
      await clickhouse.insert({
        table,
        values,
        format: 'JSONEachRow',
      });
    } catch (e) {
      const error = e as Error;
      logToAxiom(
        {
          type: 'error',
          name: 'Failed to track',
          details: { table, data: JSON.stringify(data) },
          message: error.message,
          stack: error.stack,
          cause: error.cause,
        },
        'clickhouse'
      ).catch();
    }
  }

  private async track(
    table: string,
    custom: object | ((session: Session | null) => object),
    options?: { skipActorMeta: boolean }
  ): Promise<void> {
    const { skipActorMeta = false } = options ?? {};

    await this.send(table, ({ session, actor }) => {
      const actorMeta = skipActorMeta ? { userId: actor.userId } : { ...actor };
      const customData = typeof custom === 'function' ? custom(session) : custom;

      return {
        ...actorMeta,
        ...customData,
      };
    });
  }

  private async trackMany(
    table: string,
    custom: object[] | ((session: Session | null) => object[]),
    options?: { skipActorMeta: boolean }
  ) {
    const { skipActorMeta = false } = options ?? {};

    await this.sendMany(table, ({ session, actor }) => {
      const actorMeta = skipActorMeta ? { userId: actor.userId } : { ...actor };
      const customData = typeof custom === 'function' ? custom(session) : custom;
      return customData.map((custom) => ({
        ...actorMeta,
        ...custom,
      }));
    });
  }

  public view(values: { type: ViewType; entityType: EntityType; entityId: number }) {
    return this.track('views', values);
  }

  public pageView(values: {
    pageId: string;
    path: string;
    host: string;
    ads: boolean;
    country: string;
    duration: number;
    windowWidth: number;
    windowHeight: number;
  }) {
    return this.send('pageViews', ({ session, actor }) => {
      return {
        userId: actor.userId,
        memberType: session?.user?.tier ?? 'undefined',
        ip: actor.ip,
        ...values,
      };
    });
  }

  public action(values: { type: ActionType; details?: any }) {
    return this.track('actions', values);
  }

  public activity(activity: string) {
    return this.track('activities', { activity });
  }

  public modelEvent(values: { type: ModelActivty; modelId: number; nsfw: boolean }) {
    return this.track('modelEvents', values);
  }

  public redeemableCode(activity: string, details: { quantity?: number; code?: string }) {
    return this.track('redeemableCodes', { activity, ...details });
  }

  public modelVersionEvent(values: {
    type: ModelVersionActivty;
    modelId: number;
    modelVersionId: number;
    nsfw: boolean;
    earlyAccess?: boolean;
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

  public userActivity(values: {
    type: UserActivityType;
    targetUserId: number;
    source?: string;
    landingPage?: string;
  }) {
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
    ownerId: number;
    reaction: ReviewReactions;
    nsfw: NsfwLevelDeprecated;
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

  public modelFile(values: { type: ModelFileActivity; id: number; modelVersionId: number }) {
    return this.track('modelFileEvents', values);
  }

  public images(
    values: {
      type: ImageActivityType;
      imageId: number;
      nsfw: NsfwLevelDeprecated;
      tags: string[];
      ownerId: number;
      tosReason?: string;
      resources?: number[];
      userId?: number;
    }[]
  ) {
    return this.trackMany('images', values);
  }

  public bounty(values: { type: BountyActivity; bountyId: number; userId?: number }) {
    return this.track('bounties', values);
  }

  public bountyEntry(values: {
    type: BountyEntryActivity;
    bountyEntryId: number;
    benefactorId?: number;
    userId?: number;
  }) {
    return this.track('bountyEntries', values);
  }

  public bountyBenefactor(values: {
    type: BountyBenefactorActivity;
    bountyId: number;
    userId: number;
  }) {
    return this.track('bountyBenefactors', values);
  }

  public modelEngagement(values: { type: ModelEngagementType; modelId: number }) {
    return this.track('modelEngagements', values);
  }

  public articleEngagement(values: {
    type: ArticleEngagementType | `Delete${ArticleEngagementType}`;
    articleId: number;
  }) {
    return this.track('articleEngagements', values);
  }

  public tagEngagement(values: { type: TagEngagementType; tagId: number }) {
    return this.track('tagEngagements', values);
  }

  public userEngagement(values: { type: UserEngagementType; targetUserId: number }) {
    return this.track('userEngagements', values);
  }

  public bountyEngagement(values: {
    type: BountyEngagementType | `Delete${BountyEngagementType}`;
    bountyId: number;
  }) {
    return this.track('bountyEngagements', values);
  }

  public prohibitedRequest(values: {
    prompt: string;
    negativePrompt: string;
    source?: ProhibitedSources;
  }) {
    return this.track('prohibitedRequests', values);
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

  public share(values: { url: string; platform: 'reddit' | 'twitter' | 'clipboard' }) {
    return this.track('shares', values);
  }

  public file(values: { type: FileActivity; entityType: string; entityId: number }) {
    return this.track('files', values);
  }

  public search(values: { query: string; index: string; filters?: any }) {
    return this.track('search', values);
  }

  public newOrderImageRating(
    values: AddImageRatingInput & {
      userId: number;
      status: NewOrderImageRatingStatus;
      grantedExp: number;
      multiplier: number;
      rank: NewOrderRankType;
      originalLevel?: NsfwLevel;
    }
  ) {
    return this.track('knights_new_order_image_rating', { ...values, createdAt: new Date() });
  }

  public entityMetric(values: {
    entityType: EntityMetric_EntityType_Type;
    entityId: number;
    metricType: EntityMetric_MetricType_Type;
    metricValue: number;
  }) {
    return this.track(
      'entityMetricEvents',
      { ...values, createdAt: new Date() },
      { skipActorMeta: true }
    );
  }

  public moderationRequest(values: {
    entityType: AllModKeys;
    entityId: number;
    userId: number;
    rules: string[];
    // value: string;
    date: Date;
    valid?: boolean;
  }) {
    return this.track(
      'moderationRequests',
      { ...values, createdAt: new Date() },
      { skipActorMeta: true }
    );
  }
}
