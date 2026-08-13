import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';
import { describe, expect, it } from 'vitest';

/**
 * 🔴 SEAM GUARD for app-ownership gating.
 *
 * The behavioural suites prove each gate is individually correct. What none of them can
 * express is the property that decays: that the SET of production sites which decide
 * "may this caller act on this app?" is CLOSED, and that every member of it made a
 * deliberate COLLABORATOR decision.
 *
 * Nothing in the compiler notices when someone adds a thirteenth owner-gated proc with
 * a fresh `block.app?.userId !== ctx.user!.id`. It would ship silently owner-only,
 * quietly excluding every collaborator from a capability the product says they have —
 * a defect that produces no error, only an inexplicable FORBIDDEN for one class of
 * user. So this ledger names every site together with its collaborator decision, and
 * FAILS when the set GROWS (someone added a gate without deciding) or SHRINKS (someone
 * removed or renamed one and the reasoning here went stale).
 *
 * A structural check type-checks past a wrong argument, so this is deliberately NOT the
 * only guard — `app-access.service.test.ts`'s role × subject matrix and the per-service
 * behavioural suites pin the VALUES. This pins the POPULATION.
 *
 * Test files are OUT of scope on purpose: a test may legitimately compare a userId for
 * any reason.
 *
 * ## 🔴 THE SECOND POPULATION, added with the block→listing re-key
 *
 * A gate answering "may this caller act?" is now only half the question. Since seats are
 * keyed to `AppListing`, an OFF-SITE listing can hold them — and what a seat UNLOCKS is
 * DERIVED from the listing's `kind` (`capabilitiesForKind`). That derivation is a second
 * decayable set: a new site that hard-codes "editors get earnings" instead of consulting
 * the table would hand an off-site editor a capability the schema cannot support, and no
 * gate ledger would notice, because no gate would have changed. So {@link
 * KIND_CAPABILITY_LEDGER} enumerates every consumer of the capability table with the
 * same fails-on-GROWTH-and-SHRINK property.
 *
 * ## The disagreements this ledger records rather than normalises
 *
 * Consolidating these predicates surfaced four genuine inconsistencies between sites
 * that all claim to answer the same question. They are documented as data below,
 * because silently "fixing" any of them is a behaviour change that deserves its own
 * decision, not a side effect of a collaborators PR:
 *
 *   D1. MOD BYPASS IS INCONSISTENT. `app-listing-assets::loadOwnedListing` bypasses for
 *       moderators; `offsite-listing::loadOwnedEditableListing` and
 *       `offsite-moderation::loadOwnedListingInTx` deliberately do NOT ("no mod
 *       override on the author edit path"); the four `blocks.router` gates also do not.
 *       Three sibling gates on the same objects, two answers.
 *   D2. BAN CHECKS WERE ASYMMETRIC. `getMyAppRepo`, `updateManifest` and
 *       `getMyForgejoCloneInfo` each carried an explicit `bannedAt` re-check;
 *       `getMyAppManifest` did not. FIXED in this change (added, matching its siblings)
 *       because it was plainly an omission rather than a decision.
 *   D3. THE OWNERSHIP KEY DIFFERS. Most sites key on `AppListing.userId` or
 *       `AppBlock.app.userId`, but `withdrawExternalRequest` keys on
 *       `AppBlockPublishRequest.submittedByUserId` — the SUBMITTER, which after an
 *       ownership transfer is deliberately NOT the owner. Left as-is: withdrawing your
 *       own submission is a different question from owning the app.
 *   D4. EARNINGS SCOPING DIVERGES BETWEEN SIBLINGS. `getMyAppAnalytics` resolves a
 *       permitted-id set and filters by it; `getMyRevenue` filters by
 *       `appOwnerUserId` and is user-wide. Left as-is, deliberately — see the note on
 *       `getMyRevenue`, which must keep showing an ex-owner the money they accrued
 *       before transferring an app away.
 *   D5. THE OWNER HALF OF A GATE READ A DIFFERENT COLUMN FROM ITS SEAT HALF. Five gates
 *       spelled the owner question as `<row>.userId !== callerId` against
 *       `AppListing.userId` — a DENORMALIZED copy for an on-site listing, whose canonical
 *       owner is `AppBlock.app.userId` — while their seat half delegated to
 *       `resolveListingAccess`, which resolves the canonical owner. On a drifted onsite
 *       row those two halves disagree, and the disagreement is two-sided: the REAL owner
 *       resolves as `owner` (not `editor`) and is refused, and whoever the stale column
 *       names walks straight through the first comparison. FIXED (not merely recorded):
 *       all five now ask `resolveListingAccess`. The class this ledger used to record is
 *       consequently EMPTY for every collaborator-reachable gate, and
 *       {@link DENORM_OWNER_HOLDOUTS} keeps it that way while naming the owner-only
 *       holdouts that are NOT fixed.
 */

const ROOT = process.cwd();

/**
 * EVERY production site that gates on app ownership, mapped to its collaborator
 * decision. Update this table in the same commit as any change to the set.
 */
const GATE_LEDGER: Record<string, string> = {
  'src/server/routers/blocks.router.ts':
    'FOUR owner-scoped procs (getMyAppRepo, getMyAppManifest, updateManifest, ' +
    'getMyForgejoCloneInfo) now route through the shared assertAppEditAccess → ' +
    'resolveAppAccess, so an ACCEPTED collaborator reaches them and a pending/rejected ' +
    'invitee does not. NO mod bypass — preserved exactly as it was (D1). getMyApps is ' +
    'widened to owned+seated via getMyAppsEarnings; getMyRevenue is deliberately NOT ' +
    'widened (D4).',
  'src/server/services/blocks/app-listing-assets.service.ts':
    'loadOwnedListing is THE gate: owner | ACCEPTED collaborator | moderator, with BOTH ' +
    'the owner half and the seat half resolved by resolveListingAccess — never the ' +
    'denormalized AppListing.userId (D5). Keeps its pre-existing mod bypass (D1), which ' +
    'still short-circuits first so a mod pays no extra read. resolveOwnerScreenshotTarget ' +
    'no longer runs its own early copy of the gate: it called loadOwnedListing on the ' +
    'same listing one line later, so the copy was pure drift surface. loadValidatedImage ' +
    'is NOT widened: it gates IMAGE ownership, and an editor attaches their OWN uploads.',
  'src/server/services/blocks/offsite-listing.service.ts':
    'loadOwnedEditableListing, getMyListingForApp and submitListingRevision are owner | ' +
    'ACCEPTED collaborator, all three via the one resolveListingRole helper (a thin read ' +
    'of resolveListingAccess) — the owner half included, so a stale denormalized column ' +
    'cannot invert them (D5). Still NO mod bypass (D1). submitListingRevision needed the ' +
    'seat check specifically because beginListingRevision clones the shadow with the ' +
    'PARENT OWNER’s userId, so an editor’s own shadow reads as not-theirs — and that ' +
    'clone is a copy of a copy, which is why reading it directly was doubly wrong.',
  'src/server/services/blocks/app-analytics.service.ts':
    'getOwnedAppBlocks resolves the permitted-id SET (owned + seated) instead of ' +
    '`app: { userId }`. Safe to widen HERE because every downstream aggregate filters ' +
    'appBlockId IN thatSet — unlike the appOwnerUserId-keyed earnings reads. Since the ' +
    'listing re-key an OFF-SITE seat contributes no block id to that set (it has no ' +
    'block), so this read is unchanged for offsite: analytics for an offsite listing is ' +
    'AppListingMetric, a different surface, not this block-scoped one.',
  'src/server/services/appBlockReview.service.ts':
    'The self-review exclusion is widened to the INSIDER set (owner + accepted ' +
    'collaborators, regardless of `displayed`) so a collaborator cannot 5-star the app ' +
    'they co-author. Pending/rejected invitees are NOT insiders.',
  'src/server/services/blocks/offsite-moderation.service.ts':
    'loadOwnedListingInTx (unpublish/republish own listing) and ' +
    'listMyListingModerationEvents are NOT widened: unpublishing a live listing and ' +
    'reading its moderation history are OWNER-scoped lifecycle actions, not content ' +
    'editing. Kept strictly owner-only, no mod bypass (D1). 🔴 claimListing ALSO lives ' +
    'here and writes AppListing.userId for offsite — the same column acceptTransfer now ' +
    'moves. They are reconciled, not merged: claim is a MOD remedy gated on ' +
    'status IN (approved,removed); the transfer is owner-initiated + recipient-consented ' +
    'and its offsite write is guarded on userId = the snapshotted fromUserId, so a claim ' +
    'landing in the window makes the accept fail closed instead of undoing the remedy.',
  'src/server/services/blocks/app-access.service.ts':
    'THE predicate itself — resolveAppAccess / resolveListingAccess / ' +
    'resolveAccessibleAppBlockIds — plus capabilitiesForKind, the derived per-KIND ' +
    'capability table. Every other site delegates here. Seats are keyed to AppListing ' +
    'so an offsite listing can hold collaborators. 🔴 BOTH resolvers report the CANONICAL ' +
    'owner (`appBlock.app.userId ?? listing.userId`), never the denormalized ' +
    'AppListing.userId alone: a SHADOW REVISION clones that column and no ownership ' +
    'write ever revisits the clone, so the copy can be stale — and a stale copy inverts ' +
    'every gate that delegates here, refusing the real owner while admitting the name ' +
    'the row happens to carry. (NOT acceptTransfer’s onsite listing write, which is ' +
    'unconditional and heals the parent; see app-access.denormalized-owner-drift.test.ts ' +
    'for the mechanism in full.) 🔴 The resolution is BLOCK-FIRST, not kind-branching, ' +
    'and on an offsite-listing-that-carries-a-block it names the wrong owner after a ' +
    'transfer or a mod claim — 0 rows and unmintable today, tracked as issue #3844.',
  'src/server/services/blocks/app-collaborator.service.ts':
    'assertOwner — seat management is OWNER-ONLY by product decision (an editor is a ' +
    'co-owner in every respect EXCEPT managing collaborators and initiating a ' +
    'transfer). Deliberately does NOT use resolveAppAccess, because "role !== null" is ' +
    'the wrong question here; only `owner` may pass. listCollaborators DOES use it, and ' +
    'requires a non-null role (or a moderator): the roster exposes accepted seats whose ' +
    'holder opted OUT of the public byline, plus invitedBy and timestamps, so it is not ' +
    'a public read. A pending invitee reads their own invite via listMyPendingInvites.',
  'src/server/services/blocks/app-ownership-transfer.service.ts':
    'loadOwnedListing — initiating a transfer is OWNER-ONLY, same reasoning as seat ' +
    'management. Accept is gated on being the transfer’s ADDRESSEE, not on any role, ' +
    'and re-reads bannedAt in-tx on the primary. getPendingTransfer resolves the caller ' +
    'and returns the row only to the OWNER or the ADDRESSEE — null (never FORBIDDEN) to ' +
    'anyone else, so the read cannot become an existence oracle. Editors are excluded: ' +
    'disposing of the listing is the one capability a seat never carries. 🔴 KIND-AWARE: ' +
    'onsite moves OauthClient.userId + AppListing.userId; offsite moves the listing ' +
    'column ONLY and is REFUSED outright when the listing carries a connectClientId.',
  'src/server/services/blocks/app-collaborator-earnings.service.ts':
    'The app-scoped money read: resolves the role FIRST and filters by appBlockId + the ' +
    'CURRENT owner. Never appOwnerUserId alone — that is the portfolio leak. 🔴 Also the ' +
    'KIND gate: earnings are block-scoped, so an offsite listing is refused with an ' +
    'explicit unsupportedKind rather than a zeroed summary.',
  'src/server/services/blocks/app-listing-mapper.ts':
    'Reads ab.app.userId to STAMP the listing’s denormalized owner at creation. Not an ' +
    'access gate — no caller identity is involved — but listed so the ownership-write ' +
    'sites stay enumerated alongside the ownership-read sites.',
  'src/server/services/blocks/app-listing-backfill.service.ts':
    'Same as the mapper: a mod-only backfill STAMPING the denormalized owner. Not a ' +
    'caller-identity gate.',
  'src/pages/api/v1/blocks/dev-token.ts':
    'NOT widened, deliberately. This is a THIRD gate shape the ledger surfaced: a ' +
    'positive-match BRANCH CONDITION (`block.app.userId === user.id`) rather than a ' +
    'throw or a where-clause. A non-owner simply does not enter the owned-approved ' +
    'branch and falls through to the same 404 a missing app produces — the file is ' +
    'explicitly built to be ORACLE-FREE. Routing it through resolveAppAccess would ' +
    'change externally-observable behaviour for an unrelated reason, so a collaborator ' +
    'cannot mint a dev token today; that is a follow-up decision, not a silent one.',
  'src/server/services/block-registry.service.ts':
    'NOT widened. resolveOwnedNonApprovedPageBlock and resolveDevPageBlockForAuthor ' +
    'gate the DEV TUNNEL / dev-page mint by pushing `app: { userId }` into the query ' +
    'and failing closed to null. Dev-tunnel access mints a scoped SPEND-capable token, ' +
    'which is a wider capability than listing editing and deserves its own decision ' +
    'rather than riding along on an editor seat.',
  'src/server/services/blocks/buzz-attribution.service.ts':
    'NOT a gate — listed so the population stays closed. `app.userId` here is (a) the ' +
    'value STAMPED into BlockBuzzAttribution.appOwnerUserId at attribution time and ' +
    '(b) the isSelfPurchase / isSelfSpend business-logic branch for revenue share. No ' +
    'caller is being authorised. 🔴 The stamp is deliberately never rewritten by an ' +
    'ownership transfer — see the money-invariance decision.',
  'src/server/services/blocks/publish-request.service.ts':
    'NOT a caller-identity gate: both sites STAMP the owner (the approve path minting ' +
    'the listing via mapAppBlockToListing, and the backfill attributing a synthetic ' +
    'request). 🔴 KNOWN GAP recorded here rather than fixed in this PR: submitVersion’s ' +
    'SUBSEQUENT-version branch never checks that the submitter owns the existing app — ' +
    'it is masked today because both HTTP callers require isModerator. If that is ever ' +
    'opened to non-mod authors it becomes a slug-hijack vector and needs an explicit ' +
    'owner (or collaborator) check.',
};

/**
 * 🔴 THE KIND-CAPABILITY POPULATION — every production site that decides what a seat
 * unlocks by consulting the derived table, mapped to WHICH capability it reads.
 *
 * Why a second ledger rather than more rows in the first: these are not access gates.
 * They answer "can a listing of this KIND do X at all?", which is a question about the
 * schema, not about the caller — and it is a question that did not exist before off-site
 * listings could hold seats. A new consumer that hard-codes the answer instead of asking
 * would be invisible to `GATE_LEDGER`, because it would open no new gate.
 */
const KIND_CAPABILITY_LEDGER: Record<string, string> = {
  'src/server/services/blocks/app-access.service.ts':
    'DEFINES the table (CAPABILITIES_BY_KIND / capabilitiesForKind / ' +
    'listingKindSupports) and resolves each listing’s kind + appBlockId. The two false ' +
    'cells — earnings and submitVersion on offsite — are STRUCTURAL: BlockBuzzAttribution ' +
    'is keyed on appBlockId, and an offsite listing has no bundle and no Forgejo repo. An ' +
    'unknown kind falls back to the NARROWER (offsite) row, i.e. fail closed.',
  'src/server/services/blocks/app-collaborator-earnings.service.ts':
    'CONSUMES `earnings`. Refuses an offsite listing with an explicit unsupportedKind ' +
    'before running any aggregate — never a zeroed summary, which would be ' +
    'indistinguishable from "this app earned nothing". The kind clause and the ' +
    'appBlockId clause are OR-ed and each refuses alone: they disagree on an offsite ' +
    'listing that HAS a block, and on an onsite listing that has none. Collaborators: ' +
    'an accepted editor sees the same refusal as the owner — it is the KIND, not the seat.',
  'src/server/services/blocks/app-collaborator.service.ts':
    'CONSUMES `submitVersion` via `hasWritableRepo`, the ONE predicate behind the ' +
    'Forgejo grant (accept) and both revokes (remove / leave). Gated on KIND rather ' +
    'than on `blockSlug != null`, because `mapAppBlockToListing` can mint an OFFSITE ' +
    'listing that carries a backing AppBlock and therefore a repo slug — a slug-only ' +
    'gate would mint repo write for a collaborator on a listing whose kind declares no ' +
    'version surface at all. Collaborators: an off-site seat decision never reaches ' +
    'Forgejo, in either direction.',
  'src/server/services/blocks/app-ownership-transfer.service.ts':
    'CONSUMES `submitVersion` for acceptTransfer’s post-commit repo swap, so that gate ' +
    'uses the SAME predicate as step (2)’s ownership write. They used to differ ' +
    '(kind vs blockSlug nullness) and disagreed on an offsite-with-a-block listing, ' +
    'where the function left the OauthClient alone while swapping Forgejo write. ' +
    'Collaborators: seats are untouched by a transfer — the listing keeps its editors.',
};

/**
 * The other half of `submitVersion: false` is enforced STRUCTURALLY rather than by a
 * runtime branch, and that is worth writing down because it looks like a missing entry:
 * the version/manifest/repo procs (`getMyAppRepo`, `getMyAppManifest`, `updateManifest`,
 * `getMyForgejoCloneInfo`) are keyed on an `appBlockId`, which an off-site listing does
 * not have. There is no id with which to call them.
 *
 * 🔴 The seat-lifecycle service's Forgejo grant/revoke is a RUNTIME branch, and it now
 * appears in the ledger above because it asks `listingKindSupports(kind,'submitVersion')`
 * rather than "is there a backing AppBlock". Those are not the same predicate — an
 * OFFSITE listing can carry a block — and the difference is pinned behaviourally in
 * `app-collaborator.service.test.ts` ("an OFF-SITE listing that HAS a repo slug still
 * reaches Forgejo NEVER") and in `app-ownership-transfer.service.test.ts` for the accept
 * path's repo swap.
 */

/**
 * The ownership predicates, in every spelling that appears in production.
 *
 * `app.userId` / `app?.userId` — the canonical OauthClient owner reached via AppBlock.
 * `resolveAppAccess` / `resolveListingAccess` / `resolveAccessibleAppBlockIds` — the
 * consolidated predicate (a site that delegates must still be in the ledger).
 * `assertAppEditAccess` — the blocks.router wrapper.
 *
 * 🔴 THE LISTING-OWNER CLASS IS MATCHED EXPLICITLY, and that is the point of the third
 * and fourth alternatives. The gates spelled `listing.userId !== user.id`,
 * `shadow.userId !== userId` and `shot.appListing.userId !== user.id` read the
 * DENORMALIZED owner column, not `app.userId`. Before they were listed here the regex
 * could not see any of them: their files were in the ledger only INCIDENTALLY, matched by
 * an unrelated token (`resolveListingAccess`, `loadOwnedListingInTx`), so a new file
 * opening a fresh `listing.userId !== callerId` gate would have grown the population
 * WITHOUT growing `GATES` — the "fails on GROWTH" assertion below would have stayed green
 * through exactly the event it exists to catch.
 *
 * 🔴 THOSE ALTERNATIVES NOW MATCH NOTHING IN PRODUCTION, AND THEY STAY. All five sites of
 * that class were routed through `resolveListingAccess` (D5), so keeping the alternatives
 * here is what makes a REINTRODUCTION grow `GATES` and fail loudly instead of shipping as
 * a fresh copy of the same inversion. Every shape is probed in the POSITIVE CONTROL test,
 * because a regex nobody has watched match is a claim, not a guard — and that matters
 * more, not less, now that the live corpus no longer exercises them.
 *
 * 🔴 AND IT IS A SPELLING GUARD, NOT A STRUCTURAL ONE. Read {@link DENORM_OWNER_RE}'s
 * KNOWN EVASIONS block before quoting either regex as protection: both are anchored on
 * the RECEIVER NAME (`*listing` / `*shadow` / `<x>.appListing`), so a gate written
 * against a differently-named local evades them entirely. The listing-owner alternatives
 * here accept either operand order, optional chaining and `!=` — but they are a
 * naming-convention lint over this feature's own conventions, and the guard that
 * actually holds the BEHAVIOUR is `app-access.denormalized-owner-drift.test.ts`.
 */
const GATE_RE =
  /app\??\.userId|app:\s*\{\s*userId|(?:\w*[Ll]isting|\w*[Ss]hadow)\??\.userId\s*(?:!==|!=)|(?:!==|!=)\s*(?:\w*[Ll]isting|\w*[Ss]hadow)\??\.userId|\w+\??\.appListing\??\.userId\s*(?:!==|!=)|(?:!==|!=)\s*\w+\??\.appListing\??\.userId|resolveAppAccess|resolveListingAccess|resolveAccessibleAppBlockIds|assertAppEditAccess|listAppInsiderUserIds|loadOwnedListingInTx/;

/**
 * 🔴 THE DENORMALIZED-OWNER GATE CLASS (D5) — every spelling of "compare the caller
 * against `AppListing.userId`", including the positive-branch form.
 *
 * Broader than the corresponding alternatives in {@link GATE_RE} on purpose: this one
 * also matches `===`, because a gate can be written as an ALLOW branch (the self-review
 * exclusion is) and that form is just as stale-able. Kept as a separate regex rather than
 * widened into `GATE_RE` so that the gate POPULATION and the column-read CLASS can be
 * asserted independently — a site can legitimately be in one and not the other.
 *
 * 🔴 KNOWN EVASIONS — READ THIS BEFORE CITING THIS REGEX AS A GUARD. It is a SPELLED
 * check, not a structural one: it is anchored on the RECEIVER NAME. Measured over the
 * whole non-test `src/` corpus, of eleven realistic spellings of the exact D5 regression
 * it catches eight and MISSES three, and the three it misses are ordinary code:
 *
 *   - a HOISTED LOCAL  — `const ownerId = listing.userId; if (ownerId !== userId) …`
 *   - a DESTRUCTURE    — `const { userId: ownerId } = listing; if (ownerId !== …)`
 *   - ANY OTHER NAME   — `row.userId !== userId`, `parent.…`, `draft.…`
 *
 * The three newly-covered spellings (reversed operands, `listing?.userId`, `!=`) were
 * added because they cost nothing: they changed NEITHER matched file set — `GATES` stayed
 * at 16 files and this class stayed at exactly the three holdouts below — so the widening
 * is strictly additive. Going further is not free and was REJECTED with a measurement: a
 * pattern over an ARBITRARY receiver (`(?:\w+\.)*\w+\.userId <op>`) matches **127 files
 * repo-wide and 15 under `src/server/services/blocks/` alone**, almost all of them
 * correct and unrelated (`image.userId`, `session.userId`, `client.userId`,
 * `sub.userId`, `metadata.userId`). As an enumerated-equality assertion that is a
 * permanently-noisy allowlist that decays on every unrelated edit — a gate people learn
 * to click through — and it STILL would not see the hoisted-local or destructured forms.
 *
 * 🔴 SO THE HONEST STATEMENT OF WHAT THIS HOLDS: it is a NAMING-CONVENTION LINT. It keeps
 * a gate written in this feature's own idiom from being reintroduced silently, and it
 * keeps the holdout record from going stale. It is NOT a guarantee that no gate compares
 * against `AppListing.userId`. The guard that actually holds the BEHAVIOUR — for any
 * spelling, because it never reads the source at all — is
 * `app-access.denormalized-owner-drift.test.ts`, which drives all five sites against a
 * drifted fixture and asserts both directions. If you are deciding whether this class is
 * safe, that suite is the evidence; this one is bookkeeping.
 */
const DENORM_OWNER_RE =
  /(?:\w*[Ll]isting|\w*[Ss]hadow)\??\.userId\s*(?:!==|===|!=|==)|(?:!==|===|!=|==)\s*(?:\w*[Ll]isting|\w*[Ss]hadow)\??\.userId|\w+\??\.appListing\??\.userId\s*(?:!==|===|!=|==)|(?:!==|===|!=|==)\s*\w+\??\.appListing\??\.userId/;

/**
 * 🔴 THE CLASS IS NOT DELETED, IT IS EMPTY-EXCEPT-FOR-THESE — and this table is the
 * difference between "we fixed it" and "we stopped looking".
 *
 * Every collaborator-reachable gate now resolves the owner canonically. What is left is
 * three NON-collaborator sites that still compare against the column, listed with why
 * each was not swept along — two owner-only lifecycle gates that carry the same latent
 * inversion, and one that is in the class by SHAPE but safe by CONTEXT (it matches on
 * `appBlockId IS NULL`, where the column IS canonical). "Left as-is" and "safe" are
 * different verdicts and the table states which is which, because a reader who assumes
 * the first means the second is exactly how this class gets forgotten again.
 *
 * The assertion below fails on GROWTH (a new site reads the column IN ONE OF THE
 * SPELLINGS {@link DENORM_OWNER_RE} CAN SEE — read its KNOWN EVASIONS block, this is a
 * naming-convention lint, not a structural guarantee) and on SHRINK (one of these was
 * fixed and this record went stale) — the same property the two ledgers above have,
 * applied to a class rather than to a population.
 */
const DENORM_OWNER_HOLDOUTS: Record<string, string> = {
  'src/server/services/blocks/offsite-moderation.service.ts':
    'TWO owner-only gates: loadOwnedListingInTx (unpublish/republish your own listing, ' +
    'DUAL-KIND so an onsite listing reaches it) and listMyListingModerationEvents. Both ' +
    'carry the same latent inversion as D5 — on a drifted onsite row the real owner is ' +
    'refused and the stale name is admitted — and neither is fixed here. The reason is ' +
    'mechanical, not a judgement that they are safe: loadOwnedListingInTx runs INSIDE an ' +
    'interactive transaction and would need resolveListingAccess to accept a ' +
    'Prisma.TransactionClient, i.e. a widening of the shared AccessDb type that changes ' +
    'the resolver for every caller. That deserves its own PR, not a ride-along.',
  'src/server/services/blocks/publish-request.service.ts':
    'The orphan-draft REUSE check in submitVersion’s first-version branch ' +
    '(`existingSlugListing.userId === submittedByUserId`) — reuse a same-slug ' +
    'pre-approval draft only if it is the submitter’s own, else treat the slug as taken. ' +
    'NOT a stale-copy hazard and NOT scheduled for change: the row it reads is matched on ' +
    '`kind = onsite AND status = draft AND appBlockId IS NULL` in the same condition, and ' +
    'a listing with no backing AppBlock has no OauthClient in its ownership chain, so the ' +
    'column IS the canonical owner there — resolveListingAccess would return the exact ' +
    'same number by its own fallback. Recorded so the class stays enumerated rather than ' +
    'sampled: it is in the class by SHAPE, and safe by CONTEXT.',
  'src/server/services/blocks/app-listing-review.service.ts':
    'The self-review exclusion in upsertAppListingReview, written as an ALLOW branch ' +
    '(`listing.userId === userId` → refuse). Not a collaborator gate at all — it is ' +
    'anti-abuse — but it reads the same denormalized column, so on a drifted onsite ' +
    'listing the REAL owner could review their own app while a stranger named by the ' +
    'stale row could not. NOT fixed here: the block-side equivalent already resolves the ' +
    'insider set (listAppInsiderUserIds), so the right fix is to route this at the same ' +
    'insider seam rather than to swap one column read for another, and widening an ' +
    'anti-abuse rule is a product decision.',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Every non-test .ts/.tsx under src/, as repo-relative POSIX-ish paths. */
function sourceFiles(): string[] {
  return walk(join(ROOT, 'src'))
    .map((f) => relative(ROOT, f).split(sep).join('/'))
    .filter((f) => !/__tests__|\.test\.tsx?$|(^|\/)src\/tests\//.test(f));
}

const FILES = sourceFiles();

/**
 * Source with comments removed — there is a LOT of prose about ownership in this
 * codebase, and only real code should count as a gate site.
 */
function code(file: string): string {
  return readFileSync(join(ROOT, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const CODE = new Map(FILES.map((f) => [f, code(f)] as const));
const GATES = FILES.filter((f) => GATE_RE.test(CODE.get(f)!)).sort();

describe('app-ownership gate ledger', () => {
  it('POSITIVE CONTROL: the scan enumerates a real population and can match', () => {
    // A broken walk or a regex that matches nothing would make every assertion below
    // vacuously true. Prove the instrument works before reading its verdict.
    expect(FILES.length).toBeGreaterThan(500);
    expect(FILES).toContain('src/server/services/blocks/app-access.service.ts');
    expect(GATES.length).toBeGreaterThan(5);
  });

  it('NEGATIVE CONTROL: a definitely-absent predicate matches nothing', () => {
    const bogus = FILES.filter((f) => /resolveAppAccessNoSuchFunction/.test(CODE.get(f)!));
    expect(bogus).toEqual([]);
  });

  it('🔴 POSITIVE CONTROL: GATE_RE matches EVERY gate shape, including the listing-owner class', () => {
    // A regex is only a guard for the shapes it has been WATCHED to match. Each sample
    // is copied from a real production line; the last three are the listing-owner class
    // this PR widened, which GATE_RE was blind to — their files were in the ledger only
    // incidentally, via a different token on an unrelated line.
    const SHAPES: Array<[string, string]> = [
      ['blocks.router hard throw', 'if (block.app?.userId !== ctx.user!.id) throw x;'],
      ['analytics where-clause', 'where: { app: { userId } },'],
      ['the consolidated predicate', 'const access = await resolveAppAccess(id, userId);'],
      ['the router wrapper', 'await assertAppEditAccess(block, ctx.user!.id);'],
      [
        'listing-owner gate (app-listing-assets::loadOwnedListing)',
        'if (listing.userId !== user.id && !user.isModerator) {',
      ],
      [
        'shadow-owner gate (offsite-listing::submitListingRevision)',
        'if (shadow.userId !== userId && !(await isAcceptedListingEditor(shadowId, userId))) {',
      ],
      [
        'screenshot listing-owner gate (app-listing-assets::resolveOwnerScreenshotTarget)',
        'if (shot.appListing.userId !== user.id && !user.isModerator) {',
      ],
      // The three spellings the widening added. Each is a one-token rewrite of a shape
      // above, and each used to walk straight past this regex.
      ['reversed operands', 'if (userId !== listing.userId) throw e;'],
      ['optional chaining', 'if (listing?.userId !== userId) throw e;'],
      ['loose inequality', 'if (listing.userId != userId) throw e;'],
    ];
    for (const [label, sample] of SHAPES) {
      expect(GATE_RE.test(sample), `GATE_RE must recognise: ${label}`).toBe(true);
    }
  });

  it('NEGATIVE CONTROL: GATE_RE does not match an unrelated owner comparison or a plain read', () => {
    // Otherwise the widening above would sweep half the codebase into the population and
    // the equality assertion would become unmaintainable noise rather than a guard.
    expect(GATE_RE.test('if (image.userId !== user.id) return null;')).toBe(false);
    expect(GATE_RE.test('if (post.userId !== ctx.user.id) throw e;')).toBe(false);
    expect(GATE_RE.test('const listing = await dbRead.appListing.findUnique({ where });')).toBe(
      false
    );
  });

  it('the set of production gate sites EXACTLY equals the ledger (fails on GROWTH and on SHRINK)', () => {
    // Enumerated equality, not containment: a 13th gated file fails here, and so does
    // deleting one. The message names the ledger so the fix is obvious — add the file
    // WITH its collaborator decision, or remove the stale entry.
    expect(GATES).toEqual(Object.keys(GATE_LEDGER).sort());
  });

  it('🔴 no site re-opens a bare owner comparison against ctx.user outside the shared helper', () => {
    // The exact shape that was open-coded four times in blocks.router.ts. Anywhere it
    // reappears, a collaborator is being silently excluded.
    for (const [file, src] of CODE) {
      if (file === 'src/server/services/blocks/app-access.service.ts') continue;
      expect(src, `${file} must not re-open-code the router owner gate`).not.toContain(
        'app?.userId !== ctx.user'
      );
    }
  });

  it('every ledger entry names an actual file in the scanned population', () => {
    for (const file of Object.keys(GATE_LEDGER)) {
      expect(CODE.get(file), `${file} is not in the scanned population`).toBeDefined();
    }
  });

  it('every ledger entry carries a non-trivial collaborator decision', () => {
    // Guards against an entry added purely to make the equality test pass.
    for (const [file, rationale] of Object.entries(GATE_LEDGER)) {
      expect(rationale.length, `${file} rationale is too terse to be a decision`).toBeGreaterThan(
        80
      );
      expect(
        /collaborat|owner|seat|insider|access|widen|NOT widened|stamp|denormalized/i.test(
          rationale
        ),
        `${file} rationale must state what it decided about collaborators`
      ).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // 🔴 D5 — the denormalized-owner gate CLASS, pinned as (almost) empty.
  // -------------------------------------------------------------------------

  describe('🔴 the denormalized-owner gate class (D5)', () => {
    const DENORM_SITES = FILES.filter((f) => DENORM_OWNER_RE.test(CODE.get(f)!)).sort();

    it('POSITIVE CONTROL: DENORM_OWNER_RE matches every spelling the fix removed', () => {
      // These five lines are copied verbatim from the pre-fix source. A regex asserting a
      // class is EMPTY is worthless unless it has been watched to match that class — an
      // empty result is otherwise indistinguishable from a typo in the pattern.
      const REMOVED: Array<[string, string]> = [
        [
          'offsite-listing::loadOwnedEditableListing',
          'if (listing.userId !== userId && !(await isAcceptedListingEditor(listingId, userId))) {',
        ],
        [
          'offsite-listing::submitListingRevision',
          'if (shadow.userId !== userId && !(await isAcceptedListingEditor(shadowId, userId))) {',
        ],
        [
          'offsite-listing::getMyListingForApp',
          'if (listing.userId !== userId && !(await isAcceptedListingEditor(listing.id, userId))) {',
        ],
        [
          'app-listing-assets::loadOwnedListing',
          'if (listing.userId !== user.id && !user.isModerator) {',
        ],
        [
          'app-listing-assets::resolveOwnerScreenshotTarget',
          'if (shot.appListing.userId !== user.id && !user.isModerator) {',
        ],
        [
          'the ALLOW-branch form (app-listing-review)',
          'if (listing.userId === userId) { throw throwAuthorizationError(...); }',
        ],
        // Widened spellings — a one-token rewrite of the shapes above, each of which
        // used to evade this regex completely.
        [
          'reversed operands',
          "if (userId !== listing.userId && (await resolveListingRole(id, userId)) !== 'editor') {",
        ],
        ['reversed ALLOW-branch', 'if (userId === listing.userId) { throw e; }'],
        ['optional chaining', 'if (listing?.userId !== userId) throw e;'],
        ['loose inequality', 'if (listing.userId != userId) throw e;'],
        ['shadow, reversed', 'if (userId !== shadow.userId) throw e;'],
        ['nested member, optional', 'if (shot.appListing?.userId !== user.id) throw e;'],
      ];
      for (const [label, sample] of REMOVED) {
        expect(DENORM_OWNER_RE.test(sample), `DENORM_OWNER_RE must recognise: ${label}`).toBe(
          true
        );
      }
    });

    it('🔴 KNOWN EVASIONS: the spellings this regex CANNOT see, pinned as measured', () => {
      // 🔴 THIS TEST ASSERTS A LIMIT, NOT A CAPABILITY, and it is here so the limit is a
      // measured fact in the suite rather than a sentence in a comment nobody re-derives.
      // `DENORM_OWNER_RE` is anchored on the RECEIVER NAME, so a gate written against a
      // differently-named local is invisible to it — including the exact D5 regression,
      // restored verbatim under another name.
      //
      // Do NOT "fix" this by widening the regex to an arbitrary receiver. That was
      // measured: `(?:\w+\.)*\w+\.userId <op>` matches 127 files repo-wide and 15 under
      // `src/server/services/blocks/` alone, nearly all correct and unrelated, which
      // turns the enumerated-equality assertion above into a permanently-noisy
      // allowlist. If one of these forms is what you want caught, the guard is
      // `app-access.denormalized-owner-drift.test.ts` — it asserts BEHAVIOUR and is
      // blind to spelling by construction.
      const EVADES: Array<[string, string]> = [
        ['a hoisted local', 'const ownerId = listing.userId;\nif (ownerId !== userId) throw e;'],
        [
          'a destructure',
          'const { userId: ownerId } = listing;\nif (ownerId !== callerId) throw e;',
        ],
        ['any other receiver name', 'if (row.userId !== userId) throw e;'],
      ];
      for (const [label, sample] of EVADES) {
        expect(
          DENORM_OWNER_RE.test(sample),
          `${label} is a KNOWN evasion — if this now matches, the regex was widened; ` +
            'update the KNOWN EVASIONS comment and re-measure the false-positive count'
        ).toBe(false);
      }
    });

    it('NEGATIVE CONTROL: it does not match the canonical resolution or an unrelated owner', () => {
      // The replacement must NOT itself count as a member of the class, or the assertion
      // below could never go green; and an Image/Post owner check is a different subject.
      expect(DENORM_OWNER_RE.test('const role = await resolveListingRole(listingId, userId);')).toBe(
        false
      );
      expect(
        DENORM_OWNER_RE.test('const ownerUserId = row.appBlock?.app?.userId ?? row.userId;')
      ).toBe(false);
      expect(DENORM_OWNER_RE.test('if (image.userId !== user.id) return null;')).toBe(false);
    });

    it('the class is EMPTY except for the recorded owner-only holdouts (GROWTH and SHRINK)', () => {
      // 🔴 Read the failure message before "fixing" it. GROWTH means a gate went back to
      // comparing against AppListing.userId — the two-sided inversion D5 describes.
      // SHRINK means one of the holdouts was finally fixed and DENORM_OWNER_HOLDOUTS is
      // now lying about the state of the codebase.
      //
      // 🔴 GREEN HERE IS NOT "no gate compares against the column". It is "no gate
      // compares against it in a spelling this regex can see" — see the KNOWN EVASIONS
      // test below and the note on DENORM_OWNER_RE. The behavioural claim belongs to
      // `app-access.denormalized-owner-drift.test.ts`.
      expect(DENORM_SITES).toEqual(Object.keys(DENORM_OWNER_HOLDOUTS).sort());
    });

    it('no file that gates on collaborator ACCESS is in the class', () => {
      // The narrower, behaviour-facing half of the same claim: whatever the holdout list
      // says, a file that consults a seat must not ALSO be comparing against the column —
      // that is exactly the split-brain gate D5 is about (seat half canonical, owner half
      // denormalized), and it is what all five fixed sites looked like.
      const seatAware = FILES.filter((f) =>
        /resolveListingAccess|resolveAppAccess|resolveListingRole/.test(CODE.get(f)!)
      );
      expect(seatAware.length).toBeGreaterThan(2); // positive control: the scan found some
      for (const file of seatAware) {
        expect(
          DENORM_OWNER_RE.test(CODE.get(file)!),
          `${file} resolves a seat canonically but still compares against AppListing.userId`
        ).toBe(false);
      }
    });

    it('every holdout entry names a real file and states why it was left', () => {
      for (const [file, rationale] of Object.entries(DENORM_OWNER_HOLDOUTS)) {
        expect(CODE.get(file), `${file} is not in the scanned population`).toBeDefined();
        expect(rationale.length, `${file} rationale is too terse to be a decision`).toBeGreaterThan(
          80
        );
      }
    });
  });

  it('🔴 the consolidated predicate is the ONLY place the accepted-status filter is written', () => {
    // The consent gate is `status: 'accepted'`. If a second site writes its own seat
    // query, that site can drift — e.g. by forgetting the status filter, which would
    // make a PENDING invite confer capability. One home, one filter.
    const seatQueryFiles = FILES.filter((f) =>
      /appCollaborator\.(findFirst|findMany)/.test(CODE.get(f)!)
    );
    expect(seatQueryFiles.sort()).toEqual([
      'src/server/services/blocks/app-access.service.ts',
      // The seat-lifecycle service reads its OWN rows (roster + inbox + cap), which is
      // management, not an access decision — it must NOT filter on accepted.
      'src/server/services/blocks/app-collaborator.service.ts',
      // 🔴 The MOD claim remedy reads every seat on the claimed listing in order to
      // DELETE them all and audit each by user id. Deliberately UNFILTERED by status: a
      // pending invite is as much of the impersonator's residue as an accepted seat, and
      // leaving it would let them re-enter by having their invitee accept afterwards.
      // This is the one legitimate seat read that must NOT carry the consent filter.
      'src/server/services/blocks/offsite-moderation.service.ts',
    ]);
  });

  // -------------------------------------------------------------------------
  // 🔴 THE RE-KEY, pinned structurally.
  // -------------------------------------------------------------------------

  describe('🔴 seats are keyed to the LISTING, everywhere', () => {
    /** Every `appCollaborator.<op>(` occurrence in production, with its call text. */
    const SEAT_CALLS: Array<[string, string]> = [];
    for (const [file, src] of CODE) {
      const re = /appCollaborator\.\w+\(/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) SEAT_CALLS.push([file, src.slice(m.index, m.index + 300)]);
    }

    it('POSITIVE CONTROL: the scan found the seat calls at all', () => {
      // A regex nobody has watched match is a claim, not a guard — and a zero here would
      // make every assertion below vacuously true.
      expect(SEAT_CALLS.length).toBeGreaterThan(8);
      // THREE files now: the predicate, the seat lifecycle, and the mod claim remedy
      // (which deletes an impersonator's seats in the same tx as the reassign).
      expect(new Set(SEAT_CALLS.map(([f]) => f)).size).toBe(3);
    });

    it('every seat query/write names `appListingId`', () => {
      // The one-line regression this change could suffer: a call left keyed on
      // `appBlockId` would compile (both are strings) and would silently match NOTHING —
      // demoting every editor to no-access with no error anywhere.
      for (const [file, call] of SEAT_CALLS) {
        expect(call, `${file}: a seat call must be keyed on appListingId`).toMatch(
          /appListingId/
        );
      }
    });

    it('the OLD composite seat key `appBlockId_userId` is gone from the seat files', () => {
      // The Prisma selector for the pre-re-key primary key `(appBlockId, userId)`.
      //
      // 🔴 SCOPED TO THE SEAT FILES ON PURPOSE, and the reason is a genuine collision:
      // `AppBlockReview` carries its OWN `@@unique([appBlockId, userId])`, which Prisma
      // ALSO names `appBlockId_userId`. A repo-wide ban on the string would fail on
      // `appBlockReview.service.ts` for a completely unrelated (and correct) selector —
      // an assertion that looks like a re-key regression and is not one.
      const seatFiles = [...new Set(SEAT_CALLS.map(([f]) => f))];
      expect(seatFiles.length).toBe(3);
      for (const file of seatFiles) {
        expect(
          CODE.get(file)!,
          `${file} still uses the pre-re-key composite seat key`
        ).not.toContain('appBlockId_userId');
      }
    });

    it('NEGATIVE CONTROL: the composite-key probe CAN match', () => {
      // Proves the assertion above is testing a string that would be found if present.
      expect('where: { appBlockId_userId: { appBlockId, userId } }').toContain(
        'appBlockId_userId'
      );
    });
  });

  // -------------------------------------------------------------------------
  // 🔴 THE KIND-CAPABILITY POPULATION.
  // -------------------------------------------------------------------------

  describe('🔴 kind-derived capabilities — the second closed population', () => {
    const CAP_RE = /listingKindSupports|capabilitiesForKind|CAPABILITIES_BY_KIND/;
    const CAP_SITES = FILES.filter((f) => CAP_RE.test(CODE.get(f)!)).sort();

    it('POSITIVE CONTROL: CAP_RE matches every spelling that appears in production', () => {
      const SHAPES: Array<[string, string]> = [
        ['the predicate', "if (!listingKindSupports(access.kind, 'earnings')) return x;"],
        ['the whole row', 'const caps = capabilitiesForKind(listing.kind);'],
        ['the table itself', 'CAPABILITIES_BY_KIND[kind] ?? CAPABILITIES_BY_KIND.offsite'],
      ];
      for (const [label, sample] of SHAPES) {
        expect(CAP_RE.test(sample), `CAP_RE must recognise: ${label}`).toBe(true);
      }
      expect(CAP_SITES.length).toBeGreaterThan(0);
    });

    it('NEGATIVE CONTROL: an unrelated kind comparison is not a capability site', () => {
      // `kind === 'offsite'` appears all over the listing services for reasons that have
      // nothing to do with what a SEAT unlocks; sweeping those in would make the ledger
      // unmaintainable noise.
      expect(CAP_RE.test("if (row.kind === 'onsite' && row.appBlock == null) return null;")).toBe(
        false
      );
    });

    it('the set of capability consumers EXACTLY equals the ledger (GROWTH and SHRINK)', () => {
      // A new site that hard-codes "editors get earnings" instead of asking the table
      // would hand an off-site editor a capability the schema cannot support — and would
      // open no gate, so GATE_LEDGER would stay green through it.
      expect(CAP_SITES).toEqual(Object.keys(KIND_CAPABILITY_LEDGER).sort());
    });

    it('every capability-ledger entry names the capability it reads', () => {
      for (const [file, rationale] of Object.entries(KIND_CAPABILITY_LEDGER)) {
        expect(rationale.length, `${file} rationale is too terse`).toBeGreaterThan(80);
        expect(
          /earnings|submitVersion|analytics|listingContent|submitForReview/.test(rationale),
          `${file} must name which capability it consumes`
        ).toBe(true);
      }
    });

    it('every capability-ledger entry names an actual file in the scanned population', () => {
      for (const file of Object.keys(KIND_CAPABILITY_LEDGER)) {
        expect(CODE.get(file), `${file} is not in the scanned population`).toBeDefined();
      }
    });
  });
});
