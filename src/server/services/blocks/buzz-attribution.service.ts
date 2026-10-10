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
  newBlockBuzzAttributionId,
  newBlockSpendAttributionId,
  newBlockSubscriptionAttributionId,
} from '~/server/utils/app-block-ids';
// Browser-safe leaf module, imported for the `block_good_purchase.status` domain
// so the goods READ path spells it exactly as the write path does. Deliberately
// not an import of `block-goods.service` — that would make the two services
// mutually aware and pull the Buzz-transaction graph into the reporting layer.
import { BLOCK_GOOD_PURCHASE_STATUS } from '~/shared/constants/block-goods.constants';
// The missing-table predicate, imported rather than re-spelled. See
// `isMissingGoodsTableError` below for why a local copy of it was a live outage.
import { isMissingTableError } from '~/server/services/blocks/app-access.service';
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
   * `customComfy:seamless-pano-360`, `customComfy:inline`, a bare registered
   * STEP ID (`convert-image`, `chat-completion`), or `step:<orchestrator $type>`
   * on the PASS-THROUGH step arm. The COARSE key is everything before the FIRST
   * colon and is what a per-generation-type fee keys on;
   * `blockGenerationCoarseType` is the one place that decomposition lives.
   * Resolved by the caller from the submitted workflow body via
   * `resolveBlockGenerationType`; omit (or pass null) when it cannot be
   * resolved, which persists NULL. Typed as the union rather than `string` so a
   * future caller cannot stamp an arbitrary value on a money/audit row.
   *
   * 🔴 ONE ARM'S SUBTYPE IS CALLER-SUPPLIED, AND A FEE MUST KEY ON THE COARSE KEY
   * FOR EXACTLY THAT REASON. This doc used to say "NEVER the orchestrator's
   * internal `$type`", and that is now true of every arm EXCEPT the pass-through
   * one, which has no app-facing id at all — the `$type` is what the app wrote,
   * bounded by SHAPE only (see `generation-type.ts`'s THE ONE OPEN AXIS). So for
   * a `step:` value the segment after the colon is app-chosen, while the coarse
   * key is always the literal `step`. Keying anything on the FULL value would let
   * a caller choose its own group; `blockGenerationCoarseType` is the bound.
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
  /**
   * PRIVATE RUN of a delisted / suspended app — from the verified token's
   * `privateRun` claim. 🔴 When true, **NO ROW IS WRITTEN AT ALL**: the function
   * returns `{ written: false, row: null }` before the row is built.
   *
   * ⚠️ THIS DOCBLOCK DESCRIBED THE OPPOSITE UNTIL THE WRITE-SIDE CHANGE, AND IT IS
   * THE ONE A CALLER READS WHEN DECIDING WHETHER TO PASS `privateRun` — so the four
   * claims it made are recorded here rather than silently dropped. It said: "the row
   * is written `voided` instead of `tracked`"; "🔴 THE ROW IS STILL WRITTEN, AND THAT
   * IS DELIBERATE"; "a voided row preserves the audit trail at zero money cost"; and
   * "✅ THE VOID NOW DELIVERS THE PROTECTION". All four are now false. They were
   * missed by the commit that corrected four sibling claims in other files — the
   * stale text was three lines above the code that falsified it, which is exactly
   * where a sweep keyed on the changed hunk does not look.
   *
   * WHAT SURVIVES FROM IT, because it is still true and still load-bearing: the mod
   * review sandbox's alternative — a non-resolving synthetic `appId` — is deliberately
   * NOT copied here, because it would also break per-app storage namespacing, the
   * `page_<appBlockId>` ban-revocation instance id, and every runtime metric label.
   * The real ids are resolved and the rail is closed by an explicit branch instead.
   *
   * NO MONEY MOVES EITHER WAY: `spendSharePct` and `appOwnerShareCents` are hardcoded
   * 0 below, so this was never a payout decision. What it protects is the RUN COUNT
   * and BUZZ SUM a suspended app's owner can see.
   *
   * ⚠️ ONE OBSERVABILITY CONSEQUENCE, NOT PREVIOUSLY NAMED: the early return precedes
   * `blockSpendAttributionWriteCounter.inc({ status })`, so a private-run generation
   * now increments NOTHING on that counter, where it previously landed in
   * `status="voided"`. Per-generation coverage survives via `block_scope_invocations`
   * rows carrying `source: 'private-run'`.
   *
   * 🔴 THE FILTER WAS HELD FOR TWO STATED REASONS AND BOTH WERE SETTLED BY
   * MEASUREMENT, NOT BY DECISION — recorded because the reasons read as permanent
   * and were not.
   *   · "It drops the large majority of existing rows and Buzz." TRUE, and it
   *     shipped anyway: 639 rows to 57 (91.08%), 4,738 Buzz to 268 (94.34%). What
   *     made that acceptable is a partition nobody had measured — EVERY voided row
   *     is `self_spend` with `app_owner_user_id = user_id`, i.e. an owner spending
   *     on their own app, and no row of real third-party usage is voided at all.
   *     The filter removes self-testing, not usage.
   *   · "A second consumer of this table lives outside this repo." REAL and still
   *     live, and it was never IDENTIFIED, which is most of why it blocked
   *     anything. It is an OPERATOR-facing analytics digest job outside this repo,
   *     which queries this table directly for a periodic internal summary. Its
   *     Buzz sums already excluded voided rows while its run counts did not; that
   *     half was fixed in the same sweep, as an independent change in that repo.
   *     It is not owner-facing, so it never gated the disclosure this arm is
   *     about. (Kept deliberately unspecific — this repo is public, so the
   *     infrastructure detail belongs in that repo's own commit, not here.)
   *
   * The ordering requirement that used to live here is DISCHARGED: the filter had
   * to land before `app-blocks-private-run-enabled` became anything other than
   * `false`, and it has. The flag's own precondition block in `app-blocks-flag.ts`
   * is the authoritative, kept-current record of what remains — read it there
   * rather than here, because this docblock cannot be kept current and has twice
   * been caught asserting a state that had already changed.
   *
   * ✅ AND THE WIDER LEAK IS ALSO CLOSED, which is a correction to what this
   * paragraph used to claim. `block_scope_invocations` rows are written by
   * `withBlockScope` for EVERY scoped call, carrying the real `app_block_id` and
   * the VIEWER's `user_id`, and `app-analytics.service.ts` reads them into the
   * owner-visible panel through FIVE queries: the engagement count, a raw
   * `count(DISTINCT user_id)`, the error count, and the two top-5 groupings. This
   * text used to say there was "no marker on those rows to filter ON" and that
   * closing it "needs a migration" — BOTH WERE WRONG. The rows carry a `source`
   * marker on an EXISTING nullable-free column (`TEXT NOT NULL DEFAULT
   * 'app-block'`, no CHECK constraint), so no DDL and no per-environment
   * hand-apply was needed, and all five reads exclude it. The canonical reasoning
   * is at `blocks/scope-activity-predicate.ts`.
   *
   * Absent/false → byte-identical to the pre-feature behaviour.
   */
  privateRun?: boolean | null;
};

export type RecordSpendAttributionResult = {
  /**
   * False when the (workflow, app) UNIQUE blocked a duplicate write, AND when the call
   * was a PRIVATE RUN, for which no row is written at all.
   */
  written: boolean;
  /**
   * 🔴 `null` ONLY for a private run, where the write is skipped entirely (see the
   * write-side exclusion in `recordSpendAttribution`). Every other path — including the
   * duplicate branch — still returns the row it found or created.
   *
   * Nullable rather than synthesised: inventing a zeroed row to keep the type simple
   * would make "no attribution exists" indistinguishable from "an attribution of zero",
   * which is exactly the conflation the write-side exclusion is meant to remove. All four
   * production callers `await` this and discard the result, so the nullability costs them
   * nothing today and forces a decision on any future reader.
   */
  row: {
    id: string;
    status: string;
    appOwnerShareCents: number;
    spendSharePct: number;
    grossValueCents: number;
    rateCardVersion: string;
    voidedReason: string | null;
  } | null;
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
    privateRun = false,
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
  // in the closed set that key allows, EXCEPT under the `step` coarse key, whose
  // subtype axis is open and bounded by shape (a caller-supplied orchestrator
  // `$type`; see `generation-type.ts`'s THE ONE OPEN AXIS). A caller assembling a
  // value by hand (a cast, a future writer, a string built from a registry
  // lookup) type-checks and is still refused here.
  //
  // 🔴 AND THE TYPE IS NOW STRICTLY WIDER THAN THE RUNTIME BOUND, which makes
  // this line load-bearing rather than belt-and-braces: `BlockGenerationType`
  // includes the template literal `step:${string}`, because no type can express
  // "matches this regex". So `'step:a b'` and a 200-char subtype both TYPE-CHECK
  // at every call site and are refused only here and in the producer.
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
  // 'tracked'. ⚠️ NOT "share-pending awaiting a payout-time backpay" — that was the
  // removed spend bounty. No backpay reads this table; 'tracked' is where a spend row
  // stays. The void/track distinction is kept because it is the self-spend /
  // internal-owner marker the analytics reader and any future rail would both need,
  // and voiding costs nothing.
  //
  // ⚠️ TWO PARAGRAPHS THAT STOOD HERE WERE DELETED RATHER THAN REWORDED, AND WHAT THEY
  // CLAIMED IS WORTH KNOWING BECAUSE IT READS AS STILL-TRUE ELSEWHERE IN THE TREE.
  // They explained (a) that the private-run arm was TESTED FIRST, as a
  // "discriminability choice" deciding the LABEL on an owner's own private run where
  // both that arm and `isSelfSpend` are true, and (b) that `'manual_review'` was REUSED
  // rather than adding a `'private_run'` value, so the change shipped with no migration.
  //
  // Both described the VOIDED-ROW design. A private run now writes NO ROW (see the
  // exclusion below), so there is no arm to order and no column to carry a value: (a)
  // describes an ordering that no longer exists and (b) a write that no longer happens.
  // Neither is reworded here, because a reworded version would be a fresh rationale for
  // a decision that has been superseded rather than revised.
  //
  // ⚠️ RETRACTED CLAIM, KEPT SO IT IS NOT RE-DERIVED. This said: "`'manual_review'` IS
  // STILL WRITTEN TO THIS COLUMN BY ANOTHER PRODUCER — `backpay.service.ts` writes
  // `status: 'held', voidedReason: 'manual_review'`", offered as a second reason the
  // read-side filters stay necessary. 🔴 IT IS FALSE ON BOTH HALVES. `backpay.service.ts`
  // writes to `blockSubscriptionAttribution` — a DIFFERENT TABLE — and with
  // `status: 'held'`, not `voided`; the owner-visible filter keys on `status`, so such a
  // row would not be excluded by it in any case. The sentence refuted itself: a
  // `status: 'held'` write cannot produce a voided row.
  //
  // 🔴 THE HONEST POSITION, which is simpler than the one I reached for: the filters stay
  // because of `self_spend` and `internal_owner`, which are written HERE, below, and are
  // the whole live voided population — the ledger's own measurement is 582 of 639 rows,
  // "every voided row is `self_spend`". A historical private-run population is NOT a
  // reason either: the flag has been base-off with no rollout for its whole life, so no
  // private run ever wrote a row. There is one real reason, not three, and reaching for
  // extra ones is what produced a false claim while correcting other false claims.
  // ── PRIVATE RUN — NOT WRITTEN AT ALL ────────────────────────────────────────────
  // 🔴 WRITE-SIDE EXCLUSION, NOT A VOIDED ROW. This used to write the row with
  // `voidedReason: 'manual_review'` and rely on EVERY reader filtering voided rows back
  // out. That is the design that generated this rail's worst defects: the nullability
  // trap (`NOT (voided_reason IN (…))` retains 0 of 639 rows, because `voided_reason` is
  // nullable and NULL *is* the ordinary tracked population), the latent
  // `internalAppOwnerUserIds` trap in `rate-card.ts`, and a cross-repo coupling to
  // talos-infra's `civitai-app-blocks-digest/digest.py`. Read-side exclusion has to be
  // got right in every reader, in two repos, forever; write-side is got right once.
  //
  // 🔴 EQUIVALENT FOR EVERY FILTERED READER, STRICTLY BETTER FOR AN UNFILTERED ONE. A
  // voided row and an absent row are indistinguishable to any reader that excludes
  // voided — which is all of the owner-visible ones. For a reader that forgets the
  // filter, an absent row is the SAFE failure and a voided row is the leak. That
  // asymmetry is the whole argument.
  //
  // ⚠️ WHAT IS GIVEN UP, NAMED RATHER THAN GLOSSED: the voided row was a durable,
  // queryable record that a private run happened. That record now exists ONLY in the
  // `app-blocks.private-run.mint` audit line (dual-sinked to Axiom and stdout), which was
  // already the discriminating record — the operator decision to reuse `'manual_review'`
  // said so in its own words, because the column could not distinguish a private run from
  // an operator-voided row anyway. So the queryable-by-SQL property is lost; the audit
  // property is not.
  //
  // NOTHING IS PAID EITHER WAY: `spendSharePct` and `appOwnerShareCents` are hardcoded 0
  // above, and the AUTHOR FEE — the rail that does move Buzz — is excluded separately and
  // earlier, by `resolveBlockAuthorFeePayee` refusing with reason `private-run`.
  //
  // IDEMPOTENCY IS UNAFFECTED: the dedupe is the `(workflowId, appBlockId)` UNIQUE
  // constraint, i.e. the row IS the dedupe record. Writing zero rows cannot double-count.
  if (privateRun === true) {
    return { written: false, row: null };
  }

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

    // PER-GENERATION AUTHOR FEE — OBSERVATION ONLY, BUT NOT OF A DARK RAIL.
    // Computes what the additive, author-set, viewer-paid fee WOULD be for this
    // generation and reports it to the counters + the log line below. THIS CALL
    // moves no money, writes no column, and is unreachable unless
    // `app-blocks-author-fee-enabled` is on. ⚠️ An earlier revision added
    // "settlement onto the licensing-fee rail is a later slice; this exists so
    // that slice can be sized from real traffic before anyone is charged".
    // Settlement has shipped and viewers ARE charged, on the submit path via
    // `quoteBlockAuthorFee`; what this call buys now is sizing of a LIVE fee.
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
    // ⚠️ AT SETTLEMENT a self-spend would be a Buzz transaction from an account
    // to ITSELF, at best a no-op and possibly rejected. That is no longer a
    // flag-for-later: the charge path handles it, and
    // `resolveBlockAuthorFeePayee` is where a self-dealing author is excluded.
    // This observation is unaffected — it carries no recipient, and `isSelfSpend`
    // is already on the log line beside the fee.
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
    // 🔴 `privateRun` IS DELIBERATELY *NOT* THREADED INTO THE OBSERVATION, AND THIS
    // IS THE ONLY REMAINING ASYMMETRY IN THE FEE FAMILY. A review lane raised it;
    // the decision is to leave it and record why, because both the size and the
    // shape of the right fix depend on something that cannot exist yet.
    //
    // WHAT THE ASYMMETRY IS: the CHARGE and QUOTE counters exclude a private run
    // (their payee resolve refuses with `private-run`), so this observation would
    // count private-run volume that they do not — biasing the observed-vs-quoted
    // ratio a later pricing decision reads.
    //
    // WHY NOT NOW: the bias is EXACTLY ZERO today, not merely small. No mint can
    // produce the claim, so no private run can reach this line. And the fix is not
    // free to do correctly — the note above is explicit that a new case here needs a
    // NEW skip reason of its own and must never be folded into an existing member of
    // `BlockAuthorFeeSkipReason`, because every reason in that union is a live
    // population the sizing read divides by. Adding a reason for a population of
    // zero is how a denominator acquires an empty category nobody can interpret.
    //
    // WHEN: with the mint, in the PR that makes a private run possible — at which
    // point the volume is measurable and the new reason has something to count.
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
        // 🔴 SHAPE-bounded or null — NOT "registry-derived", which is what this
        // line used to claim and is no longer true of one arm. A `step:` value's
        // subtype is a caller-supplied orchestrator `$type`, bounded by
        // `isBlockGenerationType` to ≤64 chars of `[A-Za-z0-9._-]` and nothing
        // else.
        //
        // ⚠️ THE SHAPE BOUND IS NOT WHAT MAKES IT SAFE HERE, and a draft of this
        // comment said it was. `logToAxiom` builds the line with a single
        // `JSON.stringify` (`@civitai/axiom`'s client, measured), so this value is
        // an escaped JSON string VALUE and a newline or a quote in it could not
        // break the line whatever the class admitted. What the bound actually buys
        // downstream is bounded WIDTH and no unicode/control junk in a column
        // future consumers will group and display.
        //
        // What does NOT follow, and is the reason this note exists: do not make it
        // a metric LABEL or an object KEY. The subtype is app-chosen and
        // open-ended, so it has no cardinality budget, and it admits prototype key
        // names (`step:__proto__` is an accepted value).
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

// ---------------------------------------------------------------
// DIGITAL GOODS sales — the read-side bridge onto the owner's revenue page
// ---------------------------------------------------------------

/**
 * One bucket of an owner's digital-goods sales.
 *
 * 🔴 BUZZ IS THE PRIMARY UNIT HERE AND USD IS DERIVED, which is the opposite of
 * every bucket above. It is not a style choice — cents CANNOT REPRESENT a small
 * sale. 1,000 Buzz = $1, so one cent is 10 Buzz, and the minimum priced good
 * (`BLOCK_GOOD_MIN_PRICE_BUZZ`) is 2 Buzz. A 10-Buzz good pays its owner 7 Buzz,
 * and `buzzSpendToUsdCents(7)` is **0** — so a cents-only line renders `$0.00`
 * beside a sale that happened, which is the same invisible-revenue bug this
 * bridge exists to fix, one layer down. The renderer therefore shows Buzz and
 * treats the cents figure as an approximation (see `RevenuePanel`).
 */
export type GoodsSalesBucket = {
  count: number;
  /** What buyers paid, in whole Buzz. */
  grossBuzz: number;
  /** The owner's recorded share of that, in whole Buzz. */
  shareBuzz: number;
};

/**
 * Why the goods bucket carries its OWN unavailable reason instead of reusing the
 * payload-level `RevenueUnavailableReason`.
 *
 * `block_good_purchase` is applied by hand per environment (the migration says so
 * in its own header), so an environment can legitimately be running this code
 * against a database that has no such table. Before this value existed, that made
 * the whole of `getMyRevenue` throw and took BOTH revenue pages down — including
 * the card-purchase figures, which were fine.
 *
 * 🔴 AND THE OBVIOUS FIX IS THE BUG: catching the error and returning
 * `emptyGoodsSales()` would report "no sales" for a rail that was never read,
 * which is exactly the fabricated zero the payload-level discriminator above
 * exists to prevent. So the failure is REPORTED, not zeroed, and the renderer has
 * a branch for it.
 *
 * Deliberately NOT a new value on `RevenueUnavailableReason`: that union
 * describes the whole payload being a placeholder, and this is one bucket of a
 * payload whose other buckets are real measurements.
 */
export type GoodsUnavailableReason = 'unreadable';

export type GoodsSalesSummary = {
  /**
   * `status = 'paid'` ONLY. `pending` and `refunded` are both excluded, and both
   * exclusions are load-bearing rather than tidy-up:
   *   - `refunded` — the debit was reversed, so counting it reports money the
   *     buyer got back as the owner's earnings.
   *   - `pending` — the charge outcome is unknown; it is a reconciliation record,
   *     not a sale. Counting it inflates earnings off a charge that may never
   *     have landed.
   */
  sales: GoodsSalesBucket & {
    /**
     * `shareBuzz` converted ONCE, at the aggregate. Converting per row and then
     * summing floors N times instead of once and can lose up to 9 Buzz per sale
     * — on a rail whose typical sale is worth well under a dollar, that is most
     * of the number. Floored, so it never over-states.
     */
    shareUsdCents: number;
    /** `grossBuzz` converted once, at the aggregate. Same reasoning. */
    grossUsdCents: number;
    /**
     * How much of `grossBuzz` the buyers paid from their BLUE (granted) balance.
     *
     * 🔴 THIS IS WHY "Your share" CANNOT BE PRESENTED AS CASH. `blue_paid_buzz`
     * exists precisely so a viewer paying blue cannot turn non-withdrawable Buzz
     * into withdrawable earnings — `blueLegOfPayout` pays the owner's share
     * proportionally in blue, and blue is Generation Buzz, which cannot be banked.
     * The owner's share is therefore partly non-bankable exactly when this is
     * non-zero, and the USD figures above are then an upper bound on what could
     * ever be cashed, not a value.
     *
     * It is the GROSS blue total rather than the share's blue leg, and that is a
     * deliberate limitation: `blueLegOfPayout` floors per row, so
     * `sum(floor(...)) != floor(sum(...))` and the exact per-share blue split is
     * not expressible as a column sum. This answers the only question the
     * renderer asks of it — "does a colour caveat apply at all" — and must not be
     * displayed as if it were the owner's blue earnings.
     */
    blueGrossBuzz: number;
  };
  /**
   * Reversed rows, shown so the EXCLUSION is visible rather than silent — the
   * same job the `voided` bucket does for the card-purchase rail.
   *
   * 🔴 THIS IS NOT "REFUNDS". `status='refunded'` covers two shapes and the
   * column cannot tell them apart: a sale that was owned and then refunded, and a
   * charge that was REVERSED BEFORE ANY ENTITLEMENT WAS GRANTED (`voidReversedClaim`
   * stamps it onto a `pending` row whose debit failed or could not be confirmed —
   * no sale ever happened). The migration names the discriminator: whether a
   * `block_good_entitlement` points at the row. This aggregate does not join it,
   * so the copy must say "reversed or refunded" and must NOT call these sales.
   *
   * No share figure, and the reason is narrower than it looks: a refund normally
   * claws the owner's payout back, but `refundBlockGoodPurchase` records failed
   * clawback legs in `failures` and marks the row `refunded` anyway — so in that
   * case the owner did keep some of it. Quoting a share here would be a claim this
   * aggregate cannot support in either direction.
   */
  refunded: { count: number; grossBuzz: number };
  /**
   * Present ONLY when the bucket could not be read. Absent on every real
   * measurement, including a genuine all-zero one — same contract as the
   * payload-level `unavailable`.
   */
  unavailable?: GoodsUnavailableReason;
};

/**
 * The zeroed goods shape. Used by `emptyRevenue()` for the dark-flag
 * short-circuit, and by nothing else — it carries no `unavailable` of its own
 * because there the discriminator lives once, on the payload.
 */
export function emptyGoodsSales(): GoodsSalesSummary {
  return {
    sales: {
      count: 0,
      grossBuzz: 0,
      shareBuzz: 0,
      shareUsdCents: 0,
      grossUsdCents: 0,
      blueGrossBuzz: 0,
    },
    refunded: { count: 0, grossBuzz: 0 },
  };
}

/**
 * The bucket for "this rail could not be read". Zeros PLUS the discriminator, so
 * a consumer that forgets to branch shows zeros rather than crashing, and one
 * that does branch can say so honestly.
 */
export function unreadableGoodsSales(): GoodsSalesSummary {
  return { ...emptyGoodsSales(), unavailable: 'unreadable' };
}

/**
 * Is this error "the `block_good_purchase` table is not in this database"?
 *
 * 🔴 NARROW ON PURPOSE, AND THE WIDE VERSION WAS A REAL BUG. The caller catches
 * this to degrade the goods rail instead of failing the whole revenue page — but
 * the first version of that catch took EVERY rejection, which means a column
 * rename, a bad argument or a `TypeError` inside the aggregate would all have
 * been reported to the owner as "sales could not be loaded", politely, in
 * production, forever. That is the invisible-revenue bug this whole change exists
 * to fix, re-entering through the error path: a defect that hides itself behind a
 * message the owner has no reason to question.
 *
 * So only the ONE condition the degradation is justified for is caught. The
 * justification is specific — the migration's header says the table is applied by
 * hand per environment — and it does not generalise to anything else that can go
 * wrong in there.
 *
 * Matched by CODE OR MESSAGE, not `instanceof`: the branch has to stay reachable
 * under a mocked Prisma client, which does not construct the real error class.
 *   - `P2021` — Prisma's "table does not exist in the current database".
 *   - `42P01` — Postgres `undefined_table`, which is what surfaces if the read
 *     ever goes through a raw query instead.
 *   - the same SQLSTATE in the MESSAGE, because Prisma wraps the driver error and
 *     leaves the code unclassified on some paths.
 *
 * 🔴 DELEGATES, AND THE OPEN-CODED COPY THAT USED TO LIVE HERE WAS THE NARROWER
 * SPELLING OF THE TWO. It required `'code' in error` before anything else, so an
 * error carrying the SQLSTATE only in its message was rejected on the first line.
 * On such a path this returned false, the caller's `.catch` rethrew, `Promise.all`
 * rejected and `getMyRevenue` 500'd — taking BOTH owner revenue pages down,
 * including the card-purchase figures that were perfectly readable. Precisely the
 * outage the bounded catch exists to prevent, reached through the bound itself.
 *
 * {@link isMissingTableError} is the MEASURED version: its docblock records that
 * "a check on P2021 alone let a raw-path failure through in local testing", and its
 * message branch is deliberately narrower than "does not exist" — it requires the
 * missing object to be named as a RELATION or TABLE and refuses anything mentioning
 * a column, because a column error is a HALF-APPLIED manual migration and must
 * surface rather than degrade to a silent zero. That nuance is the reason to reuse
 * it rather than re-derive it; do not re-widen it here.
 */
export function isMissingGoodsTableError(error: unknown): boolean {
  return isMissingTableError(error);
}

/**
 * An owner's digital-goods sales, for the publisher revenue pages.
 *
 * 🔴 READ-SIDE ONLY, DELIBERATELY. The goods rail records into
 * `block_good_purchase` and writes no `BlockBuzzAttribution` row; this function
 * is the bridge, and it bridges by QUERYING rather than by back-filling
 * attribution rows. That choice is the point: writing an attribution row per
 * sale would require deciding whether a sale "is an attribution", risks
 * double-counting against this table, and is a write-path change on a money
 * rail that cannot be undone once rows exist. A second read commits to nothing
 * and can be removed by deleting this function.
 *
 * 🔴 OWNERSHIP IS THE WHERE CLAUSE, exactly as in `getRevenueForOwner`:
 * `appOwnerUserId: ownerUserId` scopes every bucket, so a caller asking about an
 * app they do not own gets a truthful zero rather than someone else's revenue.
 * `app_owner_user_id` is snapshotted at purchase time, so an ex-owner keeps
 * seeing what they earned before transferring the app away — the same property
 * the write path chose it for.
 *
 * ⚠️ WHAT THIS DOES NOT MEASURE: whether the owner's Buzz actually LANDED.
 * `shareBuzz` sums `app_owner_share_buzz`, the recorded obligation, which is
 * what the conservation CHECK guarantees and what a refund reverses. A payout
 * whose ledger leg failed leaves the row `paid` with `payouts` short of that
 * figure (`owesOwnerPayout`), and this aggregate cannot see the shortfall — a
 * JSONB sum is not expressible in a Prisma aggregate, and there is no re-runner
 * for those rows anyway. So `shareBuzz` is "earned", on the same reading as the
 * `confirmed` bucket above, which is also an accrual rather than a delivery. Do
 * not relabel it as "received" without measuring `payouts`.
 *
 * The date range filters `created_at` — the sale's own timestamp. There is no
 * `attributed_at` on this table because there is no attribution row.
 */
export async function getGoodsSalesForOwner({
  ownerUserId,
  appBlockId,
  from,
  to,
}: {
  ownerUserId: number;
  appBlockId?: string;
  from?: Date;
  to?: Date;
}): Promise<GoodsSalesSummary> {
  const rows = await dbRead.blockGoodPurchase.groupBy({
    by: ['status'],
    where: {
      appOwnerUserId: ownerUserId,
      ...(appBlockId ? { appBlockId } : {}),
      ...(from || to
        ? {
            createdAt: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
    },
    _sum: { priceBuzz: true, appOwnerShareBuzz: true, bluePaidBuzz: true },
    _count: true,
  });

  // ONE round trip for every status bucket — one pass bucketed by the database,
  // rather than `getRevenueForOwner`'s five single-status aggregates over the same
  // rows.
  //
  // ⚠️ ON THE INDEX, stated precisely because the migration's own comment is
  // easy to over-read: `bgp_owner_idx` (`app_owner_user_id`, `created_at` DESC)
  // IS used — `GROUP BY status` does not defeat it, since the owner id is an
  // index condition and the grouping happens above — but it makes this read
  // INDEX-DRIVEN, not CHEAP. The index supplies only TIDs, so `status` and both
  // summed columns need a heap visit per row, and on an append-only ledger the
  // owner's rows are scattered. Measured on a 2M-row fixture: ~1 buffer per sale
  // the owner has ever made, so an owner with ~50k lifetime sales touches most of
  // the table. A covering index fixes it (~100x fewer buffers) and is NOT applied
  // — at single-digit rows it would be disk spent on nothing. The trigger to
  // revisit is a single owner crossing ~1,000 lifetime sales.
  //
  // NO `as` CAST, deliberately, unlike `getRevenueForOwner` above. An assertion on
  // a money aggregate hides exactly the mistake that matters: `_count` is a
  // COUNT-OBJECT when you select fields and a plain `number` only when you pass
  // `true`, so a cast that guessed wrong would read an object as a sale count and
  // render it as such. The generated client already types this precisely — the
  // groupBy payload maps `_count` to `number` when the argument is a boolean — so
  // letting inference do the work is what makes the `number` below checked rather
  // than asserted.
  const byStatus = new Map(rows.map((r) => [r.status, r] as const));

  const paid = byStatus.get(BLOCK_GOOD_PURCHASE_STATUS.paid);
  const refunded = byStatus.get(BLOCK_GOOD_PURCHASE_STATUS.refunded);
  // `BLOCK_GOOD_PURCHASE_STATUS.pending` is read by nothing here, on purpose —
  // see the `sales` docblock. It is left in `byStatus` rather than filtered out
  // of the query so that a future bucket is a lookup, not a second round trip.

  const grossBuzz = paid?._sum.priceBuzz ?? 0;
  const shareBuzz = paid?._sum.appOwnerShareBuzz ?? 0;

  return {
    sales: {
      count: paid?._count ?? 0,
      grossBuzz,
      shareBuzz,
      shareUsdCents: buzzSpendToUsdCents(shareBuzz),
      grossUsdCents: buzzSpendToUsdCents(grossBuzz),
      blueGrossBuzz: paid?._sum.bluePaidBuzz ?? 0,
    },
    refunded: {
      count: refunded?._count ?? 0,
      grossBuzz: refunded?._sum.priceBuzz ?? 0,
    },
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
   * Zeroed like every other bucket, and for the same reason: on THIS type the
   * zeros are a placeholder, and `unavailable` is what says so. A missing key
   * here would be worse than a zero — the panel would have no goods figure to
   * suppress and could render the dark-flag case as "no sales".
   */
  goods: GoodsSalesSummary;
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
    goods: emptyGoodsSales(),
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
