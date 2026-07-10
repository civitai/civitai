// App-side ClickHouse Tracker (request/session/schema-coupled). Split out of the
// @civitai/clickhouse package, which keeps only the base client. Uses the singleton
// from the shim.
import { clickhouse } from '~/server/clickhouse/client';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { Session } from '~/types/session';
import requestIp from 'request-ip';
import { isProd } from '~/env/other';
import { env } from '~/env/server';
import type { NewOrderImageRatingStatus, NsfwLevel } from '~/server/common/enums';
import type { AllModKeys } from '~/server/jobs/entity-moderation';
import { logToAxiom } from '~/server/logging/client';
import { sleep } from '~/utils/errorHandling';
import type { AddImageRatingInput } from '~/server/schema/games/new-order.schema';
import type { ProhibitedSources } from '~/server/schema/user.schema';
import type { NsfwLevelDeprecated } from '~/shared/constants/browsingLevel.constants';
import dayjs from '~/shared/utils/dayjs';
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
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';

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
  | 'Account restoration'
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
export type ModelVersionActivty = 'Create' | 'Publish' | 'Download' | 'Unpublish' | 'HideDownload';
export type ModelActivty =
  | 'Create'
  | 'Publish'
  | 'Update'
  | 'Unpublish'
  | 'Archive'
  | 'Takedown'
  | 'Delete'
  | 'PermanentDelete'
  | 'Transfer';
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
  'ProfanitySearch',
  'BuzzLimit_Set',
  // Generation funnel telemetry — top-of-funnel clicks + form submission.
  // Joined to orchestration.jobs / images_created downstream by userId + ts.
  'Model_Create_Click',
  'Image_Remix_Click',
  'Generator_Submit',
] as const;
export type ActionType = (typeof ActionType)[number];

export type TrackRequest = {
  userId: number;
  ip: string;
  userAgent: string;
};

/** Track a webhook event to ClickHouse (fire and forget) */
export async function trackWebhookEvent(type: string, payload: string) {
  if (!clickhouse) return;

  try {
    await clickhouse.insert({
      table: 'webhook_events_buffer',
      values: [{ type, payload }],
      format: 'JSONEachRow',
    });
  } catch (error: any) {
    console.error(`Failed to track ${type} webhook to ClickHouse:`, error.message);
  }
}

export class Tracker {
  private actor: TrackRequest = {
    userId: 0,
    ip: 'unknown',
    userAgent: 'unknown',
  };
  private session: Session | null = null;
  // True once the session has been resolved (either eagerly via the constructor
  // or lazily on first track()). Distinguishes a genuinely-anonymous request
  // (resolved to null) from one that simply hasn't fetched yet, so anonymous
  // requests don't re-enter getServerAuthSession on every track() call.
  private sessionResolved = false;
  private req: NextApiRequest | undefined;
  private res: NextApiResponse | undefined;
  // Provenance of the request: how was the action initiated? Defaults to 'web'.
  // Set from the tRPC context (createContext) when auth came from a Bearer token.
  // Merged only into content-creation events (post/images/comment/bounty/article) —
  // NOT the global actor — so it's only sent to tables that have the matching columns.
  private provenance: {
    via: 'web' | 'api-key' | 'oauth';
    viaClientId: string;
    viaApiKeyId: number;
  } = { via: 'web', viaClientId: '', viaApiKeyId: 0 };

  public setProvenance(args: {
    subject?: { type: 'apiKey'; id: number } | { type: 'oauth'; id: string };
    apiKeyId?: number;
  }) {
    const { subject, apiKeyId } = args;
    if (!subject) return; // session/cookie auth — stays 'web'
    if (subject.type === 'oauth') {
      this.provenance = { via: 'oauth', viaClientId: subject.id, viaApiKeyId: apiKeyId ?? 0 };
    } else {
      this.provenance = { via: 'api-key', viaClientId: '', viaApiKeyId: apiKeyId ?? subject.id };
    }
  }

  private async resolveSession() {
    if (!this.sessionResolved && this.req && this.res) {
      try {
        await getServerAuthSession({ req: this.req, res: this.res }).then((session) => {
          this.session = session;
          this.sessionResolved = true;
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

  constructor(
    req?: NextApiRequest,
    res?: NextApiResponse,
    // The tRPC context has already resolved the session before constructing a
    // Tracker. Passing it in lets high-volume tracking routes (e.g. track.addView
    // ~100/s on api-primary) skip the Tracker's own getServerAuthSession call.
    // The win is specifically ANONYMOUS requests: getServerAuthSession memoizes
    // into req.context.session, but a null (anon) session fails that truthy guard,
    // so the lazy resolveSession() re-ran a full JWE decrypt on every track()
    // call. Authenticated requests already cache-hit the memo. Omitting this arg
    // keeps the legacy behavior: resolveSession() lazily fetches on first track().
    session?: Session | null
  ) {
    if (req && res) {
      this.req = req;
      this.res = res;
      this.actor.ip = requestIp.getClientIp(req) ?? this.actor.ip;
      this.actor.userAgent = req.headers['user-agent'] ?? this.actor.userAgent;
    }
    if (session !== undefined) {
      this.session = session;
      this.sessionResolved = true;
      this.actor.userId = session?.user?.id ?? this.actor.userId;
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
    const url = `${env.CLICKHOUSE_TRACKER_URL}/track/${table}`;

    // Fire-and-forget at the call site, but the inner attempt loop checks
    // HTTP status (not just network errors) and retries 5xx with backoff.
    // Prior version only handled network rejection from fetch(), so any
    // 5xx response from the tracker — common when NATS publish ack times
    // out — was silently dropped.
    void this.sendWithRetry(url, body, table);
  }

  private async sendWithRetry(
    url: string,
    body: object,
    table: string,
    attempt = 1
  ): Promise<void> {
    const MAX_ATTEMPTS = 3;
    const baseDelayMs = 250;

    try {
      const res = await fetch(url, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
      });

      if (res.ok) return;

      // 4xx: tracker rejected the payload. Retrying won't help. Log and bail.
      if (res.status >= 400 && res.status < 500) {
        const errBody = await res.text().catch(() => '');
        logToAxiom(
          {
            type: 'warning',
            name: 'Failed to track (4xx)',
            details: { table, status: res.status, attempt, response: errBody.slice(0, 500) },
            message: `Tracker returned ${res.status}`,
          },
          'clickhouse'
        ).catch(() => {});
        return;
      }

      // 5xx: transient — NATS publish timeout, JetStream rejection, etc.
      if (attempt < MAX_ATTEMPTS) {
        await sleep(baseDelayMs * 2 ** (attempt - 1) + Math.random() * baseDelayMs);
        return this.sendWithRetry(url, body, table, attempt + 1);
      }

      const errBody = await res.text().catch(() => '');
      logToAxiom(
        {
          type: 'error',
          name: 'Failed to track (5xx, exhausted)',
          details: {
            table,
            status: res.status,
            attempts: attempt,
            response: errBody.slice(0, 500),
          },
          message: `Tracker returned ${res.status} after ${attempt} attempts`,
        },
        'clickhouse'
      ).catch(() => {});
    } catch (e) {
      const error = e as Error;
      // Network-level failure. Retry the same as 5xx.
      if (attempt < MAX_ATTEMPTS) {
        await sleep(baseDelayMs * 2 ** (attempt - 1) + Math.random() * baseDelayMs);
        return this.sendWithRetry(url, body, table, attempt + 1);
      }
      logToAxiom(
        {
          type: 'error',
          name: 'Failed to track (network, exhausted)',
          details: { table, attempts: attempt },
          message: error.message,
          stack: error.stack,
          cause: error.cause,
        },
        'clickhouse'
      ).catch(() => {});
    }
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

  public view(values: {
    type: ViewType;
    entityType: EntityType;
    entityId: number;
    // Optional client-supplied context, forwarded verbatim into the `views`
    // ClickHouse row (same shape the track.addView tRPC resolver passed
    // through). Kept optional so server-side callers can omit them.
    ads?: 'Member' | 'Blocked' | 'Served' | 'Off';
    nsfw?: boolean;
    nsfwLevel?: number;
    browsingLevel?: number;
    details?: Record<string, unknown>;
  }) {
    return this.track('views', values);
  }

  // App Blocks Analytics Phase 2 — block render/impression event. Fired once per
  // host mount (BLOCK_READY) so anon viewers + static/no-scope blocks (which
  // `block_scope_invocations` misses) become measurable. `userId`/`ip`/`userAgent`
  // are stamped by track() from the resolved actor; `isAnon` is derived
  // server-side by the caller (the track.blockRender tRPC procedure from
  // `!ctx.user`) — it is NOT accepted from the browser.
  public blockRender(values: {
    appBlockId: string;
    blockInstanceId: string;
    slotId: string;
    isAnon: boolean;
  }) {
    return this.track('blockRenders', values);
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
    const { details, ...rest } = values;
    return this.track('actions', {
      ...rest,
      details:
        details != null ? (typeof details === 'string' ? details : JSON.stringify(details)) : '',
    });
  }

  public activity(activity: string) {
    return this.track('activities', { activity });
  }

  public bugReport(values: { bugId: number; status: string }) {
    return this.track('bugReports', values);
  }

  public modelEvent(values: { type: ModelActivty; modelId: number; nsfw: boolean }) {
    return this.track('modelEvents', { ...values, ...this.provenance });
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
    fileId?: number;
  }) {
    return this.track('modelVersionEvents', { ...values, ...this.provenance });
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
    return this.track('resourceReviews', { ...values, ...this.provenance });
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
    return this.track('comments', { ...values, ...this.provenance });
  }

  public commentEvent(values: { type: CommentActivity; commentId: number }) {
    return this.track('commentEvents', values);
  }

  public post(values: { type: PostActivityType; postId: number; nsfw: boolean; tags: string[] }) {
    return this.track('posts', { ...values, ...this.provenance });
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
      violationType?: string;
      violationDetails?: string;
      resources?: number[];
      userId?: number;
    }[]
  ) {
    return this.trackMany(
      'images',
      values.map((v) => ({ ...v, ...this.provenance }))
    );
  }

  public bounty(values: { type: BountyActivity; bountyId: number; userId?: number }) {
    return this.track('bounties', { ...values, ...this.provenance });
  }

  public bountyEntry(values: {
    type: BountyEntryActivity;
    bountyEntryId: number;
    benefactorId?: number;
    userId?: number;
  }) {
    return this.track('bountyEntries', { ...values, ...this.provenance });
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

  public article(values: {
    type: 'Create' | 'Publish' | 'Update' | 'Unpublish' | 'Delete';
    articleId: number;
    nsfw: boolean;
  }) {
    return this.track('articles', { ...values, ...this.provenance });
  }

  public articleEngagement(values: {
    type: ArticleEngagementType | `Delete${ArticleEngagementType}`;
    articleId: number;
  }) {
    return this.track('articleEngagements', values);
  }

  public articleRatingReview(values: {
    articleId: number;
    fromLevel: number;
    toLevel: number;
    hasComment: boolean;
  }) {
    return this.track('articleRatingReviews', values);
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
    remixOfId?: number;
    inputImages?: string[];
    inputVideo?: string;
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
    const { filters, ...rest } = values;
    return this.track('search', {
      ...rest,
      filters:
        filters != null ? (typeof filters === 'string' ? filters : JSON.stringify(filters)) : '',
    });
  }

  public newOrderImageRating(
    values: AddImageRatingInput & {
      userId: number;
      status: NewOrderImageRatingStatus;
      grantedExp: number;
      multiplier: number;
      rank: NewOrderRankType;
      originalLevel?: NsfwLevel;
      voteWeight?: number;
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
    return this.track('moderationRequest', { ...values }, { skipActorMeta: true });
  }

  public retoolAudit(values: {
    action: string;
    privileged: boolean;
    outcome: 'ok' | 'error';
    errorMsg?: string;
    payload: Record<string, unknown>;
    affected?: Record<string, unknown>;
  }) {
    return this.track('retoolAuditLog', {
      action: values.action,
      privileged: values.privileged ? 1 : 0,
      outcome: values.outcome,
      errorMsg: values.errorMsg ?? '',
      payload: JSON.stringify(values.payload),
      affected: values.affected ? JSON.stringify(values.affected) : '',
    });
  }
}
