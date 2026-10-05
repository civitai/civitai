import type { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  createBuzzTransaction,
  createMultiAccountBuzzTransaction,
  refundMultiAccountTransaction,
  refundTransaction,
} from '~/server/services/buzz.service';
import { getBuzzApiStatus } from '~/server/utils/buzz-error';
import { withRetries } from '~/server/utils/errorHandling';
import { TransactionType } from '~/shared/constants/buzz.constants';
import type { BuzzAccountType } from '~/shared/constants/buzz.constants';
import {
  BLOCK_GOOD_PURCHASE_STATUS,
  blueLegOfPayout,
  computeBlockGoodSplit,
  findManifestGood,
  maxPriceBuzzForKind,
} from '~/shared/constants/block-goods.constants';
import type { BlockGoodDeclaration } from '~/shared/constants/block-goods.constants';
import { newBlockGoodEntitlementId, newBlockGoodPurchaseId } from '~/server/utils/app-block-ids';

/**
 * App Blocks DIGITAL GOODS — the purchase and entitlement rail.
 *
 * The platform sells a manifest-declared entitlement to a viewer for Buzz, on
 * an app's behalf, and owns the ledger. The good's MEANING is the app's
 * business: the entitlement carries an opaque, manifest-sourced payload the
 * platform never interprets.
 *
 * 🔴 EVERY MONEY INPUT IS SERVER-DERIVED (FIN-1). The buyer is the verified
 * block-token subject; the app, its owner, the good and its price come from the
 * APPROVED AppBlock row that `claims.appBlockId` names. Nothing here reads a
 * client-supplied user id, app id, owner or price. The only client input that
 * reaches a decision is the `goodId` — a lookup key into a review-gated catalog
 * — and an optional `expectedPriceBuzz`, which can only cause a REFUSAL.
 *
 * 🔴 THE PAYOUT IS IMMEDIATE, in the same request, mirroring
 * `purchaseCosmeticShopItem`: buyer → bank (`Purchase`), bank → app owner
 * (`Sell`), split proportionally across the colours the buyer actually paid in.
 * There is no settlement job. What was actually paid is RECORDED on the
 * purchase row so a refund reverses those exact transactions instead of
 * re-deriving a split that may no longer produce the same numbers.
 */

export const BLOCK_GOODS_LOG_NAME = 'block-goods';

// 🔴 DEFENCE IN DEPTH, NOT THE DECISION. `withBlockScope` already resolved the
// approved-status verdict for this request (`resolveRestApprovalVerdict` in
// `src/server/middleware/block-scope.middleware.ts`), and that predicate — not
// this literal — is the one place the REST surface decides it. This check exists
// for a future non-HTTP caller (a mod tool, a job) that does not pass through the
// middleware; it must never be the reason a purchase is allowed.
const APP_BLOCK_APPROVED_STATUS = 'approved';
/**
 * Local names for the SHARED status domain, kept so the eleven call sites below
 * read unchanged. The values are no longer declared here: the owner-earnings
 * read in `buzz-attribution.service.ts` filters on the same three strings, and
 * two independent spellings of a money status is how one of them ends up wrong.
 * See `BLOCK_GOOD_PURCHASE_STATUS` for what each value means.
 */
/** Claimed, charge outcome not yet settled. See `purchaseBlockGood`. */
const PURCHASE_STATUS_PENDING = BLOCK_GOOD_PURCHASE_STATUS.pending;
const PURCHASE_STATUS_PAID = BLOCK_GOOD_PURCHASE_STATUS.paid;
const PURCHASE_STATUS_REFUNDED = BLOCK_GOOD_PURCHASE_STATUS.refunded;

/** What was actually paid to one recipient, in one colour. */
export type BlockGoodPayout = {
  userId: number;
  amount: number;
  color: BuzzAccountType;
  transactionId?: string;
};

export type ResolvedBlockGood = {
  appId: string;
  appOwnerUserId: number;
  manifestVersion: string;
  good: BlockGoodDeclaration;
};

export type PurchaseBlockGoodInput = {
  /** The verified token subject. Never a body field. */
  buyerUserId: number;
  /** From `claims.appBlockId`. Never a body field. */
  appBlockId: string;
  /** From `claims.blockInstanceId`; attribution only, and allowed to be unresolvable. */
  blockInstanceId?: string | null;
  goodId: string;
  /**
   * The server-derived catalog entry, from `resolveBlockGoodForPurchase`.
   *
   * 🔴 PASSED IN RATHER THAN RE-READ, so the price the caller reserved the
   * viewer's daily cap against and the price actually charged are the SAME
   * read. Resolving twice opens a window in which an approved re-price lands
   * between them and the reservation no longer matches the charge.
   */
  resolved: ResolvedBlockGood;
  /** Optional confirm-the-price guard: a mismatch refuses rather than charges. */
  expectedPriceBuzz?: number;
  /** Buzz colours the buyer may pay from, in preference order. */
  payWith: BuzzAccountType[];
};

/**
 * What this attempt KNOWS about the buyer's Buzz when it refuses.
 *
 * 🔴 THE CALLER MUST BRANCH ON THIS, NEVER ON THE STATUS CLASS. "Every UNKNOWN
 * outcome is a 5xx" is true; its converse is not, and the endpoint relied on
 * the converse: a claim INSERT that failed before any charge, and a settle that
 * failed after the charge was REVERSED, are both `charge_failed` 500s with a
 * perfectly KNOWN outcome. Reading 5xx as "may have moved" leaked the viewer's
 * daily-cap reservation on both, and — worse — classified both as terminal so
 * the idempotency layer cached the 500 for its full TTL and replayed it instead
 * of letting the retry through.
 *
 * - `none`     nothing was debited on this attempt.
 * - `reversed` a debit landed and this attempt reversed it.
 * - `unknown`  we cannot say whether a debit landed. The `pending` row survives.
 */
export type PurchaseChargeOutcome = 'none' | 'reversed' | 'unknown';

export type PurchaseBlockGoodRefusal = {
  ok: false;
  status: number;
  error: string;
  reason: PurchaseRefusalReason;
  charge: PurchaseChargeOutcome;
  /**
   * An identical retry could reach a DIFFERENT verdict, so this outcome must
   * not be cached under an idempotency key. Independent of `charge`: an unknown
   * outcome is retryable because no verdict was ever reached, while a reversed
   * partial debit is retryable because the next attempt can land in full.
   */
  retryable: boolean;
};

export type PurchaseBlockGoodResult =
  | {
      ok: true;
      status: 200;
      purchaseId: string;
      goodId: string;
      priceBuzz: number;
      entitlement: SerializedEntitlement;
    }
  | PurchaseBlockGoodRefusal;

/**
 * Why a purchase was refused.
 *
 * 🔴 CALLED `reason`, NOT `code`, DELIBERATELY. `code` is the key the repo's REST
 * error envelope owns (`src/server/utils/rest-error-envelope.ts`), and the values
 * it carries there are tRPC error-code strings so that the REST and tRPC surfaces
 * agree instead of inventing a second vocabulary. Putting a different vocabulary
 * on that same key is how a client that branches on `code` across two block
 * routes starts getting two meanings.
 */
export type PurchaseRefusalReason =
  | 'good_not_found'
  | 'price_changed'
  | 'price_over_cap'
  | 'already_owned'
  | 'self_purchase'
  | 'insufficient_funds'
  | 'duplicate'
  | 'pending_reconciliation'
  /**
   * The ledger refused the debit because this generation's external id is
   * already occupied — including by a transaction that was REVERSED, which
   * stays occupied. Distinct from `insufficient_funds` because the two say
   * opposite things to the viewer: one is "top up", this one is "nothing you
   * can do". Collapsing them told a viewer with plenty of Buzz they were broke.
   */
  | 'ledger_conflict'
  | 'charge_unknown'
  | 'charge_failed';

export type SerializedEntitlement = {
  goodId: string;
  kind: string;
  payload: unknown;
  grantedAt: string;
};

/**
 * The SERVER-TRUSTED resolution of a purchase: which app, which owner, which
 * good, at what price. Everything a charge needs, derived from `appBlockId`
 * alone.
 *
 * Returns null when the app is missing, not approved, or its manifest does not
 * currently declare a valid good under that id — which is also how a good
 * removed or broken by a later approved version stops being sellable, with no
 * separate delisting step.
 *
 * 🔴 IT READS THE LIVE MANIFEST AND IGNORES `BlockUserSubscription.pinnedVersion`
 * — a KNOWN divergence, recorded here rather than left to be discovered. A pinned
 * install's iframe renders v1's catalog while this charges v2's price, and a good
 * added in v2 is buyable by a viewer who was never shown it. `expectedPriceBuzz`
 * blunts the first half only, and it is optional. Resolving through the pinned
 * manifest is what `BlockRegistryService.applyPinnedVersion` exists for (it was
 * added because a v2 approve silently took effect on pinned installs — the C2
 * escalation); wiring it here needs the subscription, which needs instance
 * resolution, and that is the PR that adds the host wiring.
 *
 * ⚠️ It also costs TWO round trips, not one: `app: { select: { userId } }` is a
 * nested to-one relation and this schema has no `relationJoins`, so Prisma
 * resolves it separately. `block-approval.service.ts` documents the same and the
 * separate-query alternative costs the same, so this is noted rather than fixed.
 */
export async function resolveBlockGoodForPurchase(args: {
  appBlockId: string;
  goodId: string;
}): Promise<ResolvedBlockGood | null> {
  const appBlock = await dbRead.appBlock.findUnique({
    where: { id: args.appBlockId },
    select: {
      appId: true,
      status: true,
      version: true,
      manifest: true,
      app: { select: { userId: true } },
    },
  });
  if (!appBlock || appBlock.status !== APP_BLOCK_APPROVED_STATUS) return null;
  if (!appBlock.app?.userId) return null;

  const manifest = appBlock.manifest;
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) return null;

  const good = findManifestGood(manifest as { goods?: unknown }, args.goodId);
  if (!good) return null;

  return {
    appId: appBlock.appId,
    appOwnerUserId: appBlock.app.userId,
    manifestVersion: appBlock.version,
    good,
  };
}

export type BlockGoodLedgerKeyArgs = {
  appBlockId: string;
  goodId: string;
  buyerUserId: number;
  /** The id of the purchase generation this one replaces, when re-buying. */
  supersedesPurchaseId?: string | null;
};

/**
 * The `:`-separated stem every ledger id for one purchase generation is built
 * from. Not exported: the two things that may be spent under it are the buyer's
 * debit (`blockGoodPurchaseKey`) and the owner's credit legs
 * (`blockGoodPayoutTransactionId`), and both live here so the disjointness
 * argument below is checkable in one place.
 */
function blockGoodLedgerStem(args: BlockGoodLedgerKeyArgs): string {
  const base = `block-good:${args.appBlockId}:${args.goodId}:${args.buyerUserId}`;
  return args.supersedesPurchaseId ? `${base}:after:${args.supersedesPurchaseId}` : base;
}

/**
 * The deterministic ledger key a purchase is charged under.
 *
 * 🔴 EVERY ID BUILT HERE IS PREFIX-FREE AGAINST EVERY OTHER, AND THAT IS A
 * CORRECTNESS REQUIREMENT, NOT TIDINESS. `externalTransactionIdPrefix` — what
 * `rollbackCharge` and `refundBlockGoodPurchase` pass to
 * `refundMultiAccountTransaction` — selects a whole FAMILY of ledger rows, the
 * same hazard `challenge-funding.ts` records for `challenge-entry-fee-5-` vs
 * challenge 50. An unterminated trailing buyer id made buyer 5's key cover
 * buyers 51's and 500's, so rolling back one attempt reversed OTHER buyers'
 * settled purchases: they kept their entitlements, got their Buzz back, the
 * owner kept the 70%, and nothing raised.
 *
 * ⚠ CORRECTED: IT IS NOT A `StartsWith`, AND THE LEDGER DOES NOT STORE THE ID
 * WE SEND. This comment said "a genuine STRING prefix match" through four audit
 * rounds; the Buzz service (`civitai-buzz`, `src/Civitai.Buzz.Api/Program.cs`)
 * actually does:
 *   - on `POST /multi-transactions`, it STORES
 *     `$"{ExternalTransactionIdPrefix}-{accountType}"` — appending a suffix
 *     AFTER our terminator. The single-transaction endpoint the payout legs use
 *     matches `ExternalTransactionId` exactly and appends nothing, so a BUY leg
 *     is stored suffixed and a SELL leg verbatim.
 *     ⚠ THE SUFFIX IS A C# ENUM NAME, NOT OUR LOWERCASE WIRE VALUE, AND FOR
 *     THIS RAIL IT IS DETERMINATE: `-Generation` and `-User`.
 *     `AccountType` (`Civitai.Buzz.Infrastructure/Entities/AccountType.cs`)
 *     declares `User = 0` / `Yellow = 0` and `Generation = 3` / `Blue = 3` as
 *     duplicate-valued ALIASES; `ToString()` on a duplicate value renders the
 *     FIRST-DECLARED name, so 0 renders `User` and 3 renders `Generation`. We
 *     send `payWith: ['blue', 'yellow']` and the client passes the PLURAL
 *     `fromAccountTypes` through unmapped (`toApiTransaction` maps only the
 *     singular from/to types), so Buzz's `JsonStringEnumConverter` resolves
 *     them to 3 and 0 — hence exactly those two suffixes.
 *     🔴 TWO EARLIER DRAFTS OF THIS SENTENCE WERE WRONG AND ARE RECORDED SO
 *     NOBODY DERIVES A THIRD: (1) `-blue` / `-yellow`, i.e. our lowercase wire
 *     values, which the enum never renders; (2) "whichever name the runtime
 *     resolves … the live ledger carries `-Yellow`, `-Blue`, `-User` AND
 *     `-Generation`. We do not control which." That second one rested on a
 *     ledger-wide substring count, which mixes producers: the `-Yellow` /
 *     `-Blue` rows are built by `src/server/jobs/deliver-creator-compensation.ts`
 *     from PascalCase ClickHouse account types, not by this endpoint. An
 *     ungrouped aggregate over a table with more than one writer is not
 *     evidence about one writer.
 *     What the safety argument needs is only that every suffix begins `-`.
 *   - on `POST /multi-transactions/refund`, it selects the half-open range
 *     `id >= prefix AND id < prefix + "ZZZZZZZZZZZZZ"` (a 13-`Z` sentinel),
 *     excluding rows already of type Refund.
 * Prefix-freedom is SUFFICIENT for that range to behave — the range is a prefix
 * match minus continuations that sort at or above the sentinel — so the argument
 * below still holds and nothing here changes. It is simply not a model of the
 * matcher, which is why it was worth writing down.
 *
 * 🔴 TWO RESIDUALS, NEITHER PINNED BY ANY GUARD IN THIS REPO, AND AN EARLIER
 * DRAFT CLAIMED ONE OF THEM WAS. The property that matters is that a stored
 * continuation sorts BELOW the sentinel; every one observed does, because they
 * all begin `-`. But NOTHING IN THIS REPO DETERMINES THAT CHARACTER — the
 * separator and the enum rendering are both chosen inside the Buzz service — so
 * no test here can fail from any change made here, and a guard asserting it was
 * deleted for being vacuous rather than kept for looking reassuring. (It was
 * worse than vacuous: it built its input as `prefix + '-' + c` and then sliced
 * `prefix` back off, so it re-derived its own expectation and passed for a
 * totally rewritten key shape.) The second residual: the comparison runs under
 * the Buzz database's own collation, and `>=`/`<` being ASCII-ordinal is an
 * assumption about that collation this repo cannot see. Both are questions for
 * the Buzz service owner, not properties this codebase can assert.
 *
 * What IS pinned here, and was already, is prefix-freedom over the ids we
 * BUILD: see the `prefixPairs` guards and the on-the-wire payout-separation
 * case in `block-goods.service.test.ts`.
 *
 * THE ARGUMENT, so a later edit can be checked against it rather than guessed
 * at. Every id is a `:`-separated token list:
 *
 *     buy   block-good : <appBlockId> : <goodId> : <buyerUserId> [: after : <supersedesPurchaseId>] : buy
 *     sell  block-good : <appBlockId> : <goodId> : <buyerUserId> [: after : <supersedesPurchaseId>] : sell : <ownerId> : <color> : leg
 *
 * (a) NO SEGMENT CAN CONTAIN `:`. Every variable one is colon-free by its own
 *     type: `appBlockId` is `apb_<ULID>`, `supersedesPurchaseId` is
 *     `bgp_<ULID>`, `buyerUserId` and `recipientUserId` are numbers, `color` is
 *     a `BuzzAccountType` (a fixed identifier-shaped enum), and `goodId` is
 *     `BLOCK_GOOD_ID_RE`, colon-free for exactly this reason (see
 *     `block-goods.constants.ts`).
 * (b) EVERY ID ENDS IN A FIXED TERMINAL LITERAL — `buy` for the debit, `leg`
 *     for a credit — and the only literals any id can carry are `buy`, `leg`,
 *     `sell` and `after`, of which none is a string prefix of another. Given
 *     (a), that leaves exactly two ways one id could be a string prefix of a
 *     different one, and both are closed:
 *       - the shorter's WHOLE token list is a prefix of the longer's. It would
 *         have to place its terminator where the longer carries `sell` or
 *         `after`, which the literals above forbid.
 *       - they DIVERGE at the shorter's last segment. That segment is a
 *         constant, so it would have to be a strict prefix of whatever the
 *         longer holds there — again forbidden. (A divergence anywhere EARLIER
 *         is harmless on its own: the shorter's next character is `:` and the
 *         longer's is a segment character, so neither continues into the
 *         other.)
 *
 * 🔴 THE TERMINATOR IS NOT DECORATION. Without it the credit's last segment is
 * the COLOUR, and `BuzzAccountType` is not prefix-free: `creatorProgramBank` is
 * a string prefix of `creatorProgramBankGreen`. Neither reaches this rail today
 * — `payWith` is `['blue','yellow']` — but the argument is offered so a later
 * edit can be checked against it, and an argument that is only true for the
 * colours currently passed is one a later edit reads as permission.
 *
 * Both halves are load-bearing. Without (b) an id can end on a variable
 * segment, which is what put `…:5` inside `…:51` and would put
 * `…:creatorProgramBank` inside `…:creatorProgramBankGreen`. Without (a) a
 * segment could carry a `:` of its own and impersonate a token boundary, so a
 * whole id could reappear as the opening tokens of a longer one however it
 * ends.
 *
 * The guard in `block-goods.service.test.ts` asserts the property over a key
 * set that deliberately contains prefix-related buyer ids, both shapes, and
 * EVERY member of `BuzzAccountType` — not just the two this rail pays in.
 * 🔴 A DISTINCTNESS ASSERTION IS NOT THIS PROPERTY — distinct ids collide under
 * a prefix match all day, and the guard that missed the original defect was
 * exactly that, over two same-length buyer ids that could not prefix each other.
 *
 * 🔴 IT CARRIES NO RANDOMNESS AND NO CLIENT KEY, deliberately. A good is
 * single-ownership, so "this viewer buying this good from this app" names the
 * charge uniquely within one ownership generation. That makes the Buzz ledger's
 * own `externalTransactionId` uniqueness the authoritative dedupe: a retry
 * after every cache has expired still cannot move money twice. The client
 * `idempotencyKey` is a separate, faster layer (concurrency + verbatim replay)
 * and is deliberately NOT part of this string — folding it in would make two
 * different keys for one logical purchase and undo the guarantee.
 *
 * 🔴 `supersedesPurchaseId` IS WHAT MAKES A REVERSED OR REFUNDED GOOD
 * RE-BUYABLE, and leaving it out is a real defect rather than a nicety. Without
 * it the key is a function of (app, good, buyer) alone, so the SECOND purchase
 * of that good reuses the first's external id — and a reversed external id
 * stays OCCUPIED in the ledger — so the charge 409s forever. Keying each
 * generation to the row it supersedes keeps every attempt within one generation
 * idempotent (two concurrent retries read the same superseded row, so they
 * derive the same key and the claim index dedupes them) while giving each
 * generation its own key. `newestSupersededPurchaseId` is what supplies it.
 */
export function blockGoodPurchaseKey(args: BlockGoodLedgerKeyArgs): string {
  return `${blockGoodLedgerStem(args)}:buy`;
}

/**
 * The ledger id ONE leg of the owner's credit is paid under: unique per
 * generation, recipient and colour, and TERMINATED by a literal — see clause
 * (b) of the prefix-freedom argument on `blockGoodPurchaseKey` for why the
 * colour must not be the last segment.
 *
 * 🔴 IT IS A SIBLING OF THE BUY KEY, NOT AN EXTENSION OF IT, and that is the
 * point. It used to be built as `${purchaseKey}:sell:…`, which made the buy key
 * a literal string prefix of every payout leg — so `refundBlockGoodPurchase`'s
 * prefix refund of the BUYER would sweep up the owner's credits too, inflating
 * `buyerRefundedBuzz`, then failing every by-id clawback as already-reversed
 * and reporting the lot in `failures`.
 *
 * ⚠️ WHETHER THE BUZZ SERVICE WOULD ACTUALLY HAVE REVERSED THOSE LEGS IS
 * UNVERIFIED FROM HERE — it is a remote service and it may filter a prefix
 * refund by direction or type. The disjointness is correct either way and costs
 * nothing, so it is not resting on that question being answered.
 */
export function blockGoodPayoutTransactionId(
  args: BlockGoodLedgerKeyArgs & { recipientUserId: number; color: BuzzAccountType }
): string {
  return `${blockGoodLedgerStem(args)}:sell:${args.recipientUserId}:${args.color}:leg`;
}

/**
 * The purchase generation this attempt must supersede, or null on a first buy.
 *
 * 🔴 A REVERSED EXTERNAL ID STAYS OCCUPIED IN THE LEDGER. That is the whole
 * reason this exists: once a generation's key has carried a charge — settled or
 * reversed — it can never carry another, so the next attempt must be keyed
 * somewhere else or it 409s forever. `challenge-funding.ts` records the same
 * ledger behaviour from the refund side.
 *
 * It reads the PURCHASE table rather than the entitlement, because the two
 * things that burn a key do not both leave an entitlement behind:
 *   - bought then refunded — an entitlement exists, revoked;
 *   - charged then REVERSED before the grant (a partial debit, or a settle that
 *     failed) — no entitlement was ever created.
 * The second case is why reading `entitlement.purchaseId` was not enough: it
 * returned null, the retry re-derived the burned key, the ledger 409'd, and the
 * viewer was told they were out of Buzz. Permanently, for that (buyer, app,
 * good).
 *
 * "Newest reversed generation" is monotone, which is what makes the chain
 * terminate: each generation's key names the previous one's row id, and a row
 * only becomes the newest reversed generation after its own key is burned, so
 * a key is never re-derived once it has been left behind. Two concurrent
 * retries reading the same newest row derive the SAME key — deliberately: the
 * UNIQUE claim index is what settles them, exactly as within a generation.
 *
 * 🔴 READ FROM THE PRIMARY, like the post-conflict owner lookup below it. The
 * row this needs to see was very likely written MILLISECONDS ago by the attempt
 * that is now being retried, and a replica that has not caught up returns null
 * — which re-derives the burned key and lands the viewer on a ledger conflict,
 * the exact outcome this function exists to prevent. Replica lag would turn the
 * fix into an intermittent version of the bug.
 *
 * ⚠️ One extra indexed read on the purchase path, served by `bgp_buyer_idx`
 * (`user_id, created_at DESC`). It is not merged into the entitlement read
 * above because they are different tables; the alternative — keeping two
 * sources for one fact — is what produced the defect.
 */
async function newestSupersededPurchaseId(args: {
  buyerUserId: number;
  appBlockId: string;
  goodId: string;
}): Promise<string | null> {
  const previous = await dbWrite.blockGoodPurchase.findFirst({
    where: {
      userId: args.buyerUserId,
      appBlockId: args.appBlockId,
      goodId: args.goodId,
      status: PURCHASE_STATUS_REFUNDED,
    },
    // `id` is a ULID and therefore time-ordered, so it breaks a `createdAt` tie
    // in the same direction rather than arbitrarily.
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true },
  });
  return previous?.id ?? null;
}

function serializeEntitlement(row: {
  goodId: string;
  kind: string;
  payload: unknown;
  grantedAt: Date;
}): SerializedEntitlement {
  return {
    goodId: row.goodId,
    kind: row.kind,
    payload: row.payload ?? {},
    grantedAt: row.grantedAt.toISOString(),
  };
}

/**
 * Buy one good. Returns a terminal result rather than throwing, so the endpoint
 * can cache it under an idempotency key; only a genuinely unexpected throw
 * escapes.
 *
 * 🔴 CLAIM-THEN-CHARGE, AND THE ORDER IS THE WHOLE SAFETY ARGUMENT. The purchase
 * row is INSERTED as `pending` — carrying the deterministic
 * `buzz_transaction_id` under its UNIQUE index — BEFORE any money moves. That
 * makes the database, not a read-then-check, the thing that serialises
 * attempts: exactly one attempt can ever reach the charge for a given key.
 *
 * Charge-then-claim was the obvious order and it is unsound here, for the
 * reason `purchaseCosmeticShopItem` records about its own key: with a
 * DETERMINISTIC prefix, two concurrent attempts both charge under it, one wins
 * the insert, and the loser's rollback — `refundMultiAccountTransaction` by
 * PREFIX — reverses *the winner's* charge while the winner keeps the
 * entitlement. The cosmetic shop escaped that by making its prefix random; this
 * rail cannot, because the deterministic prefix is what gives it ledger-backed
 * idempotency. Claiming first buys the same property from the other side: the
 * attempt that holds the row is the ONLY writer under that prefix, so a
 * prefix-wide rollback is unambiguous.
 *
 * The steps:
 *   1. refuse what must never charge (price cap, price change, self-purchase,
 *      already owned) — no money, no writes
 *   2. INSERT the `pending` row. A UNIQUE violation means another attempt owns
 *      this purchase: refuse, with nothing to roll back
 *   3. charge the buyer
 *   4. flip the row to `paid` and grant the entitlement, in one transaction
 *   5. pay the owner and record what was paid
 *
 * 🔴 A `pending` ROW LEAVES IN ONE OF THREE WAYS, and which one depends on what
 * reached the LEDGER — not on whether the request succeeded:
 *   - DELETED (`releaseUnsettledClaim`) when the charge was refused before any
 *     transaction existed. The key never entered the ledger, so it is still
 *     free and a retry should reuse it.
 *   - TOMBSTONED as `refunded` (`voidReversedClaim`) when a debit landed and
 *     this attempt reversed it. The key is burned on the ledger's side forever,
 *     so the row has to survive to tell the next attempt to supersede it.
 *   - KEPT as `pending` when the outcome is UNKNOWN — a 5xx, a timeout, a
 *     dropped connection. Something may have been debited, and deleting the
 *     only record of it would make the loss invisible.
 *
 * ⚠️ Nothing sweeps or alerts on that third case today; see the `charge_unknown`
 * return for what is missing. The endpoint surfaces such a row as
 * `pending_reconciliation` rather than telling the viewer to try again into a
 * wall, which is honest but is not the same as anyone acting on it.
 */
export async function purchaseBlockGood(
  input: PurchaseBlockGoodInput
): Promise<PurchaseBlockGoodResult> {
  const { buyerUserId, appBlockId, goodId, expectedPriceBuzz, payWith, resolved } = input;
  const { appId, appOwnerUserId, manifestVersion, good } = resolved;
  const priceBuzz = good.priceBuzz;

  // Re-checked here and not only at manifest validation: a manifest approved
  // before the ceiling moved would otherwise keep charging the old price.
  //
  // 🔴 PER-KIND, via `maxPriceBuzzForKind` — NOT the general ceiling. This used to
  // read `BLOCK_GOOD_MAX_PRICE_BUZZ`, which made it a SECOND, DISAGREEING copy of a
  // bound the manifest parser had already narrowed: an `app_unlock` is capped at
  // 5,000 there and this guard admitted it to 50,000, i.e. 10x its real ceiling.
  // Worse, the guard's own stated purpose — "a manifest approved before the ceiling
  // moved" — is EXACTLY the app_unlock case, since every manifest approved to date
  // predates that cap, so the one kind it most needed to catch was the one it could
  // not see.
  //
  // Not reachable through the HTTP endpoint today (`resolveBlockGoodForPurchase`
  // goes through `findManifestGood`, which refuses a catalog with ANY error), and
  // that is precisely why it had to be fixed now rather than noticed later:
  // `purchaseBlockGood` takes `resolved` as a CALLER-SUPPLIED input by design, and
  // the pinned-version resolution path this file's own docs promise is a new
  // producer that will not re-parse. When that lands, this line is the only bound.
  if (priceBuzz > maxPriceBuzzForKind(good.kind)) {
    return {
      ok: false,
      status: 400,
      reason: 'price_over_cap',
      error: 'This item is not available',
      charge: 'none',
      retryable: false,
    };
  }

  // The buyer confirmed a number on a button. A catalog repriced between that
  // render and the press must refuse rather than charge a number they never
  // agreed to — the same guard the cosmetic shop makes.
  if (expectedPriceBuzz !== undefined && expectedPriceBuzz !== priceBuzz) {
    return {
      ok: false,
      status: 409,
      reason: 'price_changed',
      error: `The price changed to ${priceBuzz} Buzz. Check the new price and try again.`,
      charge: 'none',
      retryable: false,
    };
  }

  // An owner buying their own good would pay themselves 70% through the bank and
  // burn 30% — a self-discount with a platform fee, not a sale. Refused, like a
  // creator buying their own cosmetic.
  if (appOwnerUserId === buyerUserId) {
    return {
      ok: false,
      status: 400,
      reason: 'self_purchase',
      error: 'You cannot buy your own app’s items',
      charge: 'none',
      retryable: false,
    };
  }

  // Only `revokedAt` is read: this row answers "does the viewer own it RIGHT
  // NOW" and nothing else. It used to also supply the key's generation via
  // `purchaseId`, which could not see a charge that was reversed before any
  // entitlement existed — `newestSupersededPurchaseId` owns that now.
  const existingEntitlement = await dbRead.blockGoodEntitlement.findUnique({
    where: { userId_appBlockId_goodId: { userId: buyerUserId, appBlockId, goodId } },
    select: { revokedAt: true },
  });
  if (existingEntitlement && !existingEntitlement.revokedAt) {
    return {
      ok: false,
      status: 409,
      reason: 'already_owned',
      error: 'You already own this item',
      charge: 'none',
      retryable: false,
    };
  }

  // This viewer may have been charged for this good before — bought and
  // refunded, or charged by an attempt that reversed itself. Either way that
  // generation's external id is burned in the ledger, so this attempt needs its
  // own. See `newestSupersededPurchaseId`.
  const ledgerKey: BlockGoodLedgerKeyArgs = {
    appBlockId,
    goodId,
    buyerUserId,
    supersedesPurchaseId: await newestSupersededPurchaseId({ buyerUserId, appBlockId, goodId }),
  };
  const transactionId = blockGoodPurchaseKey(ledgerKey);

  // The split depends only on the price, so it is known before the charge and is
  // written with the claim — which keeps the conservation CHECK satisfied from
  // the row's first moment. `bluePaidBuzz` is the one figure that needs the
  // charge's answer, so it starts at 0 and is set in step 4.
  const { appOwnerShare, platformShare } = computeBlockGoodSplit(priceBuzz);

  // ── STEP 2. CLAIM. The UNIQUE `buzz_transaction_id` is the lock. ────────────
  const purchaseId = newBlockGoodPurchaseId();
  try {
    await dbWrite.blockGoodPurchase.create({
      data: {
        id: purchaseId,
        userId: buyerUserId,
        appId,
        appBlockId,
        blockInstanceId: input.blockInstanceId ?? null,
        goodId,
        manifestVersion,
        priceBuzz,
        bluePaidBuzz: 0,
        appOwnerUserId,
        appOwnerShareBuzz: appOwnerShare,
        platformShareBuzz: platformShare,
        buzzTransactionId: transactionId,
        // Written EXPLICITLY rather than left to the column default. Prisma
        // carries a `Json` field's default as a STRING in the DMMF, and the
        // `jsonb_typeof(payouts) = 'array'` CHECK rejects a JSON string — so
        // relying on the default would make every insert depend on how the
        // client chooses to apply it.
        payouts: [],
        status: PURCHASE_STATUS_PENDING,
      },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) {
      void logToAxiom(
        {
          name: BLOCK_GOODS_LOG_NAME,
          type: 'error',
          message: 'purchase claim write failed',
          appBlockId,
          goodId,
          buyerUserId,
          error: messageOf(error),
        },
        'civitai-prod'
      ).catch(() => undefined);
      // The claim never landed, so NOTHING was charged and the key is still
      // free — an identical retry is the right thing for the caller to allow.
      return {
        ok: false,
        status: 500,
        reason: 'charge_failed',
        error: 'Could not complete this purchase',
        charge: 'none',
        retryable: true,
      };
    }

    // Another attempt owns this purchase. NOTHING is rolled back here — we never
    // charged, and the money under this key (if any) belongs to that attempt.
    // Which refusal the viewer sees depends on what state that attempt left:
    // a settled purchase is a duplicate; an unsettled one needs reconciliation,
    // and telling the viewer to retry would send them into a permanent wall.
    const owner = await dbWrite.blockGoodPurchase.findUnique({
      where: { buzzTransactionId: transactionId },
      select: { status: true },
    });
    if (owner?.status === PURCHASE_STATUS_PENDING) {
      return {
        ok: false,
        status: 409,
        reason: 'pending_reconciliation',
        error: 'A purchase of this item is still being settled. Support can help.',
        charge: 'none',
        retryable: false,
      };
    }
    return {
      ok: false,
      status: 409,
      reason: 'duplicate',
      error: 'This purchase has already been completed',
      charge: 'none',
      retryable: false,
    };
  }

  // ── STEP 3. CHARGE. We hold the key exclusively from here. ──────────────────
  let transaction: Awaited<ReturnType<typeof createMultiAccountBuzzTransaction>>;
  try {
    transaction = await createMultiAccountBuzzTransaction({
      fromAccountId: buyerUserId,
      fromAccountTypes: payWith,
      toAccountId: 0, // the bank
      amount: priceBuzz,
      type: TransactionType.Purchase,
      description: `App item purchase - ${good.title}`.slice(0, 100),
      externalTransactionIdPrefix: transactionId,
    });
  } catch (error) {
    // 🔴 A THROW HERE IS NOT AUTOMATICALLY "INSUFFICIENT FUNDS", and treating it
    // as one is a money bug. The Buzz client throws on ANY non-2xx and on a
    // network failure, and `mapError` collapses 401, 403, 408, 429 and every 5xx
    // into one INTERNAL_SERVER_ERROR — so the status is the only thing that
    // separates "the service refused, nothing moved" from "the gateway gave up
    // and the write may have landed". `getBuzzApiStatus` is the discriminator the
    // sibling App Blocks money path already uses for exactly this.
    const buzzStatus = getBuzzApiStatus(error);
    const knownPreMoney = buzzStatus === 400 || buzzStatus === 409 || buzzStatus === 404;

    // 🔴 KNOWING NO MONEY MOVED IS ONE QUESTION; WHAT TO TELL THE VIEWER IS
    // ANOTHER. All three statuses above share the first answer and had been
    // given the same second one, which made a LEDGER CONFLICT read as "you do
    // not have enough Buzz" — to a viewer with plenty, about a key they can
    // never get past by topping up.
    //   400 the ledger evaluated the debit and refused it: the funds case.
    //   409 the external id is already occupied, reversed ones included.
    //   404 the ledger could not resolve the request at all. Not a funds
    //       verdict, so it must not borrow one.
    //
    // 🔴 WHY THE `else` ARM MAY CLAIM THE FUNDS VERDICT AT ALL — the ternary
    // looks like it hands every unlisted status "you do not have enough Buzz",
    // and it does not. `refusal` has exactly ONE consumer, the return inside
    // `if (knownPreMoney)` below, and `knownPreMoney` is `400 || 409 || 404` —
    // so the only status that can reach the `else` is 400. 402, 422, every 5xx
    // and an unreadable status never get here: they fall to the
    // `charge_unknown` path, which is the fail-safe answer for an attempt whose
    // ledger effect is not established.
    //
    // ⚠ THAT SAFETY IS A COUPLING, NOT A PROPERTY OF THIS TERNARY: it holds
    // only while `knownPreMoney` and these arms list the same statuses. Widen
    // `knownPreMoney` by one — a 402, say — and that status silently acquires
    // the funds answer, which on a status whose ledger effect is unknown is the
    // one instruction that could double-charge. The test
    // "only a 400 can reach the insufficient_funds arm" pins the pair so the
    // widening is a red test rather than a wrong message. (An audit round read
    // this ternary in isolation and reported the wide hole as already live; it
    // is not, and the reachability above is why.)
    //
    // 🔴 THIS 409 ARM IS UNREACHABLE — BUT `ledger_conflict` AS A REASON IS
    // LIVE, AND CONFLATING THE TWO IS A MISREADING WORTH HEADING OFF. The
    // occupied-id case is the one the service DOES produce: 200 with the leg
    // marked `duplicate: true`, handled further down this function, which
    // returns `ledger_conflict` with `charge: 'unknown'`. So deleting this arm
    // would delete a branch, not a reason, and the occupied-id outcome would be
    // unchanged. The arm is RETAINED DELIBERATELY.
    // `POST /multi-transactions` cannot return 409: measured against
    // `civitai-buzz` `src/Civitai.Buzz.Api/Program.cs` at `origin/master`
    // 4148403, that handler's only exits are 4x BadRequest, one Ok and one
    // Problem — with a positive control, because a negative grep is worthless
    // otherwise: `Results.Conflict` DOES occur three times in that same file
    // (the single-transaction and refund endpoints), so the pattern can match
    // and its absence in this handler is real. On an occupied external id the
    // handler instead returns 200 with the leg marked `duplicate: true`, which
    // is why reading that flag is load-bearing rather than defensive.
    //
    // Kept rather than deleted because the Buzz service is a SEPARATELY
    // DEPLOYED binary this repo does not gate. If it ever starts answering 409
    // here, deleting this arm sends the viewer down the `insufficient_funds`
    // path — telling someone with plenty of Buzz that they are broke, about a
    // key topping up can never get them past, which is the exact defect the
    // paragraph above exists to prevent. An unreachable arm costs a branch; a
    // missing one costs the wrong answer at the worst moment.
    //
    // ⚠ Its SIBLING IS LIVE, and the distinction matters: the REFUND endpoint
    // (`POST /multi-transactions/refund`) does return 409 —
    // "One or more refund transactions already exist" — so 409 handling on the
    // refund path is a real case, not a dead one. Do not generalise this note
    // to "the Buzz service never 409s".
    const refusal: Pick<PurchaseBlockGoodRefusal, 'status' | 'reason' | 'error'> =
      buzzStatus === 409
        ? {
            status: 409,
            reason: 'ledger_conflict',
            error: 'This item could not be purchased right now. Support can help.',
          }
        : buzzStatus === 404
        ? { status: 400, reason: 'charge_failed', error: 'Could not complete this purchase' }
        : {
            status: 400,
            reason: 'insufficient_funds',
            error: 'You do not have enough Buzz to buy this item',
          };

    void logToAxiom(
      {
        name: BLOCK_GOODS_LOG_NAME,
        type: knownPreMoney ? 'warning' : 'error',
        message: knownPreMoney ? 'purchase charge refused' : 'purchase charge outcome UNKNOWN',
        appBlockId,
        goodId,
        buyerUserId,
        purchaseId,
        transactionId,
        buzzStatus: buzzStatus ?? null,
        // Logged, never returned: a driver-authored string on the wire is the
        // civitai#3845 disclosure class.
        detail: messageOf(error),
      },
      'civitai-prod'
    ).catch(() => undefined);

    if (knownPreMoney) {
      // The claim is DELETED rather than tombstoned, because THIS attempt put
      // nothing in the ledger — a tombstone asserts a reversal that did not
      // happen, and a surviving `pending` row would make every later attempt
      // report `pending_reconciliation` forever.
      //
      // ⚠️ That is not the same as saying the KEY is reusable, and `retryable`
      // splits on exactly that rather than on `knownPreMoney`. On 400 and 404
      // the key is free and an identical retry CAN reach a different verdict —
      // a top-up, or a ledger that resolves the request this time — so caching
      // the refusal for the idempotency TTL would make the key the thing that
      // blocks the retry it exists to enable. On 409 the ledger already holds
      // this id: every retry derives the same key and 409s again, so it is the
      // one verdict here that cannot change, and it points at support. Reaching
      // 409 means the ledger has a key we hold no row for, since a row would
      // have failed the claim insert first; that is an inconsistency for a
      // human, not something the viewer can act on.
      await releaseUnsettledClaim(purchaseId);
      return { ok: false, ...refusal, charge: 'none', retryable: buzzStatus !== 409 };
    }

    // 🔴 UNKNOWN OUTCOME. The `pending` row SURVIVES: it is the only record that
    // a debit may exist, and the caller keeps the daily-cap reservation because
    // we cannot say the Buzz came back.
    //
    // ⚠️ NOTHING CONSUMES THAT RECORD. There is no reconciliation job and no
    // alert on surviving `pending` rows, so today the row is evidence for a
    // human who has not been told to look. Closing that needs a sweeper (or at
    // minimum an alert on the row age), and neither is in this change — stated
    // here rather than left implied by the word "reconciliation".
    return chargeUnknownRefusal();
  }

  // 🔴 THE DUPLICATE GUARD BELOW CANNOT REPORT ITS OWN LIVENESS. It tests
  // `=== true`, so a leg carrying NO `duplicate` field takes the same path as
  // one carrying `false`: if the service omits the field the branch is dead,
  // the hazard it was written for is still live, and the code reads as
  // handling it. This counts the legs whose `duplicate` is not a boolean at
  // all and puts the number on both charge-failure logs below.
  //
  // ⚠️ WHAT IT DOES NOT ANSWER, stated because the field's name suggests it
  // does: only the two logs below carry it, and a clean charge writes neither,
  // so this samples failing responses only. A NON-ZERO is proof the field is
  // absent on the wire; a permanent zero is not proof it arrives, because it
  // is also what "no charge ever reached a log" looks like. Settling it needs
  // a counter on every response, which is not in this change.
  const legsWithoutDuplicateFlag = transaction.transactionIds.filter(
    (leg) => typeof leg.duplicate !== 'boolean'
  ).length;

  // 🔴 A 409 THROW IS ONLY ONE OF THE TWO WAYS AN OCCUPIED PREFIX CAN COME
  // BACK, AND WHICH ONE THIS SERVICE DOES IS UNVERIFIED FROM HERE. The
  // multi-account response marks each leg `duplicate` — the very field
  // `payBlockGoodOwner` records the SINGLE-transaction response as lacking — so
  // an occupied prefix may arrive as a 200 whose legs reference transactions an
  // earlier request created. Nothing new moved, but `transactionCount` and
  // `totalAmount` then look exactly like a clean charge, so without this branch
  // the entitlement is granted and the owner paid for Buzz that did not move.
  // Both shapes are handled rather than one being guessed at; the question of
  // which the remote does is open with the Buzz service owner.
  //
  // The outcome is reported as UNKNOWN, not `none`: a mixed response — some
  // legs new, some duplicate — is money this attempt did move, and the safe
  // direction is to keep the viewer's cap reservation and the `pending` row
  // rather than assert a clean no-op. Nothing is reversed, because what a
  // prefix-wide reversal would take back includes the earlier request's legs.
  if (transaction.transactionIds.some((leg) => leg.duplicate === true)) {
    void logToAxiom(
      {
        name: BLOCK_GOODS_LOG_NAME,
        type: 'error',
        message: 'purchase charge reported DUPLICATE legs — the ledger key was already occupied',
        appBlockId,
        goodId,
        buyerUserId,
        purchaseId,
        transactionId,
        duplicateLegs: transaction.transactionIds.filter((leg) => leg.duplicate === true).length,
        legsWithoutDuplicateFlag,
        totalLegs: transaction.transactionIds.length,
      },
      'civitai-prod'
    ).catch(() => undefined);
    return {
      ok: false,
      status: 409,
      reason: 'ledger_conflict',
      error: 'This item could not be purchased right now. Support can help.',
      charge: 'unknown',
      // Same argument as the 409 throw: the id is occupied forever, so no
      // retry can reach a different verdict.
      retryable: false,
    };
  }

  // A partially-fulfilled debit must not be recorded as a full-price sale, or
  // the owner is paid 70% of Buzz the viewer never spent. `transactionCount`
  // alone does not say that — the total does.
  if (!transaction.transactionCount || transaction.totalAmount !== priceBuzz) {
    void logToAxiom(
      {
        name: BLOCK_GOODS_LOG_NAME,
        type: 'error',
        message: 'purchase charge did not fully land',
        appBlockId,
        goodId,
        buyerUserId,
        purchaseId,
        priceBuzz,
        chargedTotal: transaction.totalAmount,
        transactionCount: transaction.transactionCount,
        // Carried here too, and this is the copy that samples the NON-duplicate
        // population: reaching this branch means no leg reported `true`.
        legsWithoutDuplicateFlag,
      },
      'civitai-prod'
    ).catch(() => undefined);
    // Safe to reverse the whole prefix: this attempt is the exclusive holder of
    // the key, so no other attempt's money can be under it. A reversal whose
    // own outcome is not established leaves the row `pending` and reports
    // UNKNOWN — see `rollbackCharge`.
    if (!(await rollbackCharge(transactionId, good.title))) return chargeUnknownRefusal();
    await voidReversedClaim(purchaseId, 'charge did not fully land — reversed');
    return {
      ok: false,
      status: 400,
      reason: 'charge_failed',
      error: 'Could not complete this purchase',
      charge: 'reversed',
      // Reached only on a CONFIRMED reversal, so the buyer's Buzz is back and
      // the key is retired: the next attempt derives a fresh generation and can
      // land in full.
      retryable: true,
    };
  }

  const bluePaidBuzz = transaction.transactionIds
    .filter((t) => t.accountType === 'blue')
    .reduce((sum, t) => sum + t.amount, 0);

  // ── STEP 4. SETTLE: flip the claim to `paid` and grant the entitlement. ─────
  let entitlement: SerializedEntitlement;
  try {
    entitlement = await dbWrite.$transaction(async (tx) => {
      await tx.blockGoodPurchase.update({
        where: { id: purchaseId },
        data: { status: PURCHASE_STATUS_PAID, bluePaidBuzz },
      });

      // A revoked entitlement is re-granted rather than duplicated: the unique
      // key is (viewer, app, good), so re-buying after a refund updates the row
      // the refund revoked and the pair stays one-to-one with the new purchase.
      const row = await tx.blockGoodEntitlement.upsert({
        where: { userId_appBlockId_goodId: { userId: buyerUserId, appBlockId, goodId } },
        create: {
          id: newBlockGoodEntitlementId(),
          userId: buyerUserId,
          appBlockId,
          goodId,
          kind: good.kind,
          payload: good.payload as Prisma.InputJsonValue,
          purchaseId,
        },
        update: {
          kind: good.kind,
          payload: good.payload as Prisma.InputJsonValue,
          purchaseId,
          grantedAt: new Date(),
          revokedAt: null,
          revokeReason: null,
        },
        select: { goodId: true, kind: true, payload: true, grantedAt: true },
      });

      return serializeEntitlement(row);
    });
  } catch (error) {
    // Logged BEFORE the reversal is attempted, so the settle failure is
    // recorded whichever way that attempt goes.
    void logToAxiom(
      {
        name: BLOCK_GOODS_LOG_NAME,
        type: 'error',
        message: 'purchase settle failed after a successful charge',
        appBlockId,
        goodId,
        buyerUserId,
        purchaseId,
        error: messageOf(error),
      },
      'civitai-prod'
    ).catch(() => undefined);
    // The charge landed and the grant did not. Reverse the charge — unambiguous,
    // because this attempt holds the key exclusively — and RETIRE the key, so
    // the retry is keyed to a new generation instead of colliding with the
    // reversal. A reversal whose own outcome is not established does neither:
    // see `rollbackCharge`.
    if (!(await rollbackCharge(transactionId, good.title))) return chargeUnknownRefusal();
    await voidReversedClaim(purchaseId, 'entitlement grant failed — charge reversed');
    return {
      ok: false,
      status: 500,
      reason: 'charge_failed',
      error: 'Could not complete this purchase',
      // Reached only on a CONFIRMED reversal, so the buyer's Buzz is back — a
      // KNOWN outcome behind a 500, which is exactly the case reading the
      // status class gets wrong.
      charge: 'reversed',
      retryable: true,
    };
  }

  // ── STEP 5. PAY THE OWNER. ─────────────────────────────────────────────────
  await payBlockGoodOwner({
    purchaseId,
    ledgerKey,
    appOwnerUserId,
    appOwnerShare,
    bluePaidBuzz,
    priceBuzz,
    domainColor: domainColorOf(payWith),
    title: good.title,
    buyerUserId,
  });

  return { ok: true, status: 200, purchaseId, goodId, priceBuzz, entitlement };
}

/**
 * Reverse this attempt's charge, and REPORT whether it worked. Safe as a
 * PREFIX-wide reversal only because the caller holds the `buzz_transaction_id`
 * claim exclusively — see the ordering argument on `purchaseBlockGood`.
 *
 * 🔴 IT RETURNS A VERDICT RATHER THAN THROWING, AND THE CALLER MUST BRANCH ON
 * IT. Throwing is wrong — the alternative is failing a response after the money
 * has already moved — but so is resolving identically either way, which is what
 * it used to do. A failed reversal then read as a successful one, and each of
 * the three things the caller does next is wrong in that state: the tombstone
 * asserts a refund that did not happen (so `refundBlockGoodPurchase` answers
 * `already_refunded` and the remediation path is closed by the record of the
 * failure), `charge: 'reversed'` hands the viewer's daily-cap reservation back
 * for Buzz that never returned, and the retired key lets the next attempt open
 * a FRESH generation and debit the buyer a second time. That is the same defect
 * `refundBlockGoodPurchase` aborts on when the buyer refund fails.
 */
async function rollbackCharge(transactionId: string, title: string): Promise<boolean> {
  try {
    await refundMultiAccountTransaction({
      externalTransactionIdPrefix: transactionId,
      description: `Failed app item purchase - ${title}`.slice(0, 100),
    });
    return true;
  } catch (error) {
    void logToAxiom(
      {
        name: BLOCK_GOODS_LOG_NAME,
        type: 'error',
        message: 'purchase rollback refund failed',
        transactionId,
        error: messageOf(error),
      },
      'civitai-prod'
    ).catch(() => undefined);
    return false;
  }
}

/**
 * The refusal for an attempt whose effect on the LEDGER is not established.
 *
 * Every caller of this is a place where a debit may exist and nothing has
 * confirmed it is gone, so all three consequences follow from that one fact:
 * the `pending` row survives as the only record of the debit, the caller keeps
 * the viewer's daily-cap reservation (`charge: 'unknown'`), and no tombstone is
 * written — a tombstone would tell the next attempt to open a fresh generation
 * on top of a debit nobody has confirmed is gone. The retry it does admit is
 * refused at the claim insert as `pending_reconciliation`, which is a state a
 * human can act on.
 */
function chargeUnknownRefusal(): PurchaseBlockGoodRefusal {
  return {
    ok: false,
    status: 503,
    reason: 'charge_unknown',
    error: 'Could not confirm this purchase. Please check your balance before retrying.',
    charge: 'unknown',
    // No verdict was ever reached, so a retry is not a replay of anything.
    retryable: true,
  };
}

/**
 * Delete an UNSETTLED claim row, freeing its deterministic key for a genuine
 * retry.
 *
 * 🔴 ONLY FOR A KEY THAT NEVER REACHED THE LEDGER. Deleting the row frees the
 * key on OUR side; it cannot free it on the ledger's, where even a reversed
 * external id stays occupied forever. So this is correct exactly where the
 * charge was refused BEFORE any transaction was created (`knownPreMoney`), and
 * wrong anywhere a debit landed — there the row must be tombstoned by
 * `voidReversedClaim` instead, or the retry re-derives a burned key.
 *
 * 🔴 Guarded on `status = 'pending'`, so it can never delete a settled purchase
 * — that row is financial history. Deliberately NOT called on an UNKNOWN charge
 * outcome; see `purchaseBlockGood`.
 */
async function releaseUnsettledClaim(purchaseId: string): Promise<void> {
  await dbWrite.blockGoodPurchase
    .deleteMany({ where: { id: purchaseId, status: PURCHASE_STATUS_PENDING } })
    .catch((error) => {
      void logToAxiom(
        {
          name: BLOCK_GOODS_LOG_NAME,
          type: 'error',
          message: 'could not release an unsettled purchase claim',
          purchaseId,
          error: messageOf(error),
        },
        'civitai-prod'
      ).catch(() => undefined);
    });
}

/**
 * Retire a claim whose charge LANDED AND WAS REVERSED: the row is kept, marked
 * `refunded`, and becomes the generation marker the next attempt supersedes.
 *
 * 🔴 KEEPING IT IS THE FIX, NOT A DETAIL. Deleting it looked right — no
 * entitlement was granted, so there is nothing to own — and it bricked the
 * (buyer, app, good) triple permanently: the retry found no superseded row, re-
 * derived the same key, the ledger 409'd on the reversed transaction, and the
 * viewer was told they were out of Buzz. The row is what remembers that the key
 * is spent.
 *
 * `refunded` rather than a fourth status value: the row's own facts are that a
 * debit of `price_buzz` was taken and returned, which is what `refunded` means
 * here and what the `status` CHECK already admits. The difference from an
 * ordinary refund — that the viewer never owned the good — is readable from the
 * absence of an entitlement pointing at this row, and from `payouts` being `[]`
 * (no owner credit was ever made, so there was none to claw back).
 *
 * Guarded on `status = 'pending'` for the same reason as the delete above, and
 * never throws: the charge is already reversed, and failing the response after
 * the money is back helps nobody. A row left `pending` by a failure here is the
 * unknown-outcome surface, which is the safe direction.
 */
async function voidReversedClaim(purchaseId: string, reason: string): Promise<void> {
  await dbWrite.blockGoodPurchase
    .updateMany({
      where: { id: purchaseId, status: PURCHASE_STATUS_PENDING },
      data: {
        status: PURCHASE_STATUS_REFUNDED,
        refundedAt: new Date(),
        // Both fields or neither — the refund-fields CHECK rejects a half-set
        // pair, and a row that cannot be written is worse than one that can.
        refundReason: reason,
      },
    })
    .catch((error) => {
      void logToAxiom(
        {
          name: BLOCK_GOODS_LOG_NAME,
          type: 'error',
          message: 'could not void a reversed purchase claim',
          purchaseId,
          error: messageOf(error),
        },
        'civitai-prod'
      ).catch(() => undefined);
    });
}

/**
 * ⚠️ PARTIALLY CLOSED — read which half. This block used to say goods revenue
 * was invisible to EVERY app-earnings surface. That is no longer true of the
 * owner's own revenue pages and is still true of the collaborator ones.
 *
 * - BRIDGED: `blocks.getMyRevenue` — both `/apps/revenue` and
 *   `/apps/[appBlockId]/revenue` — now also calls `getGoodsSalesForOwner`
 *   (`src/server/services/blocks/buzz-attribution.service.ts`), a READ-side
 *   aggregate over `block_good_purchase` scoped by `app_owner_user_id`. This
 *   rail still writes NO attribution row and nothing here changed: the bridge is
 *   a second query the reporting layer runs, deliberately not a write, so it
 *   commits to nothing about whether a sale "is an attribution".
 * - STILL INVISIBLE: `getAppEarnings` and `blocks.getMyApps`, which read
 *   `app-collaborator-earnings.service.ts`. Those are the COLLABORATOR surfaces.
 *
 * ⚠️ CORRECTION, because the first version of this note gave a reason the code
 * contradicts. It said bridging them "needs an answer to how one sale divides
 * among several seats — a split nobody has specified". **There is no split to
 * specify.** `getAppEarnings` already shows the app's UNDIVIDED owner-share total
 * to every seat — its own test asserts the accepted editor reads the same
 * `shareCents` as the owner, and `AppEarningsPanel` says so on screen ("shared
 * with everyone seated on it"). The split argument is real but belongs to a
 * different axis: it is about the PAYEE on the write side, which is why
 * `app-access.call-site-ledger.test.ts` records it for `resolveBlockGoodForPurchase`
 * below. Carrying it over to a READ, where nobody receives anything, was wrong.
 *
 * The honest statement of why they are unbridged: it is UNFINISHED SCOPE, not a
 * blocked decision. Extending the collaborator panel means a second renderer, a
 * Buzz-vs-cents decision for `getMyAppsEarnings`'s `lifetimeShareCents` (which is
 * a cents field a Buzz total cannot simply be added to), and a deliberate choice
 * about whether a seated editor should see a second rail's figures. Tracked as
 * follow-on work; it is not waiting on a product answer.
 *
 * `recordSpendAttribution` is workflow-anchored, so it was never a drop-in and
 * still is not.
 *
 * Credit the app owner and RECORD what was actually paid, per colour, with each
 * leg's ledger transaction id. The record is what makes a refund a true
 * reversal of this payout rather than a fresh charge computed from today's
 * split.
 *
 * Never throws: the viewer has their entitlement, and a failed credit is an
 * obligation to re-run, not a reason to fail a completed purchase.
 *
 * 🔴 THE RE-RUN SET IS `status = 'paid' AND sum(payouts[].amount) <
 * app_owner_share_buzz`. BOTH halves are load-bearing and neither is
 * decoration — see `owesOwnerPayout`, which is the single spelling of it.
 *
 * The shortfall half is why it is not `payouts = []`: the empty case is only
 * the total failure; a payout whose blue leg landed and whose domain leg did
 * not persists `[{blue}]`, which is non-empty and still owes the owner the
 * remainder. Selecting on emptiness misses exactly the rows where money is
 * owed, and it is the partial ones that are invisible — an owner underpaid by a
 * leg has nothing on the row saying so. It needs no new column: the row already
 * carries the full obligation as `app_owner_share_buzz`, and the legs are built
 * to sum to exactly that, so the two agreeing IS "complete" and a shortfall IS
 * the amount still owed.
 *
 * The status half is why the shortfall test cannot stand alone. The owner's
 * share is at least 1 for every priced good (`BLOCK_GOOD_MIN_PRICE_BUZZ` is 2),
 * so `0 < share` holds unconditionally and a bare shortfall test selects
 * every row that never paid anything — including rows that must NEVER be paid:
 * a `pending` row, whose debit is not confirmed; a `refunded` tombstone from
 * `voidReversedClaim`, whose debit was REVERSED; and a purchase refunded after
 * a partial payout, which `refundBlockGoodPurchase` leaves with its `payouts`
 * array intact, so its shortfall reads true forever. Paying any of those credits
 * the owner for Buzz the buyer does not owe.
 *
 * (No selector reads this yet; there is no re-runner. The predicate is written
 * as code rather than prose so the one that is written cannot re-derive it
 * wrong — this sentence has been widened by accident once already.)
 */
async function payBlockGoodOwner(args: {
  purchaseId: string;
  /** The generation the buyer was charged under; the credit legs are siblings of it. */
  ledgerKey: BlockGoodLedgerKeyArgs;
  appOwnerUserId: number;
  appOwnerShare: number;
  bluePaidBuzz: number;
  priceBuzz: number;
  domainColor: BuzzAccountType;
  title: string;
  buyerUserId: number;
}): Promise<void> {
  const blueAmount = blueLegOfPayout({
    recipientAmount: args.appOwnerShare,
    bluePaid: args.bluePaidBuzz,
    priceBuzz: args.priceBuzz,
  });
  const legs: { amount: number; color: BuzzAccountType }[] = (
    [
      { amount: blueAmount, color: 'blue' as BuzzAccountType },
      { amount: args.appOwnerShare - blueAmount, color: args.domainColor },
    ] satisfies { amount: number; color: BuzzAccountType }[]
  ).filter((leg) => leg.amount > 0);

  /**
   * What has landed so far, ACROSS attempts. Hoisted out of the retried
   * closure on purpose — see below.
   */
  const paid: BlockGoodPayout[] = [];
  const landed = new Set<BuzzAccountType>();

  /**
   * Write what has landed so far. Deliberately allowed to THROW: inside the
   * retry that is what re-runs it, and the driver's own error is what the log
   * below needs to be diagnosable. Collapsing it to a boolean and rethrowing a
   * generic message — which an earlier draft of this did — loses the only
   * description of why a money record could not be written.
   */
  const recordPayouts = () =>
    dbWrite.blockGoodPurchase.update({
      where: { id: args.purchaseId },
      data: { payouts: paid },
    });

  try {
    // Retried like the cosmetic shop's distribute-funds block: one transient
    // Buzz blip would otherwise leave `payouts: []` and an unpaid obligation
    // with no re-runner.
    //
    // 🔴 EACH LEG IS SKIPPED ONCE IT HAS LANDED, AND THAT IS WHAT MAKES THE
    // RETRY CONVERGE. The comment here used to say a re-run was "deduped by the
    // ledger rather than double-paying", which is not a property this call has.
    // `createBuzzTransaction`'s response type — `CreateTransactionResponse` in
    // `packages/civitai-buzz/src/responses.ts` — carries only `transactionId`
    // and `remainingBalance`. It has NO conflict field, unlike its siblings:
    // the multi-account response marks each leg `duplicate`, and the bulk one
    // returns a `conflicts` array. A duplicate on THIS endpoint therefore
    // cannot be reported in band, so it arrives as a non-2xx, and the client
    // throws on any non-2xx. `challenge-funding.ts`'s header records the same
    // ledger behaviour from the other side: a re-charge of an already-paid leg
    // "conflicts".
    //
    // So on a mixed-colour payout whose blue leg landed and whose yellow leg
    // blipped, every retry re-sent blue, collided with itself, and failed the
    // whole closure — four attempts, no progress, `payouts` left `[]`, and a
    // later refund therefore clawed back NOTHING while refunding the buyer in
    // full. Dedupe is ours to do, here.
    await withRetries(async () => {
      for (const leg of legs) {
        if (landed.has(leg.color)) continue;
        try {
          const { transactionId } = await createBuzzTransaction({
            fromAccountId: 0,
            toAccountId: args.appOwnerUserId,
            toAccountType: leg.color,
            amount: leg.amount,
            type: TransactionType.Sell,
            description: `A user bought your app item - ${args.title}`.slice(0, 100),
            // Unique per generation, recipient AND colour, and a SIBLING of the
            // buyer's key rather than an extension of it — see
            // `blockGoodPayoutTransactionId`.
            externalTransactionId: blockGoodPayoutTransactionId({
              ...args.ledgerKey,
              recipientUserId: args.appOwnerUserId,
              color: leg.color,
            }),
            details: { purchasedBy: args.buyerUserId, originalAmount: args.priceBuzz },
          });
          landed.add(leg.color);
          paid.push({
            userId: args.appOwnerUserId,
            amount: leg.amount,
            color: leg.color,
            ...(transactionId ? { transactionId } : {}),
          });
        } catch (error) {
          // 409 = this exact external id is already in the ledger. Only this
          // request ever writes it, so it is a leg an earlier attempt landed
          // and whose response we lost. Record it as paid WITHOUT a transaction
          // id: a refund then reports it in `failures` for a human instead of
          // silently clawing back nothing, which is the same honesty the
          // `payouts` contract already promises for an id-less leg.
          if (getBuzzApiStatus(error) !== 409) throw error;
          landed.add(leg.color);
          paid.push({ userId: args.appOwnerUserId, amount: leg.amount, color: leg.color });
        }
      }

      await recordPayouts();
    }, 3);
  } catch (error) {
    void logToAxiom(
      {
        name: BLOCK_GOODS_LOG_NAME,
        type: 'error',
        message: 'owner payout failed',
        purchaseId: args.purchaseId,
        appOwnerUserId: args.appOwnerUserId,
        paidLegs: paid.length,
        error: messageOf(error),
      },
      'civitai-prod'
    ).catch(() => undefined);

    // Persist whatever DID land even though the payout as a whole failed: a
    // recorded leg is what a refund reverses, and an unrecorded one is Buzz the
    // owner keeps after the buyer is made whole. Skipped when nothing landed,
    // so `payouts: []` keeps meaning "nothing was paid" rather than becoming a
    // second spelling of it. What this write produces is a PARTIAL payout, and
    // it is still in the re-run set — the row is `paid` and
    // `sum(payouts[].amount)` falls short of `app_owner_share_buzz`. Both
    // conditions, not the shortfall alone: see `owesOwnerPayout` and the header.
    //
    // Best effort by construction — if the write is what failed above it will
    // very likely fail again — so its own failure is logged rather than thrown:
    // the purchase is complete and the viewer already has their entitlement.
    if (paid.length > 0)
      await recordPayouts().catch((writeError) => {
        void logToAxiom(
          {
            name: BLOCK_GOODS_LOG_NAME,
            type: 'error',
            message: 'could not record a partial owner payout',
            purchaseId: args.purchaseId,
            paidLegs: paid.length,
            error: messageOf(writeError),
          },
          'civitai-prod'
        ).catch(() => undefined);
      });
  }
}

/** The non-blue colour the buyer paid from; what the owner's remainder is paid in. */
function domainColorOf(payWith: BuzzAccountType[]): BuzzAccountType {
  return payWith.find((color) => color !== 'blue') ?? 'yellow';
}

/**
 * Above any reachable total — a manifest may declare at most
 * BLOCK_GOOD_MAX_PER_MANIFEST goods — with headroom for the ids an app has
 * retired across versions, since an entitlement outlives the version that sold
 * it. A CONSTANT rather than a parameter: the sole caller never passed one, and
 * a configurable knob with no configurer is a decision nobody made.
 */
const ENTITLEMENTS_READ_LIMIT = 200;

export type ListBlockGoodEntitlementsArgs = {
  userId: number;
  /** From `claims.appBlockId` — the ONLY app an entitlement read can see. */
  appBlockId: string;
};

/**
 * What this viewer owns FROM THIS APP. Scoped by `appBlockId` in the query
 * itself, so an app can never read an entitlement it did not sell — the reply
 * is its own sales ledger filtered to one viewer.
 *
 * Revoked entitlements are excluded: "what do I own" must not include what was
 * refunded. The rows are kept for audit, not for this read.
 */
export async function listBlockGoodEntitlements(
  args: ListBlockGoodEntitlementsArgs
): Promise<SerializedEntitlement[]> {
  const rows = await dbRead.blockGoodEntitlement.findMany({
    where: { userId: args.userId, appBlockId: args.appBlockId, revokedAt: null },
    select: { goodId: true, kind: true, payload: true, grantedAt: true },
    orderBy: { grantedAt: 'desc' },
    take: ENTITLEMENTS_READ_LIMIT,
  });
  return rows.map(serializeEntitlement);
}

export type RefundBlockGoodResult =
  | { refunded: true; buyerRefundedBuzz: number; clawedBackBuzz: number; failures: string[] }
  | { refunded: false; reason: 'not_found' | 'already_refunded' | 'buyer_refund_failed' };

/**
 * Reverse a purchase: refund the buyer and claw the owner's earnings back.
 *
 * 🔴 THE CLAWBACK READS `payouts`, NEVER A RE-DERIVED SPLIT. Refunding each
 * recorded payout transaction by id is the exact reversal of what the owner
 * received. Re-deriving `computeBlockGoodSplit(price)` would claw back today's
 * number, which can differ from what was paid — a colour proration that floored
 * differently, or a share constant that has since moved — and the error lands
 * on a real person's balance.
 *
 * A payout recorded WITHOUT a transaction id (the credit leg never reported
 * one) cannot be reversed this way and is reported in `failures` for a human,
 * rather than being replaced by a guess.
 *
 * 🔴 THE TWO HALVES MUST NOT OVERLAP. The buyer is repaid by a PREFIX refund
 * over `buzz_transaction_id` and the owner is clawed back BY TRANSACTION ID, so
 * the owner's credit ids must fall outside that prefix or the first half would
 * sweep them up and the second would then fail on every leg as already-reversed
 * — reporting a clean reversal as a wall of `failures`, with `buyerRefundedBuzz`
 * inflated by the owner's share. `blockGoodPayoutTransactionId` is what keeps
 * them disjoint; it is not a naming convention.
 *
 * A purchase whose charge was reversed before any grant is already `refunded`
 * (see `voidReversedClaim`), so it returns `already_refunded` here rather than
 * being reversed a second time.
 */
export async function refundBlockGoodPurchase(args: {
  purchaseId: string;
  reason: string;
}): Promise<RefundBlockGoodResult> {
  const purchase = await dbWrite.blockGoodPurchase.findUnique({
    where: { id: args.purchaseId },
    select: {
      id: true,
      status: true,
      userId: true,
      appBlockId: true,
      goodId: true,
      priceBuzz: true,
      buzzTransactionId: true,
      payouts: true,
    },
  });
  if (!purchase) return { refunded: false, reason: 'not_found' };
  if (purchase.status === PURCHASE_STATUS_REFUNDED)
    return { refunded: false, reason: 'already_refunded' };

  const failures: string[] = [];

  // 🔴 THE BUYER IS REFUNDED FIRST, AND A FAILURE HERE ABORTS THE WHOLE REVERSAL.
  // Marking the row `refunded` after a failed buyer refund is the worst outcome
  // this function can produce: the viewer loses the item AND keeps no money, the
  // row asserts they were repaid, and `already_refunded` then refuses every
  // retry — so the remediation path is closed by the record of the failure. It
  // returns early instead, leaving the purchase `paid` and the entitlement
  // intact, which is a state a retry can act on.
  let buyerRefundedBuzz = 0;
  try {
    const refund = await refundMultiAccountTransaction({
      externalTransactionIdPrefix: purchase.buzzTransactionId,
      description: `App item refunded - ${args.reason}`.slice(0, 100),
    });
    buyerRefundedBuzz = refund.totalRefunded;
  } catch (error) {
    void logToAxiom(
      {
        name: BLOCK_GOODS_LOG_NAME,
        type: 'error',
        message: 'refund ABORTED — the buyer was not repaid',
        purchaseId: purchase.id,
        error: messageOf(error),
      },
      'civitai-prod'
    ).catch(() => undefined);
    return { refunded: false, reason: 'buyer_refund_failed' };
  }

  let clawedBackBuzz = 0;
  for (const payout of readRecordedPayouts(purchase.payouts)) {
    if (payout.amount <= 0) continue;
    if (!payout.transactionId) {
      failures.push(
        `payout to user ${payout.userId} of ${payout.amount} ${payout.color} has no recorded transaction id`
      );
      continue;
    }
    try {
      await refundTransaction(payout.transactionId, `App item refunded - ${args.reason}`);
      clawedBackBuzz += payout.amount;
    } catch (error) {
      failures.push(
        `clawback of ${payout.amount} ${payout.color} from user ${payout.userId} failed: ${
          messageOf(error) ?? 'unknown error'
        }`
      );
    }
  }

  await dbWrite.$transaction(async (tx) => {
    await tx.blockGoodPurchase.update({
      where: { id: purchase.id },
      data: {
        status: PURCHASE_STATUS_REFUNDED,
        refundReason: args.reason,
        refundedAt: new Date(),
      },
    });
    await tx.blockGoodEntitlement.updateMany({
      where: { purchaseId: purchase.id, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: args.reason },
    });
  });

  if (failures.length > 0) {
    void logToAxiom(
      {
        name: BLOCK_GOODS_LOG_NAME,
        type: 'error',
        message: 'refund completed with failures',
        purchaseId: purchase.id,
        failures,
      },
      'civitai-prod'
    ).catch(() => undefined);
  }

  return { refunded: true, buyerRefundedBuzz, clawedBackBuzz, failures };
}

/**
 * Narrow the `payouts` JSON column back to the shape the purchase path wrote.
 * It is read off the database as `unknown`, and a refund is money, so every
 * field is checked rather than cast.
 */
export function readRecordedPayouts(raw: unknown): BlockGoodPayout[] {
  if (!Array.isArray(raw)) return [];
  const out: BlockGoodPayout[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { userId, amount, color, transactionId } = entry as Record<string, unknown>;
    if (typeof userId !== 'number' || typeof amount !== 'number' || typeof color !== 'string')
      continue;
    out.push({
      userId,
      amount,
      color: color as BuzzAccountType,
      ...(typeof transactionId === 'string' && transactionId.length > 0 ? { transactionId } : {}),
    });
  }
  return out;
}

/**
 * Does this purchase still owe its app owner money? The ONE spelling of the
 * owner-payout re-run set, so a re-runner cannot re-derive it — the prose
 * version of this has already been widened by accident once.
 *
 * `status = 'paid' AND sum(payouts[].amount) < app_owner_share_buzz`. The
 * argument for each half is on `payBlockGoodOwner`'s header; the short version
 * is that the shortfall test is TRUE for every unpaid row, `pending` rows and
 * `refunded` tombstones included, so without the status test it selects rows
 * whose debit was never confirmed or was reversed.
 *
 * ⚠️ Nothing calls this in production: there is no re-runner. It exists to be
 * the thing the re-runner calls, and to be testable in the meantime.
 */
export function owesOwnerPayout(row: {
  status: string;
  payouts: unknown;
  appOwnerShareBuzz: number;
}): boolean {
  if (row.status !== PURCHASE_STATUS_PAID) return false;
  const paidSoFar = readRecordedPayouts(row.payouts).reduce((sum, leg) => sum + leg.amount, 0);
  return paidSoFar < row.appOwnerShareBuzz;
}

/**
 * Detected by CODE rather than `instanceof`, deliberately: the branch must stay
 * reachable under a mocked Prisma client, which does not construct the real
 * error class. Mirrors `author-fee-accrual.service.ts`.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

function messageOf(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return undefined;
}
