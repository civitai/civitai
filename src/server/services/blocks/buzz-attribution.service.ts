import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  blockBuzzAttributionWriteCounter,
  blockSpendAttributionWriteCounter,
  blockSubscriptionAttributionWriteCounter,
} from '~/server/prom/client';
import {
  type BlockAttribution,
  type BlockAttributionScope,
} from '~/server/schema/blocks/attribution.schema';
import {
  newBlockAttributionPayoutId,
  newBlockBuzzAttributionId,
  newBlockSpendAttributionId,
  newBlockSubscriptionAttributionId,
} from '~/server/utils/app-block-ids';
import { observeBlockAuthorFee } from './author-fee';
import { isBlockGenerationType, type BlockGenerationType } from './generation-type';
import {
  computeRateCardSplit,
  // NOTE: `computeSubscriptionShare` is deliberately not imported here. The
  // membership attribution (flow C) is TRACK-ONLY — no rate is applied at write
  // time. Its share is computed at payout time as a backpay against the
  // signed-off rate over status='tracked' rows.
  ACTIVE_RATE_CARD,
} from './rate-card';

export type AttributionPaymentProvider = 'stripe' | 'paddle' | 'nowpayments';

export type RecordAttributionInput = {
  userId: number;
  buzzAmount: number;
  /** Yellow / blue / green / red — mirrors BuzzTransaction.toAccountType. */
  buzzType?: string;
  /** Gross USD in cents (i.e. Stripe `amount_total`). */
  usdAmountCents: number;
  /** Provider fee in cents — taken off the top before publisher share. */
  providerFeeCents: number;
  paymentProvider: AttributionPaymentProvider;
  /** Provider's transaction id (Stripe PI/session id, Paddle tx id, etc). */
  paymentTransactionId: string;
  /** Buzz API transactionId once we have it. Nullable for race-safety. */
  buzzTransactionId?: string | null;
  attribution: BlockAttribution;
};

export type RecordAttributionResult = {
  /** False when the unique constraint blocked a duplicate write — i.e. webhook retry. */
  written: boolean;
  /** The attribution row, whether freshly written or pre-existing. */
  row: {
    id: string;
    status: string;
    appOwnerShareCents: number;
    platformShareCents: number;
    providerFeeCents: number;
    rateCardVersion: string;
    voidedReason: string | null;
  };
};

const ATTRIBUTION_LOG_NAME = 'block-buzz-attribution';

/**
 * Record a buzz purchase that originated inside an App Block. Idempotent
 * on `(payment_transaction_id, app_block_id)` — webhook retries are
 * no-ops. Self-purchase and internal-owner cases write rows with a zero
 * publisher share so the audit trail is preserved (the platform credit
 * is still 100% civitai's share, just expressed via app_owner_share=0).
 *
 * This function does NOT touch BuzzTransaction — buzz lives in a remote
 * API, not Postgres. The webhook handler calls `completeStripeBuzzTransaction`
 * first, then passes the resulting transactionId here. If our write
 * fails after the buzz credit succeeds, the credit stays — the buzz
 * crediting is the source of truth for "the user got their buzz" and
 * the attribution row is a derived audit/payout artifact. A failed
 * write will be retried by the provider's webhook retry policy and the
 * unique constraint protects against double-writes.
 */
export async function recordAttribution(
  input: RecordAttributionInput
): Promise<RecordAttributionResult> {
  const {
    userId,
    buzzAmount,
    buzzType = 'yellow',
    usdAmountCents,
    providerFeeCents,
    paymentProvider,
    paymentTransactionId,
    buzzTransactionId = null,
    attribution,
  } = input;

  // Resolve the app owner. We snapshot the userId onto the row so a
  // future OauthClient.userId reassignment doesn't retroactively
  // re-route past payouts. If the app isn't found we abort — without
  // an owner there's nothing to pay out.
  const app = await dbRead.oauthClient.findUnique({
    where: { id: attribution.appId },
    select: { id: true, userId: true },
  });
  if (!app) {
    logToAxiom(
      {
        name: ATTRIBUTION_LOG_NAME,
        type: 'warning',
        message: `attribution app not found (skipping write): ${attribution.appId}`,
        appId: attribution.appId,
        paymentProvider,
        paymentTransactionId,
      },
      'webhooks'
    ).catch(() => null);
    throw new AttributionAppMissingError(attribution.appId);
  }

  const isSelfPurchase = userId === app.userId;
  const split = computeRateCardSplit({
    grossCents: usdAmountCents,
    providerFeeCents,
    scope: attribution.scope as BlockAttributionScope,
    isSelfPurchase,
    appOwnerUserId: app.userId,
  });

  const status = isSelfPurchase ? 'voided' : 'pending';
  const voidedReason = isSelfPurchase ? 'self_purchase' : null;
  const voidedAt = isSelfPurchase ? new Date() : null;

  const id = newBlockBuzzAttributionId();

  try {
    const created = await dbWrite.blockBuzzAttribution.create({
      data: {
        id,
        userId,
        buzzAmount,
        buzzType,
        usdAmountCents,
        paymentProvider,
        paymentTransactionId,
        buzzTransactionId,
        appId: attribution.appId,
        appBlockId: attribution.appBlockId,
        blockInstanceId: attribution.blockInstanceId,
        scope: attribution.scope,
        modelId: attribution.modelId ?? null,
        rateCardVersion: split.rateCardVersion,
        appOwnerShareCents: split.appOwnerShareCents,
        platformShareCents: split.platformShareCents,
        providerFeeCents: split.providerFeeCents,
        appOwnerUserId: app.userId,
        status,
        voidedReason,
        voidedAt,
      },
      select: {
        id: true,
        status: true,
        appOwnerShareCents: true,
        platformShareCents: true,
        providerFeeCents: true,
        rateCardVersion: true,
        voidedReason: true,
      },
    });

    logToAxiom(
      {
        name: ATTRIBUTION_LOG_NAME,
        type: 'info',
        message: `attribution written ${created.id}`,
        attributionId: created.id,
        appId: attribution.appId,
        appBlockId: attribution.appBlockId,
        scope: attribution.scope,
        paymentProvider,
        paymentTransactionId,
        usdAmountCents,
        appOwnerShareCents: split.appOwnerShareCents,
        platformShareCents: split.platformShareCents,
        providerFeeCents: split.providerFeeCents,
        rateCardVersion: split.rateCardVersion,
        status,
        voidedReason,
        isSelfPurchase,
      },
      'webhooks'
    ).catch(() => null);

    // Best-effort Prometheus increment. Never fail the call on a
    // metric write error — metric infrastructure issues should not
    // back-pressure the webhook path.
    try {
      blockBuzzAttributionWriteCounter.inc({
        provider: paymentProvider,
        scope: attribution.scope,
        status,
      });
    } catch {
      // swallow
    }

    return { written: true, row: created };
  } catch (err) {
    // Idempotency: a webhook retry that races with the original write
    // will land here. Return the pre-existing row so callers can treat
    // success and retry uniformly.
    //
    // We duck-type on the Prisma error shape (`code === 'P2002'`)
    // rather than `instanceof Prisma.PrismaClientKnownRequestError`
    // because the error class isn't always present at runtime in test
    // environments where the Prisma client is stale or missing.
    const code = (err as { code?: unknown })?.code;
    if (code === 'P2002') {
      const existing = await dbRead.blockBuzzAttribution.findUnique({
        where: {
          paymentTransactionId_appBlockId: {
            paymentTransactionId,
            appBlockId: attribution.appBlockId,
          },
        },
        select: {
          id: true,
          status: true,
          appOwnerShareCents: true,
          platformShareCents: true,
          providerFeeCents: true,
          rateCardVersion: true,
          voidedReason: true,
        },
      });
      if (existing) {
        return { written: false, row: existing };
      }
    }
    throw err;
  }
}

export class AttributionAppMissingError extends Error {
  appId: string;
  constructor(appId: string) {
    super(`OauthClient '${appId}' not found for attribution`);
    this.name = 'AttributionAppMissingError';
    this.appId = appId;
  }
}

/**
 * Sentinel `rate_card_version` for TRACK-ONLY attribution rows (#2629 for
 * membership; the spend flow follows the same model). No rate card is applied
 * at attribution-write time, so no real version is stamped — the row records
 * the money basis (gross [+ fee]) and the share is computed at payout time
 * (Slice 4) as a backpay. A row carrying this sentinel + status='tracked' is
 * "share-pending": the payout rail re-stamps the signed-off version when it
 * computes the share.
 *
 * ⚠️ TRUE FOR MEMBERSHIP ROWS ONLY. A `block_spend_attribution` row also carries
 * this sentinel, but it is NOT share-pending — the spend bounty was removed, no
 * backpay reads that table, and nothing will ever re-stamp those rows.
 */
export const UNRATED_RATE_CARD_VERSION = 'unrated' as const;

// ---------------------------------------------------------------
// W3 flow A — buzz SPEND attribution (TRACK-ONLY audit trail; the author
// bounty it was built for is removed — see `recordSpendAttribution`)
// ---------------------------------------------------------------

const SPEND_ATTRIBUTION_LOG_NAME = 'block-spend-attribution';

/**
 * buzzDollarRatio (1000 Buzz = $1 USD) -> Buzz to USD cents. Local
 * constant (rather than importing the whole constants module into the
 * service) and documented inline. $1 = 100 cents, so 1000 Buzz = 100
 * cents => 1 cent per 10 Buzz.
 */
const BUZZ_PER_USD = 1000;
export function buzzSpendToUsdCents(buzzAmount: number): number {
  // Floor so we never over-state the spend's USD value (which would
  // over-pay the bounty). e.g. 4999 Buzz -> 499 cents (not 500).
  return Math.floor((Math.max(0, buzzAmount) / BUZZ_PER_USD) * 100);
}

export type RecordSpendAttributionInput = {
  /** The viewer (spender). Server-derived from the verified token's `sub`. */
  userId: number;
  /** Buzz the generation burned (the orchestrator-computed cost). */
  buzzAmount: number;
  /** Yellow / blue / etc — mirrors BuzzTransaction.fromAccountType. */
  buzzType?: string;
  /** Orchestrator workflow id — the idempotency anchor. */
  workflowId: string;
  /** OauthClient.id — server-derived from the verified token's `appId`. */
  appId: string;
  /** AppBlock.id — server-derived from the verified token's `appBlockId`. */
  appBlockId: string;
  /** Block instance id — server-derived from the verified token. */
  blockInstanceId: string;
  /** Optional: model the generation ran against (analytics only). */
  modelId?: number | null;
  /**
   * Optional GENERIC published-content-author basis. The opaque shared-storage
   * `key` of the cross-user published content this generation is running on
   * behalf of (the app supplies it from its own `app_<slug>.shared_kv`). When
   * present, the CONTENT AUTHOR is resolved SERVER-SIDE from this key against
   * the calling app's shared storage (NEVER trusted from the client) and
   * recorded as the future-payout basis. Omit when N/A. FULLY GENERIC — works
   * for any app that publishes cross-user content, not tied to any one app kind.
   */
  sharedContentKey?: string | null;
  /**
   * Optional APP-FACING generation type for this spend, as
   * `<coarse>` or `<coarse>:<subtype>` — e.g. `textToImage:img2img-edit`,
   * `customComfy:seamless-pano-360`, `customComfy:inline`, or a bare registered
   * STEP ID (`convert-image`, `chat-completion`). NEVER the orchestrator's
   * internal `$type`. The COARSE key is everything before the FIRST colon and is
   * what a per-generation-type fee keys on; `blockGenerationCoarseType` is the
   * one place that decomposition lives. Resolved by the caller from the
   * submitted workflow body via `resolveBlockGenerationType`; omit (or pass
   * null) when it cannot be resolved, which persists NULL. Typed as the union
   * rather than `string` so a future caller cannot stamp an arbitrary value on a
   * money/audit row.
   */
  generationType?: BlockGenerationType | null;
  /**
   * Optional BASE generation cost in Buzz — the orchestrator's
   * `WorkflowCost.base` for this workflow.
   *
   * 🔴 THIS IS NOT `buzzAmount`, AND THE DIFFERENCE IS THE WHOLE POINT OF THE
   * FIELD. `buzzAmount` above is the realized PAID DEBIT, a gross that already
   * carries the per-resource model LICENSING fees (`WorkflowCost.fees`), the
   * lineage fee and the viewer's tips — the orchestrator charges the sum and
   * settles each component to its own recipient. The per-generation AUTHOR FEE
   * is additive on top of the BASE and stacks alongside those components, so a
   * percentage of `buzzAmount` would take a cut of another creator's licensing
   * fee and of the viewer's tip, and would compound as more fee-charging
   * resources are stacked onto one generation.
   *
   * Nothing downstream can tell the two apart — both are plain positive Buzz
   * numbers — so the distinction has to be made by the CALLER, which reads
   * `cost.base` off the raw orchestrator submit response. It is not reachable
   * from the block-facing snapshot: `BlockWorkflowSnapshot.cost` is
   * deliberately `{ total }` only, and widening that wire shape would publish
   * the platform's cost breakdown to every third-party app.
   *
   * Used ONLY by the dark author-fee OBSERVATION below. It is never persisted:
   * omit it, or pass null, and the observation records a `base-unavailable` skip
   * instead of computing against a number that means something else.
   */
  baseGenerationBuzz?: number | null;
  /**
   * Optional: the orchestrator's `WorkflowCost.variable` for this workflow —
   * TRUE when the quoted price is a CAP that may settle lower (at least one step
   * is post-billed and charged up front at its maximum, with the difference
   * refunded once the provider reports the actual work delivered).
   *
   * 🔴 A CAP-PRICED GENERATION IS OBSERVED AS A SKIP, NOT AS A FEE. A percentage
   * of a number the viewer will be partly refunded is a fee on money they did
   * not spend. It gets its OWN skip reason (`price-is-cap`) rather than being
   * folded into `base-unavailable` — see `BLOCK_AUTHOR_FEE_PRICE_IS_CAP`.
   *
   * Like `baseGenerationBuzz` this is read off the RAW orchestrator submit
   * response, never off `BlockWorkflowSnapshot` (whose `cost` is deliberately
   * `{ total }` only). Omit it, or pass null/false, and the price is treated as
   * final. Never persisted.
   */
  generationPriceIsCap?: boolean | null;
};

export type RecordSpendAttributionResult = {
  /** False when the (workflow, app) UNIQUE blocked a duplicate write. */
  written: boolean;
  row: {
    id: string;
    status: string;
    appOwnerShareCents: number;
    spendSharePct: number;
    grossValueCents: number;
    rateCardVersion: string;
    voidedReason: string | null;
  };
};

/**
 * Resolve the GENERIC published-content AUTHOR for a spend attribution,
 * SERVER-SIDE, from the opaque `sharedContentKey` the app supplied.
 *
 * FORGE-SAFETY: the author is NEVER taken from client input. It is looked up
 * from the calling app's OWN shared storage — the per-app Postgres schema
 * `app_<slug>.shared_kv` (the same store `apps.shared.list` reads) — via
 * `author_user_id WHERE key = $1 AND hidden_at IS NULL`. The app slug is
 * derived from the AppBlock row addressed by the SERVER-derived `appBlockId`
 * (itself from the verified block token), so app A can only ever resolve keys
 * in app A's schema. A forged/bogus key at worst points at a non-existent row
 * → NULL (no attribution).
 *
 * FAIL-OPEN — returns NULL (leaving content_author_user_id unset, app-owner
 * attribution untouched) when: the AppBlock/slug can't be resolved, the shared
 * datastore is unavailable, the row is missing or hidden, or the resolved
 * author is the spender (self) or the app owner. Any error is swallowed → NULL.
 * A resolution failure must NEVER throw into the (fire-and-forget) attribution
 * path and NEVER add latency to the user's submit response.
 *
 * FULLY GENERIC: this works for ANY app whose users publish cross-user shared
 * content that drives generation spend — not tied to any one app kind.
 */
export async function resolvePublishedContentAuthorUserId(args: {
  /** Server-derived AppBlock PK (from the verified token) — selects the schema. */
  appBlockId: string;
  /** The opaque shared-storage key the app supplied (bounded upstream). */
  sharedContentKey: string;
  /** The spender (self-author → NULL). */
  spenderUserId: number;
  /** The app owner (owner-author → NULL; app-owner attribution already covers it). */
  appOwnerUserId: number;
}): Promise<number | null> {
  try {
    // Derive the app's shared-storage schema from the SERVER-derived appBlockId
    // (never a client value): AppBlock.blockId → sanitizeAppSlug → app_<slug>.
    // This is the identical slug the shared-storage writer/reader use.
    const block = await dbRead.appBlock.findUnique({
      where: { id: args.appBlockId },
      select: { blockId: true },
    });
    if (!block?.blockId) return null;
    const { sanitizeAppSlug, appSchemaIdent } = await import('~/server/utils/apps-slug');
    const slug = sanitizeAppSlug(block.blockId);
    if (!slug) return null;
    const schema = appSchemaIdent(slug);

    // The shared datastore lives in cnpg-cluster-apps; requireAppsDb throws in
    // environments without it (PR previews / dev) — caught below → NULL.
    const { requireAppsDb } = await import('~/server/db/appsDb');
    const pool = requireAppsDb();
    const rows = (
      await pool.query<{ author_user_id: number }>(
        `SELECT author_user_id FROM ${schema}.shared_kv WHERE key = $1 AND hidden_at IS NULL LIMIT 1`,
        [args.sharedContentKey]
      )
    ).rows;

    const authorUserId = rows[0]?.author_user_id ?? null;
    if (authorUserId == null) return null;
    // Fail-open: self-author (the spender published it) or owner-author (the
    // app owner published it — already credited via the app-owner attribution).
    if (authorUserId === args.spenderUserId || authorUserId === args.appOwnerUserId) {
      return null;
    }
    return authorUserId;
  } catch {
    // Any failure degrades to NULL — never break the attribution/submit.
    return null;
  }
}

/**
 * Record a TRACK-ONLY attribution row for a block-initiated generation that
 * SPENT the viewer's own Buzz. It accrues nothing and pays nobody — the
 * percentage author bounty it was named for is GONE (see the ⚠️ TRACK-ONLY
 * paragraph below). Idempotent on `(workflow_id, app_block_id)` — a
 * re-poll / retry / re-submit of the same workflow is a no-op.
 *
 * EVERYTHING is server-derived from the verified block-token claims by
 * the caller (submitWorkflow): appId/appBlockId/blockInstanceId come from
 * the JWT, the spender from `sub`, and the author is looked up here from
 * the AppBlock's owning OauthClient. There is NO client-supplied
 * attribution field — spend is server-initiated via the token, so it is
 * inherently forge-safe (unlike the purchase/Paddle path, which must
 * re-derive client metadata via validateBuzzPurchaseAttribution).
 *
 * This function moves NO money and touches NO BuzzTransaction — it writes a
 * derived audit row. A failed write never affects the generation (the caller
 * fires it best-effort / fire-and-forget).
 *
 * ⚠️ TRACK-ONLY (mirrors #2629's membership rework). This write records the
 * ATTRIBUTION EVENT + the MONEY BASIS (gross_value_cents = USD value of the
 * Buzz burned) only. The row is written:
 *   - status                = 'tracked'
 *   - app_owner_share_cents  = 0
 *   - spend_share_pct        = 0         (no rate applied)
 *   - rate_card_version      = 'unrated' (no version stamped)
 *
 * The percentage author bounty these columns were the basis for is GONE: it was
 * superseded by the additive, author-set, viewer-paid per-generation author fee
 * (observed dark below), and its compute + backpay rails were removed. The
 * columns stay at 0 / 'unrated' so the row shape and its CHECK constraints are
 * unchanged, and the event/gross trail keeps its full history.
 *
 * Self-spend (spender == app owner) and internal-owner apps write a
 * voided, zero-share row so the audit trail exists but the row is never
 * payable (mirrors recordAttribution's self-purchase wash).
 */
export async function recordSpendAttribution(
  input: RecordSpendAttributionInput
): Promise<RecordSpendAttributionResult> {
  const {
    userId,
    buzzAmount,
    buzzType = 'yellow',
    workflowId,
    appId,
    appBlockId,
    blockInstanceId,
    modelId = null,
    sharedContentKey = null,
  } = input;

  // APP-FACING generation type (`textToImage:txt2img`, `customComfy:inline`, a
  // registered step id, …). The caller resolves it from the submitted body;
  // re-checked here so an unknown value can never reach the column — a
  // money/audit row is the wrong place to discover a typo, and a wrong type is
  // worse than a missing one. Anything unrecognised (including undefined)
  // degrades to NULL rather than throwing: this write is fire-and-forget off an
  // already-billed submit.
  //
  // 🔴 THIS RE-CHECK GOT MORE VALUABLE WHEN THE VALUE SPACE WIDENED, NOT LESS.
  // An earlier review called it redundant given the parameter's type, which was
  // arguable while the value set was a handful of literals a `tsc` error could
  // enumerate. It no longer is: the value now INTERPOLATES registry ids, so the
  // only complete statement of what is legal is `isBlockGenerationType`'s shape
  // test — coarse key in the closed set, and the segment after the first colon
  // in the closed set that key allows. A caller assembling a value by hand (a
  // cast, a future writer, a string built from a registry lookup) type-checks
  // and is still refused here.
  const generationType = isBlockGenerationType(input.generationType) ? input.generationType : null;

  // Resolve + snapshot the app owner (mirrors recordAttribution). The
  // OauthClient is the source of truth for "who owns this app"; we
  // snapshot userId onto the row so a future reassignment doesn't
  // re-route past payouts. No owner -> nothing to pay -> abort.
  const app = await dbRead.oauthClient.findUnique({
    where: { id: appId },
    select: { id: true, userId: true },
  });
  if (!app) {
    logToAxiom(
      {
        name: SPEND_ATTRIBUTION_LOG_NAME,
        type: 'warning',
        message: `spend attribution app not found (skipping write): ${appId}`,
        appId,
        workflowId,
      },
      'webhooks'
    ).catch(() => null);
    throw new AttributionAppMissingError(appId);
  }

  const grossValueCents = buzzSpendToUsdCents(buzzAmount);
  const isSelfSpend = userId === app.userId;
  const isInternal = ACTIVE_RATE_CARD.internalAppOwnerUserIds.includes(app.userId);

  // GENERIC published-content-author basis (track-only). When the app supplied
  // an opaque `sharedContentKey`, resolve the content AUTHOR SERVER-SIDE from
  // the app's own shared storage and record it as the future-payout basis. This
  // is off the submit critical path (recordSpendAttribution is fire-and-forget)
  // and fail-open: any miss/failure/self/owner degrades to NULL, leaving the
  // existing app-owner attribution untouched. NEVER trusts a client-supplied
  // author — the author is re-derived from the key. Skip the lookup entirely
  // when there's no key (unchanged behaviour, zero extra DB work).
  const contentAuthorUserId = sharedContentKey
    ? await resolvePublishedContentAuthorUserId({
        appBlockId,
        sharedContentKey,
        spenderUserId: userId,
        appOwnerUserId: app.userId,
      })
    : null;

  // TRACK-ONLY money basis: record the gross (USD value of the Buzz burned).
  // NO rate card is applied here, and the percentage author bounty this row was
  // once the basis for no longer exists — it was superseded by the additive,
  // author-set, viewer-paid per-generation author fee. The columns are kept at
  // 0 / 'unrated' so the row shape and its CHECK constraints are unchanged.
  const rateCardVersion = UNRATED_RATE_CARD_VERSION;
  const spendSharePct = 0;
  const appOwnerShareCents = 0;

  // Void rows that are zero because of WHO spent/owns. Otherwise the row is
  // 'tracked'. ⚠️ NOT "share-pending awaiting a payout-time backpay" — that was
  // the removed spend bounty. No backpay reads this table; 'tracked' is where a
  // spend row stays. The void/track distinction is kept because it is the
  // self-spend / internal-owner marker the analytics reader and any future rail
  // would both need, and voiding costs nothing.
  const voidedReason = isSelfSpend ? 'self_spend' : isInternal ? 'internal_owner' : null;
  const status = voidedReason ? 'voided' : 'tracked';
  const voidedAt = voidedReason ? new Date() : null;

  const id = newBlockSpendAttributionId();

  try {
    const created = await dbWrite.blockSpendAttribution.create({
      data: {
        id,
        userId,
        buzzAmount: Math.max(0, Math.floor(buzzAmount)),
        buzzType,
        grossValueCents,
        workflowId,
        appId,
        appBlockId,
        blockInstanceId,
        modelId,
        rateCardVersion,
        spendSharePct,
        appOwnerShareCents,
        appOwnerUserId: app.userId,
        // GENERIC published-content-author basis (server-resolved; NULL when no
        // key / miss / self / owner). `sharedContentKey` is the opaque app-
        // supplied key stored verbatim as audit context; `contentAuthorUserId`
        // is the forge-safe server-resolved credit.
        contentAuthorUserId,
        sharedContentKey,
        // The app-facing generation type (NULL when unresolvable). Additive and
        // nullable — nothing reads it yet; it exists so the per-generation-type
        // author fee has data to reason about when it lands.
        generationType,
        status,
        voidedReason,
        voidedAt,
      },
      select: {
        id: true,
        status: true,
        appOwnerShareCents: true,
        spendSharePct: true,
        grossValueCents: true,
        rateCardVersion: true,
        voidedReason: true,
      },
    });

    // PER-GENERATION AUTHOR FEE — DARK OBSERVATION ONLY (slice 1). Computes
    // what the additive, author-set, viewer-paid fee WOULD be for this
    // generation and reports it to the counters + the log line below. It moves
    // no money, writes no column, and is unreachable unless
    // `app-blocks-author-fee-enabled` is on. Settlement onto the licensing-fee
    // rail is a later slice; this exists so that slice can be sized from real
    // traffic before anyone is charged.
    //
    // 🔴 OBSERVED AFTER THE SUCCESSFUL WRITE, NOT BEFORE IT. This row is
    // idempotent on (workflowId, appBlockId); a re-poll / retry lands in the
    // P2002 branch below and must NOT observe a second fee for one generation,
    // or the sizing number is inflated by exactly the retry rate.
    //
    // 🔴 SELF-SPEND IS OBSERVED LIKE ANY OTHER GENERATION — deliberately, and
    // this is a DIVERGENCE from how attribution behaves two lines up, where
    // `isSelfSpend` voids the row. The author fee is the VIEWER paying the
    // author, and an author using their own app is a viewer like any other.
    // ⚠️ FLAGGED FOR SLICE 2: at settlement that becomes a Buzz
    // transaction from an account to ITSELF, which is at best a no-op and may be
    // rejected outright. Slice 1's shape does not make that harder — the
    // observation carries no recipient, and `isSelfSpend` is already on this
    // log line beside the fee — but the settlement writer has to decide
    // explicitly whether a self-transfer is skipped or netted, rather than
    // discovering it from a rejected transaction.
    //
    // 🔴 NO `.catch` HERE, DELIBERATELY. `observeBlockAuthorFee` is TOTAL by
    // contract — every throwing surface inside it (the flag read, each counter
    // `inc`) is caught at its own site and degrades to a named skip. A
    // belt-and-braces `.catch(() => ({ reason: 'flag-disabled' }))` was written
    // here and REMOVED: it is unreachable given that contract, and were it ever
    // reachable it would file a THROW into the `flag-disabled` population —
    // which is one of the two denominators the slice-2 sizing read depends on.
    // A rejection here is a contract violation and must surface as one rather
    // than be laundered into a gate-is-off count.
    //
    // ⚠️ WHERE IT WOULD SURFACE — stated precisely, because an earlier revision
    // of this comment called the enclosing `catch` merely "loud" and that
    // UNDERSTATES IT. A rejection here unwinds past everything between this
    // line and the `catch` below, for a row that WAS persisted:
    //   1. the success Axiom line is never written — the row exists with no
    //      `block-spend-attribution` record of it;
    //   2. `blockSpendAttributionWriteCounter.inc({ status })` never fires, so
    //      the written-row counter undercounts;
    // Then it rethrows (not a P2002) and reaches the caller's fire-and-forget
    // `.catch`. That is still the correct destination for a broken contract —
    // `authorFee.reason` is not — but it is not a free "loud" either, so the
    // unreachability argument above is what carries this, and it holds for
    // today's one caller.
    //
    // 🔴 IF A `.catch` IS EVER REINSTATED it needs a NEW skip reason of its own
    // (`observe-failed`, say) — never ANY existing member of
    // `BlockAuthorFeeSkipReason`. Every reason in that union is a live
    // population the slice-2 sizing read divides by or reasons about, and
    // folding a contract violation into any of them is how a denominator
    // acquires a silent bias. Stated against the union rather than a list of
    // names on purpose: this comment previously said "a THIRD reason … never
    // `flag-disabled` and never `base-unavailable`", and went stale the moment
    // `price-is-cap` was added — it would now be the FOURTH, and the "never"
    // list had a hole in it exactly where the newest reason sat.
    const authorFee = await observeBlockAuthorFee({
      // 🔴 NOT `buzzAmount` — see the field docs on RecordSpendAttributionInput.
      baseGenerationBuzz: input.baseGenerationBuzz ?? null,
      // 🔴 A CAP PRICE SUPPRESSES THE FEE, under its own skip reason. Threaded
      // rather than inferred: nothing downstream of the orchestrator response
      // can tell a cap apart from a final price.
      priceIsCap: input.generationPriceIsCap ?? null,
      generationType,
    });

    logToAxiom(
      {
        name: SPEND_ATTRIBUTION_LOG_NAME,
        type: 'info',
        message: `spend attribution written ${created.id}`,
        attributionId: created.id,
        appId,
        appBlockId,
        workflowId,
        buzzAmount,
        grossValueCents,
        spendSharePct,
        appOwnerShareCents,
        rateCardVersion,
        // GENERIC content-author observability: whether a key was supplied and
        // whether it resolved to a creditable author. Both are opaque/ids only.
        sharedContentKeyPresent: sharedContentKey != null,
        contentAuthorUserId,
        // Bounded (registry-derived or null), so it is safe as a log field.
        generationType,
        status,
        voidedReason,
        isSelfSpend,
        // DARK author-fee observability — FOUR fields, and the set is chosen by
        // ONE rule: a property gets exactly one instrument, and this row is the
        // instrument only where the counters cannot reach. The counters carry a
        // single `coarse_type` label (deliberately — `appBlockId` would be
        // unbounded cardinality), so anything needing a per-APP, per-`isSelfSpend`
        // or per-full-`generationType` cut has to live here, beside those three
        // fields, which are already on this line.
        //
        //   `authorFeeSkipped`   the ONLY instrument for the flag-disabled
        //                        population — `observeBlockAuthorFee` emits no
        //                        counter at all on that path, by design, and it
        //                        is one of the two denominators the slice-2
        //                        sizing read divides by. Also encodes "observed":
        //                        null ⇔ the fee was computed.
        //   `authorFeeBuzz`      the fee, per row. The counter gives the total
        //                        by coarse type; only this gives "which apps
        //                        would earn what, and how much is self-spend".
        //   `authorFeeBaseBuzz`  its denominator, for the same per-app cut. Not
        //                        recoverable from `buzzAmount` above — that is
        //                        the gross, which already carries licensing
        //                        fees, the lineage fee and tips.
        //   `authorFeeParamsSource`  which level of the config answered. NO
        //                        counter carries it, and it is genuinely
        //                        variable in production now that
        //                        `BLOCK_AUTHOR_FEE_PLATFORM_CONFIG.byType` is
        //                        seeded (`chat-completion` → 'type', everything
        //                        else → 'default').
        //
        // DROPPED, and why — a field that cannot vary is not observability:
        //   `authorFeeObserved`       derivable: `authorFeeSkipped === null`.
        //   `authorFeeLeg`            exactly the `outcome` label of
        //                             `block_author_fee_observed_total`, and
        //                             re-derivable from fee + base + source.
        //   `authorFeeParamsClamped`  a COMPILE-TIME CONSTANT `false` in slice
        //                             1 — re-derived after seeding `byType`, and
        //                             it is still constant: the only production
        //                             config is a module constant whose every
        //                             leg is inside the ceiling, and no caller
        //                             passes `config`. It becomes worth logging
        //                             in slice 3, when an author can type a
        //                             number; add it back then.
        authorFeeSkipped: authorFee.observed ? null : authorFee.reason,
        authorFeeBuzz: authorFee.observed ? authorFee.computation.feeBuzz : null,
        authorFeeBaseBuzz: authorFee.observed ? authorFee.computation.baseGenerationBuzz : null,
        authorFeeParamsSource: authorFee.observed ? authorFee.computation.source : null,
      },
      'webhooks'
    ).catch(() => null);

    try {
      blockSpendAttributionWriteCounter.inc({ status });
    } catch {
      // swallow — metric write must never back-pressure the caller
    }

    return { written: true, row: created };
  } catch (err) {
    // Idempotency: a re-poll / retry / re-submit that races the original
    // write lands on the (workflow_id, app_block_id) UNIQUE -> P2002.
    // Return the pre-existing row so callers treat first-write and retry
    // uniformly. Duck-type the Prisma error code (the class isn't always
    // constructible when the generated client is stale in tests).
    const code = (err as { code?: unknown })?.code;
    if (code === 'P2002') {
      const existing = await dbRead.blockSpendAttribution.findUnique({
        where: {
          workflowId_appBlockId: { workflowId, appBlockId },
        },
        select: {
          id: true,
          status: true,
          appOwnerShareCents: true,
          spendSharePct: true,
          grossValueCents: true,
          rateCardVersion: true,
          voidedReason: true,
        },
      });
      if (existing) {
        try {
          blockSpendAttributionWriteCounter.inc({ status: 'duplicate' });
        } catch {
          // swallow
        }
        return { written: false, row: existing };
      }
    }
    throw err;
  }
}

// ---------------------------------------------------------------
// W3 flow C — MEMBERSHIP / subscription attribution
// ---------------------------------------------------------------

const SUBSCRIPTION_ATTRIBUTION_LOG_NAME = 'block-subscription-attribution';

/**
 * The single membership-attribution scope. A membership purchase has no
 * install scope the way a Buzz purchase does (the user bought a recurring
 * platform subscription, not an app install) — it resolves to one flat
 * `subscription` category. Kept as a const so the rate card / row writers
 * agree on the literal.
 */
export const SUBSCRIPTION_ATTRIBUTION_SCOPE = 'subscription' as const;

export type RecordSubscriptionAttributionInput = {
  /** The subscriber (purchaser). Trusted: derived from the invoice's customer→User. */
  userId: number;
  /** Membership monthly Buzz bonus for this invoice (analytics only). */
  buzzAmount?: number;
  buzzType?: string;
  /** Gross USD of the invoice, in cents (Stripe invoice amount_paid). */
  usdAmountCents: number;
  /** Provider fee in cents — taken off the top before author share. */
  providerFeeCents: number;
  paymentProvider: AttributionPaymentProvider;
  /** Per-period idempotency anchor — the invoice id. */
  invoiceId: string;
  /** Subscription id (groups the periods). */
  subscriptionId?: string | null;
  /** subscription_create | subscription_cycle | subscription_update. */
  billingReason?: string | null;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  /** Membership tier at write time (analytics). */
  tier?: string | null;
  /**
   * Server-derived block attribution (already FIN-1 re-derived at checkout
   * and stamped onto the subscription metadata; the webhook reads it back
   * and re-confirms the app owner here). appId/appBlockId/blockInstanceId
   * are authoritative; scope/modelId are analytics.
   */
  attribution: Pick<BlockAttribution, 'appId' | 'appBlockId' | 'blockInstanceId' | 'modelId'>;
};

export type RecordSubscriptionAttributionResult = {
  /** False when the (invoice, app) UNIQUE blocked a duplicate write. */
  written: boolean;
  row: {
    id: string;
    status: string;
    appOwnerShareCents: number;
    platformShareCents: number;
    providerFeeCents: number;
    subscriptionSharePct: number;
    grossValueCents: number;
    rateCardVersion: string;
    voidedReason: string | null;
  };
};

/**
 * Record a revenue share for one PAID INVOICE of a block-initiated
 * membership (recurring subscription) purchase. Idempotent on
 * `(invoice_id, app_block_id)` — a webhook retry for the same invoice is a
 * no-op (P2002 caught + treated as already-written). Each RENEWAL invoice
 * has its own invoice_id, so it writes its OWN row — this is the
 * RENEWALS-PAY policy (flagged for sign-off; the caller can gate to
 * billing_reason='subscription_create' for a first-only policy).
 *
 * ⚠️ TRACK-ONLY (#2629). This write records the ATTRIBUTION EVENT + the
 * MONEY BASIS (gross + provider_fee) only. It does NOT apply the rate card
 * and does NOT bake an author share. The row is written:
 *   - status               = 'tracked'  (share-pending, not yet computed)
 *   - app_owner_share_cents = 0
 *   - subscription_share_pct= 0         (no rate applied)
 *   - rate_card_version     = 'unrated' (no version stamped)
 *   - platform_share_cents  = net (gross - fee), so the conservation CHECK
 *                             (fee + platform + author = gross) still holds
 *                             with author = 0.
 * The author share is DEFERRED to PAYOUT time: the future payout rail
 * (Slice 4) reads status='tracked' rows and computes
 * author_share = net × <signed-off subscriptionSharePct> as a clean
 * retroactive BACKPAY, then transitions them to a computed/confirmed state.
 * Because the tracked row carries gross + fee, that computation is exact.
 *
 * WHY: committing a share at the placeholder rate before monetization
 * sign-off would lock these immutable rows to the placeholder (each row
 * pays out under its STAMPED snapshot forever). Recording the basis now and
 * applying the signed-off rate later removes the placeholder-rate liability.
 *
 * This function moves NO money and touches NO BuzzTransaction — the buzz
 * grant + reward happen in manageInvoicePaid before this is called. A
 * failed write here MUST NOT break membership provisioning (the caller
 * fires it best-effort / fire-and-forget).
 *
 * Self-purchase (subscriber == app owner) and internal-owner apps write a
 * voided, zero-share row so the audit trail exists but nothing is ever
 * backpaid (mirrors recordAttribution's self-purchase wash).
 */
export async function recordSubscriptionAttribution(
  input: RecordSubscriptionAttributionInput
): Promise<RecordSubscriptionAttributionResult> {
  const {
    userId,
    buzzAmount = 0,
    buzzType = 'yellow',
    usdAmountCents,
    providerFeeCents,
    paymentProvider,
    invoiceId,
    subscriptionId = null,
    billingReason = null,
    periodStart = null,
    periodEnd = null,
    tier = null,
    attribution,
  } = input;

  // Resolve + snapshot the app owner (mirrors recordAttribution). No owner
  // -> nothing to pay -> abort (don't write an orphan row).
  const app = await dbRead.oauthClient.findUnique({
    where: { id: attribution.appId },
    select: { id: true, userId: true },
  });
  if (!app) {
    logToAxiom(
      {
        name: SUBSCRIPTION_ATTRIBUTION_LOG_NAME,
        type: 'warning',
        message: `subscription attribution app not found (skipping write): ${attribution.appId}`,
        appId: attribution.appId,
        paymentProvider,
        invoiceId,
      },
      'webhooks'
    ).catch(() => null);
    throw new AttributionAppMissingError(attribution.appId);
  }

  const isSelfPurchase = userId === app.userId;
  const isInternal = ACTIVE_RATE_CARD.internalAppOwnerUserIds.includes(app.userId);

  // TRACK-ONLY money basis: record gross + provider_fee, defer the share.
  // NO rate card is applied here (no computeSubscriptionShare call). The
  // backpay (Slice 4) re-splits `net` into platform/author at the signed-off
  // rate. Today: author = 0, platform = net, so the conservation CHECK
  // (fee + platform + author = gross) holds.
  const safeGross = Math.max(0, Math.floor(usdAmountCents));
  const safeFee = Math.max(0, Math.min(safeGross, Math.floor(providerFeeCents)));
  const net = safeGross - safeFee;
  const appOwnerShareCents = 0;
  const platformShareCents = net;
  const providerFeeCentsFinal = safeFee;
  // No rate applied → no version stamped (sentinel) and 0%.
  const rateCardVersion = UNRATED_RATE_CARD_VERSION;
  const subscriptionSharePct = 0;

  // Void rows that are zero because of WHO bought/owns so they are never
  // backpaid. Otherwise the row is 'tracked' — share-pending, awaiting the
  // payout-time backpay at the signed-off rate.
  const voidedReason = isSelfPurchase ? 'self_purchase' : isInternal ? 'internal_owner' : null;
  const status = voidedReason ? 'voided' : 'tracked';
  const voidedAt = voidedReason ? new Date() : null;

  const id = newBlockSubscriptionAttributionId();

  try {
    const created = await dbWrite.blockSubscriptionAttribution.create({
      data: {
        id,
        userId,
        buzzAmount: Math.max(0, Math.floor(buzzAmount)),
        buzzType,
        grossValueCents: safeGross,
        paymentProvider,
        invoiceId,
        subscriptionId,
        billingReason,
        periodStart,
        periodEnd,
        appId: attribution.appId,
        appBlockId: attribution.appBlockId,
        blockInstanceId: attribution.blockInstanceId,
        scope: SUBSCRIPTION_ATTRIBUTION_SCOPE,
        modelId: attribution.modelId ?? null,
        tier,
        rateCardVersion,
        subscriptionSharePct,
        appOwnerShareCents,
        platformShareCents,
        providerFeeCents: providerFeeCentsFinal,
        appOwnerUserId: app.userId,
        status,
        entryType: 'charge',
        voidedReason,
        voidedAt,
      },
      select: {
        id: true,
        status: true,
        appOwnerShareCents: true,
        platformShareCents: true,
        providerFeeCents: true,
        subscriptionSharePct: true,
        grossValueCents: true,
        rateCardVersion: true,
        voidedReason: true,
      },
    });

    logToAxiom(
      {
        name: SUBSCRIPTION_ATTRIBUTION_LOG_NAME,
        type: 'info',
        message: `subscription attribution written ${created.id}`,
        attributionId: created.id,
        appId: attribution.appId,
        appBlockId: attribution.appBlockId,
        paymentProvider,
        invoiceId,
        subscriptionId,
        billingReason,
        usdAmountCents,
        appOwnerShareCents,
        platformShareCents,
        providerFeeCents: providerFeeCentsFinal,
        subscriptionSharePct,
        rateCardVersion,
        status,
        voidedReason,
        isSelfPurchase,
      },
      'webhooks'
    ).catch(() => null);

    try {
      blockSubscriptionAttributionWriteCounter.inc({
        provider: paymentProvider,
        status,
        billing_reason: billingReason ?? 'unknown',
      });
    } catch {
      // swallow — metric write must never back-pressure the webhook path
    }

    return { written: true, row: created };
  } catch (err) {
    // Idempotency: a webhook retry for the same invoice lands on the
    // (invoice_id, app_block_id) UNIQUE → P2002. Return the pre-existing
    // row so callers treat first-write + retry uniformly.
    const code = (err as { code?: unknown })?.code;
    if (code === 'P2002') {
      const existing = await dbRead.blockSubscriptionAttribution.findUnique({
        where: {
          invoiceId_appBlockId: { invoiceId, appBlockId: attribution.appBlockId },
        },
        select: {
          id: true,
          status: true,
          appOwnerShareCents: true,
          platformShareCents: true,
          providerFeeCents: true,
          subscriptionSharePct: true,
          grossValueCents: true,
          rateCardVersion: true,
          voidedReason: true,
        },
      });
      if (existing) {
        try {
          blockSubscriptionAttributionWriteCounter.inc({
            provider: paymentProvider,
            status: 'duplicate',
            billing_reason: billingReason ?? 'unknown',
          });
        } catch {
          // swallow
        }
        return { written: false, row: existing };
      }
    }
    throw err;
  }
}

/**
 * Void the subscription-attribution rows for one paid invoice in response
 * to a refund / chargeback / proration. Idempotent — voiding an
 * already-voided row is a no-op.
 *
 * ⚠️ TRACK-ONLY (#2629). Membership rows are written status='tracked' with
 * app_owner_share_cents = 0 and are NEVER paid out (no rate is applied until
 * the payout-time backpay). A refunded purchase must simply be VOIDED before
 * any backpay runs so the future payout rail never computes a share for it.
 *
 * There is NO negative carry-forward clawback to write: with author = 0 on
 * every tracked row, a void leaves nothing owed. (Once the payout rail
 * exists and transitions tracked → paid_out with a real share, a refund of
 * an already-paid period WILL need a clawback — that belongs to the payout
 * slice, written against the rate it actually paid. This function only has
 * to neutralize unpaid tracked rows, which the void below does.)
 *
 * Returns the count of rows voided.
 */
export async function voidSubscriptionAttributionsForInvoice({
  paymentProvider,
  invoiceId,
  reason,
}: {
  paymentProvider: AttributionPaymentProvider;
  invoiceId: string;
  reason: 'refund' | 'chargeback' | 'proration' | 'manual_review';
}): Promise<number> {
  // Void the forward 'charge' rows for this invoice that haven't already
  // been voided. 'tracked' is the live track-only state; pending/confirmed/
  // paid_out are included defensively so a future payout-promoted row is
  // also neutralized here (the paid-out clawback is the payout slice's job).
  const result = await dbWrite.blockSubscriptionAttribution.updateMany({
    where: {
      paymentProvider,
      invoiceId,
      entryType: 'charge',
      status: { in: ['tracked', 'pending', 'confirmed', 'paid_out'] },
    },
    data: {
      status: 'voided',
      voidedReason: reason,
      voidedAt: new Date(),
    },
  });

  if (result.count > 0) {
    logToAxiom(
      {
        name: SUBSCRIPTION_ATTRIBUTION_LOG_NAME,
        type: 'info',
        message: `voided ${result.count} subscription attribution row(s) for ${invoiceId}`,
        paymentProvider,
        invoiceId,
        reason,
        count: result.count,
      },
      'webhooks'
    ).catch(() => null);
  }

  return result.count;
}

/** Synthetic payment_transaction_id suffix for clawback rows so they don't
 * collide with the original purchase row's (payment_transaction_id,
 * app_block_id) UNIQUE. A second refund webhook for the same payment hits
 * P2002 on this synthetic key → we skip the duplicate clawback. */
const CLAWBACK_TX_SUFFIX = ':clawback';

/**
 * Void an attribution row in response to a refund or chargeback. Called
 * from the refund/dispute webhook handlers. Idempotent — voiding an
 * already-voided row is a no-op.
 *
 * Refund handling depends on whether the money already left:
 *   - pending / confirmed rows (never paid): just void. No clawback —
 *     the publisher was never paid, so there's no debt to recover.
 *   - paid_out rows: void the original AND write a NEGATIVE carry-forward
 *     `entry_type='clawback'` row (status='confirmed', negative
 *     app_owner_share_cents / usd_amount_cents). The payout aggregator
 *     nets this debt out of the publisher's next period mint. The
 *     original payout_id stays on the voided row for audit.
 *
 * Idempotency of the clawback: each clawback row reuses the original's
 * (app_block_id) with a synthetic payment_transaction_id
 * '<orig>:clawback', so the (payment_transaction_id, app_block_id) UNIQUE
 * makes a second refund webhook a no-op (P2002 caught + skipped).
 *
 * Returns the count of rows voided (unchanged contract); clawback rows
 * are counted separately in the log.
 */
export async function voidAttributionsForPayment({
  paymentProvider,
  paymentTransactionId,
  reason,
}: {
  paymentProvider: AttributionPaymentProvider;
  paymentTransactionId: string;
  reason: 'refund' | 'chargeback' | 'manual_review';
}): Promise<number> {
  // Snapshot the already-paid_out rows BEFORE voiding so we can mint
  // their clawbacks. Only paid_out rows generate debt; pending/confirmed
  // refunds need no clawback (money never left).
  const paidOutRows = await dbWrite.blockBuzzAttribution.findMany({
    where: {
      paymentProvider,
      paymentTransactionId,
      status: 'paid_out',
    },
    select: {
      appOwnerShareCents: true,
      appOwnerUserId: true,
      userId: true,
      buzzType: true,
      appId: true,
      appBlockId: true,
      blockInstanceId: true,
      scope: true,
      modelId: true,
      rateCardVersion: true,
    },
  });

  // Write the clawbacks BEFORE the void — the ordering is the crash-safety
  // mechanism. This is deliberately NOT wrapped in a transaction: the
  // per-row P2002 dedup below can't survive a Postgres transaction abort
  // (the first constraint hit aborts the whole txn). If we voided first and
  // the process died before writing the clawbacks, a retry would re-snapshot
  // status='paid_out', find nothing (the rows are already 'voided'), and the
  // debt would be lost forever — the publisher keeps the overpayment. Writing
  // clawbacks first means a mid-flight crash leaves the originals still
  // paid_out, so the retry re-snapshots them and safely re-runs both steps;
  // already-written clawbacks no-op on the synthetic-key P2002.
  let clawbackCount = 0;
  for (const orig of paidOutRows) {
    // A clawback is itself a block_buzz_attribution row → bba_ id.
    const clawbackId = newBlockBuzzAttributionId();
    try {
      await dbWrite.blockBuzzAttribution.create({
        data: {
          id: clawbackId,
          userId: orig.userId,
          // buzz_amount has no meaning for a clawback; 0 keeps the
          // purchase non-negativity CHECK satisfied (it's scoped to
          // entry_type='purchase' but 0 is also valid for clawback).
          buzzAmount: 0,
          buzzType: orig.buzzType,
          usdAmountCents: -orig.appOwnerShareCents,
          paymentProvider,
          // Synthetic tx id so the (tx, app_block) UNIQUE both avoids
          // colliding with the original AND dedupes repeat refunds.
          paymentTransactionId: `${paymentTransactionId}${CLAWBACK_TX_SUFFIX}`,
          buzzTransactionId: null,
          appId: orig.appId,
          appBlockId: orig.appBlockId,
          blockInstanceId: orig.blockInstanceId,
          scope: orig.scope,
          modelId: orig.modelId,
          rateCardVersion: orig.rateCardVersion,
          appOwnerShareCents: -orig.appOwnerShareCents,
          platformShareCents: 0,
          providerFeeCents: 0,
          appOwnerUserId: orig.appOwnerUserId,
          // Confirmed so it's immediately nettable by the payout
          // aggregator. entry_type='clawback' marks it negative debt.
          status: 'confirmed',
          entryType: 'clawback',
          voidedReason: null,
          confirmedAt: new Date(),
        },
      });
      clawbackCount += 1;
    } catch (err) {
      // Duplicate clawback (second refund webhook for the same payment)
      // hits the synthetic-key UNIQUE → P2002. Skip, don't double-debit.
      const code = (err as { code?: unknown })?.code;
      if (code === 'P2002') continue;
      throw err;
    }
  }

  const result = await dbWrite.blockBuzzAttribution.updateMany({
    where: {
      paymentProvider,
      paymentTransactionId,
      status: { in: ['pending', 'confirmed', 'paid_out'] },
    },
    data: {
      status: 'voided',
      voidedReason: reason,
      voidedAt: new Date(),
    },
  });

  if (result.count > 0 || clawbackCount > 0) {
    logToAxiom(
      {
        name: ATTRIBUTION_LOG_NAME,
        type: 'info',
        message:
          `voided ${result.count} attribution row(s) for ${paymentTransactionId}` +
          (clawbackCount > 0 ? ` + ${clawbackCount} clawback row(s)` : ''),
        paymentProvider,
        paymentTransactionId,
        reason,
        count: result.count,
        clawbackCount,
      },
      'webhooks'
    ).catch(() => null);
  }

  return result.count;
}

export type MintPayoutResult =
  | { minted: true; payoutId: string; totalCents: number; rowCount: number }
  | { minted: false; alreadyPaid: true }
  | { minted: false; carriedForwardCents: number; rowCount: number };

/**
 * Idempotently MINT a payout ledger entry for one publisher for one
 * period, and flip the contributing confirmed rows to paid_out — all in
 * a single transaction.
 *
 * IMPORTANT: this function moves NO money. It only writes the
 * block_attribution_payout ledger row and updates row state. Actual
 * disbursement (creator-program cash bank / Tipalti) is a separate,
 * leadership-gated step that reads these ledger rows. The bulk-payout
 * cron deliberately does NOT call this yet — see
 * bulk-payout-block-attributions.ts. Do not add withdrawCash / Tipalti
 * calls here.
 *
 * Idempotency: the (app_owner_user_id, period_key) UNIQUE on
 * block_attribution_payout means a racing or retried mint hits P2002 and
 * no-ops without re-flipping any rows.
 *
 * Carry-forward debt: clawback rows (entry_type='clawback',
 * status='confirmed') carry a NEGATIVE app_owner_share_cents, so the
 * aggregate net naturally subtracts them. If the net is <= 0 we mint
 * nothing and flip nothing — the (negative) debt stays as confirmed rows
 * and carries forward into the next period's aggregate.
 */
export async function mintPayoutForOwner({
  appOwnerUserId,
  periodKey,
}: {
  appOwnerUserId: number;
  periodKey: string;
}): Promise<MintPayoutResult> {
  return dbWrite.$transaction(async (tx: Prisma.TransactionClient): Promise<MintPayoutResult> => {
    // 1. Aggregate this owner's payable rows. status='confirmed'
    // naturally includes negative entry_type='clawback' rows, so the net
    // already accounts for carry-forward debt.
    const agg = await tx.blockBuzzAttribution.aggregate({
      where: { appOwnerUserId, status: 'confirmed' },
      _sum: { appOwnerShareCents: true },
      _count: true,
    });
    const netCents = agg._sum.appOwnerShareCents ?? 0;
    const rowCount = agg._count ?? 0;

    // 2. Non-positive net → don't mint, don't flip. Debt carries forward.
    if (netCents <= 0) {
      return { minted: false, carriedForwardCents: netCents, rowCount };
    }

    // 3. Mint the ledger row. The (owner, period) UNIQUE guards against
    // a double-pay; P2002 → idempotent no-op (do NOT flip rows again).
    const payoutId = newBlockAttributionPayoutId();
    try {
      await tx.blockAttributionPayout.create({
        data: {
          id: payoutId,
          appOwnerUserId,
          periodKey,
          totalCents: netCents,
          rowCount,
        },
      });
    } catch (err) {
      const code = (err as { code?: unknown })?.code;
      if (code === 'P2002') {
        return { minted: false, alreadyPaid: true };
      }
      throw err;
    }

    // 4. Flip the contributing confirmed rows → paid_out, stamping the
    // minted payout id. This also flips the negative clawback rows; their
    // debt is now realized in this period's total and won't re-net next
    // period.
    const flipped = await tx.blockBuzzAttribution.updateMany({
      where: { appOwnerUserId, status: 'confirmed' },
      data: {
        status: 'paid_out',
        paidOutAt: new Date(),
        payoutId,
      },
    });

    logToAxiom(
      {
        name: ATTRIBUTION_LOG_NAME,
        type: 'info',
        message: `minted payout ${payoutId} for owner ${appOwnerUserId} (${periodKey})`,
        payoutId,
        appOwnerUserId,
        periodKey,
        totalCents: netCents,
        rowCount: flipped.count,
      },
      'webhooks'
    ).catch(() => null);

    return { minted: true, payoutId, totalCents: netCents, rowCount: flipped.count };
  });
}

/**
 * Refund window per provider. Used by the confirm-pending cron to
 * promote pending → confirmed only once the buyer can no longer
 * unilaterally refund through the provider.
 *
 * Stripe: 30 days for most disputes; cards in some regions allow
 * longer chargeback windows but those are handled separately.
 * Paddle: 14 days standard refund window per their merchant docs.
 * NOWPayments: crypto — no refund window in the bank sense; treat as
 * 24h to avoid the row sitting in pending forever.
 */
export const REFUND_WINDOWS_DAYS: Record<AttributionPaymentProvider, number> = {
  stripe: 30,
  paddle: 14,
  nowpayments: 1,
};

export { ACTIVE_RATE_CARD };

// ---------------------------------------------------------------
// Publisher reporting queries
// ---------------------------------------------------------------

export type RevenueSummaryBucket = {
  count: number;
  grossCents: number;
  shareCents: number;
};

export type RevenueSummary = {
  pending: RevenueSummaryBucket;
  confirmed: RevenueSummaryBucket;
  paidOut: RevenueSummaryBucket;
  voided: { count: number; grossCents: number };
};

/**
 * Aggregate revenue summary for a single publisher. Optionally
 * narrowed to one app_block and/or a date range. Used by the
 * publisher-facing /apps/[appBlockId]/revenue and /apps/revenue pages.
 */
export async function getRevenueForOwner({
  ownerUserId,
  appBlockId,
  from,
  to,
}: {
  ownerUserId: number;
  appBlockId?: string;
  from?: Date;
  to?: Date;
}): Promise<{
  summary: RevenueSummary;
  topApps: Array<{ appBlockId: string; shareCents: number; count: number }>;
}> {
  const where = {
    appOwnerUserId: ownerUserId,
    ...(appBlockId ? { appBlockId } : {}),
    ...(from || to
      ? {
          attributedAt: {
            ...(from ? { gte: from } : {}),
            ...(to ? { lte: to } : {}),
          },
        }
      : {}),
  };

  // One round-trip per status bucket. groupBy here keeps the query
  // cheap — it doesn't need to scan every row, just hit the
  // (app_owner_user_id, attributed_at) index. The four small queries
  // run in parallel.
  const [pending, confirmed, paidOut, voided, topApps] = await Promise.all([
    dbRead.blockBuzzAttribution.aggregate({
      where: { ...where, status: 'pending' },
      _sum: { usdAmountCents: true, appOwnerShareCents: true },
      _count: true,
    }),
    dbRead.blockBuzzAttribution.aggregate({
      where: { ...where, status: 'confirmed' },
      _sum: { usdAmountCents: true, appOwnerShareCents: true },
      _count: true,
    }),
    dbRead.blockBuzzAttribution.aggregate({
      where: { ...where, status: 'paid_out' },
      _sum: { usdAmountCents: true, appOwnerShareCents: true },
      _count: true,
    }),
    dbRead.blockBuzzAttribution.aggregate({
      where: { ...where, status: 'voided' },
      _sum: { usdAmountCents: true },
      _count: true,
    }),
    dbRead.blockBuzzAttribution.groupBy({
      by: ['appBlockId'],
      where: { ...where, status: { in: ['confirmed', 'paid_out'] } },
      _sum: { appOwnerShareCents: true },
      _count: true,
      orderBy: { _sum: { appOwnerShareCents: 'desc' } },
      take: 5,
    }),
  ]);

  return {
    summary: {
      pending: {
        count: pending._count ?? 0,
        grossCents: pending._sum.usdAmountCents ?? 0,
        shareCents: pending._sum.appOwnerShareCents ?? 0,
      },
      confirmed: {
        count: confirmed._count ?? 0,
        grossCents: confirmed._sum.usdAmountCents ?? 0,
        shareCents: confirmed._sum.appOwnerShareCents ?? 0,
      },
      paidOut: {
        count: paidOut._count ?? 0,
        grossCents: paidOut._sum.usdAmountCents ?? 0,
        shareCents: paidOut._sum.appOwnerShareCents ?? 0,
      },
      voided: {
        count: voided._count ?? 0,
        grossCents: voided._sum.usdAmountCents ?? 0,
      },
    },
    topApps: (
      topApps as Array<{
        appBlockId: string;
        _sum: { appOwnerShareCents: number | null };
        _count: number;
      }>
    ).map((r) => ({
      appBlockId: r.appBlockId,
      shareCents: r._sum.appOwnerShareCents ?? 0,
      count: r._count,
    })),
  };
}

/**
 * Why there is exactly ONE reason value and not two.
 *
 * `getRevenueForOwner` never *computes* ownership — it scopes every aggregate
 * with `appOwnerUserId: ownerUserId` in the WHERE clause. So a caller who asks
 * for an appBlockId they do not own gets a zero-row aggregate, and those zeros
 * are a truthful measurement ("your attributed revenue on that app is zero"),
 * not a fabricated one. There is no not-owned branch in the revenue path that
 * could report `notOwned`, so adding that value would declare a state nothing
 * can ever produce and force an unreachable branch into every renderer — the
 * same "declared but never satisfied" trap that let the analytics bug hide.
 *
 * The dark `appBlocks` flag is therefore the only path that returns zeros it
 * never measured, hence the single `notEntitled`. If revenue ever grows a real
 * ownership probe, widen this union AND add the matching renderer branch in the
 * same change.
 */
export type RevenueUnavailableReason = 'notEntitled';

/**
 * The PLACEHOLDER payload only — named `Empty…` deliberately. `recentAttributions: []`
 * (an empty tuple) and a REQUIRED `unavailable` mean this type can describe nothing else,
 * so typing the real measurement path with it would force a developer to add
 * `unavailable` to a genuine result — the exact inverse of the bug this fixes. It was
 * briefly called `RevenuePayload`, which invited precisely that.
 */
export type EmptyRevenuePayload = {
  summary: RevenueSummary;
  topApps: Array<{ appBlockId: string; shareCents: number; count: number }>;
  recentAttributions: [];
  /**
   * REQUIRED here, because on this type the zeroed buckets are always a placeholder.
   * The contract as seen by a CALLER is "present only when the zeros are a placeholder,
   * absent on a genuine measurement" — a measured result comes back from
   * `getRevenueForOwner`, which never returns this type, so it never carries the field.
   */
  unavailable: RevenueUnavailableReason;
};

/**
 * Zeroed revenue payload — the dark-behind-the-flag shape for getMyRevenue.
 * Mirrors getRevenueForOwner's `{ summary, topApps }` (+ empty attributions
 * feed) with every bucket at zero so a flag-off caller gets no data and we
 * run NO aggregate queries. Pure constant; no DB access.
 *
 * The `unavailable` discriminator is baked in rather than passed by the caller:
 * this helper exists SOLELY for the dark-flag short-circuit, so there is no
 * legitimate way to build this payload without the flag, and a future second
 * call site cannot silently omit it.
 */
export function emptyRevenue(): EmptyRevenuePayload {
  const zeroBucket = { count: 0, grossCents: 0, shareCents: 0 };
  return {
    summary: {
      pending: { ...zeroBucket },
      confirmed: { ...zeroBucket },
      paidOut: { ...zeroBucket },
      voided: { count: 0, grossCents: 0 },
    },
    topApps: [],
    recentAttributions: [],
    unavailable: 'notEntitled',
  };
}

/**
 * Recent attributions for the publisher dashboard's activity feed.
 * Limited to the last 50 so the response stays small; the timeseries
 * chart uses the aggregate above instead of walking individual rows.
 */
export async function getRecentAttributionsForOwner({
  ownerUserId,
  appBlockId,
  limit = 50,
}: {
  ownerUserId: number;
  appBlockId?: string;
  limit?: number;
}) {
  return dbRead.blockBuzzAttribution.findMany({
    where: {
      appOwnerUserId: ownerUserId,
      ...(appBlockId ? { appBlockId } : {}),
    },
    orderBy: { attributedAt: 'desc' },
    take: limit,
    select: {
      id: true,
      attributedAt: true,
      scope: true,
      buzzAmount: true,
      usdAmountCents: true,
      appOwnerShareCents: true,
      providerFeeCents: true,
      status: true,
      voidedReason: true,
      modelId: true,
      appBlockId: true,
      paymentProvider: true,
    },
  });
}
