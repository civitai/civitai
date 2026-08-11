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
    'loadOwnedListing + resolveOwnerScreenshotTarget widened to owner | ACCEPTED ' +
    'collaborator | moderator via resolveListingAccess. Keeps its pre-existing mod ' +
    'bypass (D1). loadValidatedImage is NOT widened: it gates IMAGE ownership, and an ' +
    'editor attaches their OWN uploads.',
  'src/server/services/blocks/offsite-listing.service.ts':
    'loadOwnedEditableListing, getMyListingForApp and submitListingRevision widened to ' +
    'owner | ACCEPTED collaborator. Still NO mod bypass (D1). submitListingRevision ' +
    'needed the seat check specifically because beginListingRevision clones the shadow ' +
    'with the PARENT OWNER’s userId, so an editor’s own shadow reads as not-theirs.',
  'src/server/services/blocks/app-analytics.service.ts':
    'getOwnedAppBlocks resolves the permitted-id SET (owned + seated) instead of ' +
    '`app: { userId }`. Safe to widen HERE because every downstream aggregate filters ' +
    'appBlockId IN thatSet — unlike the appOwnerUserId-keyed earnings reads.',
  'src/server/services/appBlockReview.service.ts':
    'The self-review exclusion is widened to the INSIDER set (owner + accepted ' +
    'collaborators, regardless of `displayed`) so a collaborator cannot 5-star the app ' +
    'they co-author. Pending/rejected invitees are NOT insiders.',
  'src/server/services/blocks/offsite-moderation.service.ts':
    'loadOwnedListingInTx (unpublish/republish own listing) and ' +
    'listMyListingModerationEvents are NOT widened: unpublishing a live listing and ' +
    'reading its moderation history are OWNER-scoped lifecycle actions, not content ' +
    'editing. Kept strictly owner-only, no mod bypass (D1).',
  'src/server/services/blocks/app-access.service.ts':
    'THE predicate itself — resolveAppAccess / resolveListingAccess / ' +
    'resolveAccessibleAppBlockIds. Every other site delegates here.',
  'src/server/services/blocks/app-collaborator.service.ts':
    'assertOwner — seat management is OWNER-ONLY by product decision (an editor is a ' +
    'co-owner in every respect EXCEPT managing collaborators and initiating a ' +
    'transfer). Deliberately does NOT use resolveAppAccess, because "role !== null" is ' +
    'the wrong question here; only `owner` may pass.',
  'src/server/services/blocks/app-ownership-transfer.service.ts':
    'loadOwnedApp — initiating a transfer is OWNER-ONLY, same reasoning as seat ' +
    'management. Accept is gated on being the transfer’s ADDRESSEE, not on any role.',
  'src/server/services/blocks/app-collaborator-earnings.service.ts':
    'The app-scoped money read: resolves the role FIRST and filters by appBlockId + the ' +
    'CURRENT owner. Never appOwnerUserId alone — that is the portfolio leak.',
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
 * The ownership predicates, in every spelling that appears in production.
 *
 * `app.userId` / `app?.userId` — the canonical OauthClient owner reached via AppBlock.
 * `resolveAppAccess` / `resolveListingAccess` / `resolveAccessibleAppBlockIds` — the
 * consolidated predicate (a site that delegates must still be in the ledger).
 * `assertAppEditAccess` — the blocks.router wrapper.
 */
const GATE_RE =
  /app\??\.userId|app:\s*\{\s*userId|resolveAppAccess|resolveListingAccess|resolveAccessibleAppBlockIds|assertAppEditAccess|listAppInsiderUserIds|loadOwnedListingInTx/;

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
    ]);
  });
});
