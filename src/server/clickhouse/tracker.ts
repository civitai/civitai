// App-side ClickHouse Tracker (request/session/schema-coupled). Split out of the
// @civitai/clickhouse package, which keeps only the base client. Uses the singleton
// from the shim.
import { clickhouse } from '~/server/clickhouse/client';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { Session } from '~/types/session';
import { resolveClientIp } from '~/server/utils/client-ip';
import { isProd } from '~/env/other';
import { env } from '~/env/server';
import type { NewOrderImageRatingStatus, NsfwLevel } from '~/server/common/enums';
import type { AllModKeys } from '~/server/jobs/entity-moderation';
import { logToAxiom } from '~/server/logging/client';
import { sleep } from '~/utils/errorHandling';
import type { AddImageRatingInput } from '~/server/schema/games/new-order.schema';
import type {
  ImpressionEntityType,
  ImpressionSurface,
  VIEW_ENTITY_TYPES,
  VIEW_TYPES,
} from '~/server/schema/track.schema';
import type { ProhibitedSources } from '~/server/schema/user.schema';
import type { NsfwLevelDeprecated } from '~/shared/constants/browsingLevel.constants';
import dayjs from '~/shared/utils/dayjs';
import type {
  ArticleEngagementType,
  BountyEngagementType,
  EntityMetric_EntityType_Type,
  EntityMetric_MetricType_Type,
  NewOrderRankType,
  ReportReason,
  ReportStatus,
  ReviewReactions,
} from '~/shared/utils/prisma/enums';
import { createLogger } from '~/utils/logging';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import type { ChatAuditRow } from '~/server/common/chat-audit.constants';
import { CHAT_AUDIT_FLAG } from '~/server/common/chat-audit.constants';
import type { EntityChangeRow } from '~/server/common/entity-change.constants';
import { ENTITY_CHANGE_TRACKING_FLAG } from '~/server/common/entity-change.constants';
import { isFlipt } from '~/server/flipt/client';

/**
 * Whether the caller waits for the tracker to accept the row.
 *
 * Off by default, and that default is right for the request paths this class
 * exists for — a view or a reaction must not add a network round trip to a
 * response. It is wrong for a caller that writes down "this was counted"
 * afterwards, which is what `awaitDelivery` is for: without it the write
 * records a dispatch, and a dropped event becomes permanently invisible instead
 * of being retried. Raises on a failure the retries could not fix.
 */
export type TrackDelivery = { awaitDelivery?: boolean };

/** Per attempt, so three of these plus the backoff is the worst case wait. */
const AWAIT_DELIVERY_TIMEOUT_MS = 5_000;

export type ViewType = (typeof VIEW_TYPES)[number];

/**
 * The `entityType` arm of the ClickHouse `views` Enum8 — deliberately NOT the
 * Prisma `EntityType`, which this used to be typed as. Prisma's enum carries
 * values the ClickHouse column has never had (`Comment`, `CommentV2`,
 * `ResourceReview`, `ChatMessage`, `UserProfile`), so it type-checked rows the
 * insert would reject.
 */
export type ViewEntityType = (typeof VIEW_ENTITY_TYPES)[number];

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
  | 'Image_Create'
  | 'Image_Delete'
  | 'Comment_Create'
  | 'Comment_Delete'
  | 'CommentV2_Create'
  | 'CommentV2_Delete'
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
  // Image/video feed tag bar. 🔴 `actions.type` is an Enum16 in ClickHouse: a value
  // the column does not carry is dropped by the tracker with no error here and no
  // row there. The widening migration
  // (src/server/clickhouse/migrations/2026-08-21-feed-tag-bar-action.sql) must be
  // applied to prod BEFORE this deploys, or the bar ships blind.
  'Feed_TagBar_Click',
  // Creator announcement analytics. Same Enum16 hazard as the line above: the widening
  // migration (src/server/clickhouse/migrations/2026-09-04-announcement-click-action.sql)
  // must be applied to prod BEFORE this deploys, or the Creator Studio page reads a
  // permanent zero that looks exactly like "nobody clicked".
  'Announcement_Click',
  'Announcement_Mute',
  'Announcement_Unmute',
  // App store "plays" — one row per on-site app LAUNCH, emitted from the
  // `/apps/run/<slug>` SSR resolver. Same Enum16 hazard as the two blocks above: the
  // widening migration (src/server/clickhouse/migrations/2026-09-05-app-open-action.sql)
  // must be applied to prod BEFORE this deploys, or the store's play count reads a
  // permanent zero that looks exactly like "nobody opened it".
  //
  // 🔴 SERVER-ONLY, AND THAT IS THE WHOLE POINT OF THE TYPE. It is deliberately absent
  // from `trackActionSchema` (see the note there), following `BuzzLimit_Set` and the
  // announcement mute pair: that schema is what `/api/track/batch` accepts from a
  // browser, so a client arm would let anyone inflate any app's play count by POSTing.
  // A number printed on a public store card has to be one a script cannot manufacture.
  'App_Open',
] as const;
export type ActionType = (typeof ActionType)[number];

// No deviceId here. The browser fingerprint that populated the ClickHouse `deviceId`
// columns was removed in ab6d406f1e (2026-05-11); every row written since 2026-05-14
// carries an empty string, so `uniqExact(deviceId)` returns 1 and a per-device
// denominator yields a nonsense rate rather than an error.
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
      // ATTRIBUTION surface: this value becomes the `ip` column on every event
      // this Tracker writes. It is a record of who acted, not a gate on whether
      // they may — so it takes the derivation that always yields a label, not
      // the fail-closed one, which would collapse every non-edge caller onto a
      // shared hop and destroy exactly the distinction these rows exist to keep.
      //
      // `resolveClientIp` is total and already answers `'unknown'` when nothing
      // resolves, which is the same value this field is initialised to — so the
      // `?? this.actor.ip` coalesce it replaces has no remaining case to cover.
      //
      // ⚠️ SEAM: this column is READ back by `fetchDownloadCount` under a
      // different derivation. That seam — how far this change narrows it and
      // what remains — is described ONCE, in `~/server/utils/download-count`,
      // which owns the read half. Do not restate it here; two copies of a
      // seam description drift, and the read side is where the gap is
      // actionable.
      this.actor.ip = resolveClientIp(req);
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
    data: object | ((args: { session: Session | null; actor: TrackRequest }) => object),
    options?: TrackDelivery
  ) {
    // No tracker configured is closer to the kill-switch than to a failure —
    // it is every dev and preview environment — so it is reported through the
    // same channel rather than raised. `awaitDelivery` callers must still not
    // read it as delivered: `send` returns false, `updateEntityMetric` passes
    // that on, and the row stays queued instead of being stamped counted.
    if (!env.CLICKHOUSE_TRACKER_URL) return false;
    await this.resolveSession();

    const body =
      typeof data === 'function' ? data({ session: this.session, actor: this.actor }) : data;
    const url = `${env.CLICKHOUSE_TRACKER_URL}/track/${table}`;

    // Fire-and-forget at the call site, but the inner attempt loop checks
    // HTTP status (not just network errors) and retries 5xx with backoff.
    // Prior version only handled network rejection from fetch(), so any
    // 5xx response from the tracker — common when NATS publish ack times
    // out — was silently dropped.
    //
    // `awaitDelivery` is for the one kind of caller that cannot use that: one
    // that writes a durable "this was counted" record afterwards. Dispatching
    // and marking would record a lost event as delivered, which is worse than
    // the loss it replaced — the row then looks accounted for forever.
    if (options?.awaitDelivery) {
      await this.sendWithRetry(url, body, table, 1, true);
      return true;
    }

    void this.sendWithRetry(url, body, table);
    return true;
  }

  private async sendWithRetry(
    url: string,
    body: object,
    table: string,
    attempt = 1,
    /** Raise on a failure the retries could not fix, instead of only logging it. */
    rethrow = false
  ): Promise<void> {
    const MAX_ATTEMPTS = 3;
    const baseDelayMs = 250;

    // A loop rather than recursion, so `rethrow` has somewhere to throw from
    // that the retry `catch` cannot swallow. Recursing and throwing inside the
    // `try` would be caught by this frame's own handler and retried as if it
    // were a network fault, multiplying the attempts.
    let failure: Error | null = null;

    for (; attempt <= MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) await sleep(baseDelayMs * 2 ** (attempt - 2) + Math.random() * baseDelayMs);

      try {
        const res = await fetch(url, {
          method: 'POST',
          body: JSON.stringify(body),
          headers: { 'Content-Type': 'application/json' },
          // Built per attempt, and only when someone is waiting. Nothing here
          // configures an undici dispatcher, so an unsignalled fetch inherits a
          // 300s header timeout — three of those on one row is a wedge rather
          // than a retry. One signal for the whole loop would be worse than
          // none: `fetch` rejects immediately on an already-aborted signal, so
          // the first slow attempt would consume the other two. Fire-and-forget
          // keeps the unbounded behaviour; nobody is holding a response open.
          signal: rethrow ? AbortSignal.timeout(AWAIT_DELIVERY_TIMEOUT_MS) : undefined,
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
          failure = new Error(`tracker: ${table} rejected with ${res.status}`);
          break;
        }

        // 5xx: transient — NATS publish timeout, JetStream rejection, etc.
        failure = new Error(`tracker: ${table} returned ${res.status}`);
        if (attempt < MAX_ATTEMPTS) continue;

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
        failure = error;
        // Network-level failure. Retry the same as 5xx.
        if (attempt < MAX_ATTEMPTS) continue;

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

    if (rethrow && failure) throw failure;
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
    options?: { skipActorMeta: boolean } & TrackDelivery
  ): Promise<boolean> {
    const { skipActorMeta = false, awaitDelivery } = options ?? {};

    return this.send(
      table,
      ({ session, actor }) => {
        const actorMeta = skipActorMeta ? { userId: actor.userId } : { ...actor };
        const customData = typeof custom === 'function' ? custom(session) : custom;

        return {
          ...actorMeta,
          ...customData,
        };
      },
      { awaitDelivery }
    );
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
    entityType: ViewEntityType;
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

  // Feed impressions — entities SEEN in a feed rather than opened. Deliberately
  // its own table: impressions outnumber views by roughly an order of magnitude,
  // so folding them into `views` would silently redefine every view number on the
  // platform (and the three materialized views built on it) overnight.
  //
  // Uses trackMany, NOT track. `track` posts one HTTP request per row to the
  // tracker service, which is what makes the single-event methods above viable at
  // their volume and would make this one ruinous: a 250-entity flush would become
  // 250 outbound requests, so client-side batching would buy nothing. trackMany
  // sends the whole array as one insert, so one browser flush is one insert.
  //
  // The part-count concern that volume raises — many pods each inserting on a
  // short interval — is already handled: the shared client sets `async_insert`
  // for every insert it makes (packages/civitai-clickhouse/src/client.ts).
  public impressions(values: {
    sessionKey: string;
    surface: ImpressionSurface;
    entities: { entityType: ImpressionEntityType; entityId: number }[];
  }) {
    const { sessionKey, surface, entities } = values;
    return this.trackMany(
      'impressions',
      entities.map(({ entityType, entityId }) => ({ entityType, entityId, sessionKey, surface })),
      // 🔴 `skipActorMeta` stamps userId only, dropping ip and userAgent. On this
      // table that is not a detail: measured on `views`, ip is 4.74 B/row and
      // userAgent 3.92 B/row out of 15.99 — together 54% of the stored bytes, for
      // two columns an impression has no use for. Halving the row is worth more
      // here than anywhere else on the platform because this table takes ~10x the
      // `views` insert rate.
      //
      // It also means impressions carry no IP. Anything wanting per-viewer
      // forensics on this data needs a deliberate decision to start collecting it,
      // rather than finding it already there.
      { skipActorMeta: true }
    );
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

  // `skipActorMeta` drops `ip` and `userAgent`, keeping only `userId`. Reach for it when the
  // event records a private judgement rather than an interaction: `actions` has no TTL, so a
  // row outlives the state that produced it and an IP-stamped record of who disliked whom is
  // not what a reversible, private product control should leave behind.
  public action(values: { type: ActionType; details?: any }, options?: { skipActorMeta: boolean }) {
    const { details, ...rest } = values;
    return this.track(
      'actions',
      {
        ...rest,
        details:
          details != null ? (typeof details === 'string' ? details : JSON.stringify(details)) : '',
      },
      options
    );
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

  public entityMetric(
    values: {
      entityType: EntityMetric_EntityType_Type;
      entityId: number;
      metricType: EntityMetric_MetricType_Type;
      metricValue: number;
    },
    options?: TrackDelivery
  ) {
    return this.track(
      'entityMetricEvents',
      { ...values, createdAt: new Date() },
      { skipActorMeta: true, awaitDelivery: options?.awaitDelivery }
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

  // Entity change/audit log (docs/entity-change-tracking-plan.md). One row per
  // changed field, one insert per save (batched via trackMany → direct CH
  // insert). Flag-gated so the app can deploy before the table exists.
  public async entityChanges(rows: EntityChangeRow[]) {
    if (!rows.length) return;
    if (!(await isFlipt(ENTITY_CHANGE_TRACKING_FLAG))) return;
    return this.trackMany(
      'entityChangeEvents',
      rows.map((row) => ({ ...row, via: this.provenance.via }))
    );
  }

  // Chat moderation audit (docs/features/chat-dm-redesign.md). Deleting a message
  // or clearing a conversation removes it from the product but not from the
  // record, so a report filed afterwards is still reviewable. Flag-gated so the
  // app can deploy before the table exists.
  public async chatAudit(row: ChatAuditRow) {
    if (!(await isFlipt(CHAT_AUDIT_FLAG))) return;
    // trackMany, not track: it inserts into ClickHouse directly, where `track`
    // POSTs to a tracker-service route that would have to be registered
    // separately. Same choice `entityChanges` makes, so DDL is the only
    // dependency.
    return this.trackMany('chatAuditEvents', [row], { skipActorMeta: true });
  }

  // One row per sticker PLACEMENT, matching the consumption rule — a comment
  // with the same sticker three times emits three rows. Append-only history;
  // the authoritative balance is UserCosmetic.remaining in Postgres.
  public async stickerUsage(
    rows: { userId: number; cosmeticId: number; entityType: string; entityId: number }[]
  ) {
    if (!rows.length) return;
    return this.trackMany('stickerUsageEvents', rows, { skipActorMeta: true });
  }

  // The beggars board deletes rejected items within the hour, so a decision that is not recorded
  // here leaves no trace of what the model did or why.
  public collectionAiReview(values: {
    appliedAction: string;
    collectionId: number;
    collectionItemId: number;
    entityId: number;
    userId: number;
    model: string;
    decision: string;
    violations: string[];
    escalations: string[];
    reason: string;
    applied: boolean;
    promptTokens: number;
    completionTokens: number;
  }) {
    return this.track(
      'collectionAiReviewEvents',
      { ...values, applied: values.applied ? 1 : 0, createdAt: new Date() },
      { skipActorMeta: true }
    );
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
