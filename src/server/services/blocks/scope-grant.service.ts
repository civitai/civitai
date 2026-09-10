/**
 * A6 (audit HIGH / design-gaps C2) — per-user scope-grant consent.
 *
 * The consent ledger that closes the silent-scope-escalation gap. Token
 * issuance intersects the manifest/approved scope set with the user's granted
 * scopes for the app; a scope the app requests but the user has not granted is
 * withheld from the minted token and surfaced to the host as `needs_consent`.
 *
 * Two write paths feed grants:
 *   - install / subscribe (implicit first-consent) → `recordScopeGrant`
 *   - re-consent (the host surfaces the missing scopes; the user accepts)
 *     → `recordScopeGrant` again, which is additive (existing grants persist).
 *
 * The read path (mint) is `getGrantedScopes`. A NULL/missing row means the
 * user has consented to nothing for this app (fail-closed → every scope
 * withheld). A non-NULL `revoked_at` is treated as an empty grant.
 *
 * `granted_scopes` is a set of block-scope strings (the SAME vocabulary as
 * app_blocks.approved_scopes / manifest.scopes — e.g. 'models:read:self'), so
 * the mint-time intersection is a direct set operation, not a bitmask op.
 */

import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { newAppUserScopeGrantId } from '~/server/utils/app-block-ids';

/**
 * True for the ONE Prisma failure that means "this deploy is running ahead of its
 * migration": P2022 — the column named in the query does not exist in the database.
 *
 * Migrations in this project are applied BY HAND, per environment, so the image and
 * the schema are not deployed atomically and `buzz_budget_per_day` can legitimately
 * be absent from a database the current code is talking to. Every OTHER Prisma error
 * — connection loss, timeout, constraint violation — must still propagate: a bare
 * `catch` here would swallow real DB failures and silently return "no budget", which
 * is the fail-OPEN this whole feature exists to prevent.
 *
 * Narrow by CODE, not by message text. The message is a human string that upstream
 * is free to reword; the code is the contract.
 */
export function isMissingColumnError(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'P2022';
}

/**
 * ONCE PER PROCESS, not once per deploy and not once globally — this is a
 * module-level boolean in one Node process, so a fleet of N pods emits up to N
 * lines and a restart re-arms it. That is deliberate and sufficient: the signal
 * wanted is "somebody is running ahead of the migration", which one line per pod
 * carries, and the alternative (a line per spend attempt) would bury it.
 *
 * `error` level on purpose. Reading past a missing column is CORRECT (see
 * `getConsentBuzzBudget`) but it is never an intended steady state — it means a
 * migration is outstanding, and the operator has to be told.
 */
let missingBudgetColumnLogged = false;
function logMissingBudgetColumn(site: string, err: unknown): void {
  if (missingBudgetColumnLogged) return;
  missingBudgetColumnLogged = true;
  logToAxiom(
    {
      name: 'app-blocks-scope-grant',
      type: 'error',
      message:
        `app_user_scope_grants.buzz_budget_per_day is MISSING from this database — ` +
        `apply migration 20260910120000_app_user_scope_grant_buzz_budget. Consent budgets ` +
        `read as "not set" until it lands; the platform per-user daily Buzz cap still applies.`,
      site,
      code: (err as { code?: unknown } | null)?.code,
    },
    'webhooks'
  ).catch(() => {
    /* logging must never break a spend path */
  });
}

/**
 * Returns the set of block-scope strings the user currently has granted for
 * the given app block. Empty set when there is no grant row OR the grant has
 * been revoked (fail-closed: mint withholds every scope and signals consent).
 */
export async function getGrantedScopes(opts: {
  userId: number;
  appBlockId: string;
  db?: 'read' | 'write';
}): Promise<Set<string>> {
  const client = opts.db === 'write' ? dbWrite : dbRead;
  const row = (await client.appUserScopeGrant.findUnique({
    where: { userId_appBlockId: { userId: opts.userId, appBlockId: opts.appBlockId } },
    select: { grantedScopes: true, revokedAt: true },
  })) as { grantedScopes: string[]; revokedAt: Date | null } | null;
  if (!row || row.revokedAt) return new Set();
  return new Set(row.grantedScopes ?? []);
}

/**
 * Reads the per-(user, app) CONSENT BUDGET — the daily Buzz ceiling the viewer
 * themselves set for this app when they consented. `null` means the user set no
 * budget, in which case the app spends under the platform's own per-user daily
 * ceiling (`BLOCK_BUZZ_CAP_PER_DAY`) alone — the behaviour of every grant written
 * before the column existed.
 *
 * 🔴 A REVOKED GRANT RETURNS `null`, AND THAT IS NOT A LOOSENING. `getGrantedScopes`
 * already treats a revoked row as an empty grant, so a revoked user's token carries
 * no `ai:write:budgeted` and can reach no spend path at all — there is nothing left
 * for a budget to bound. Returning the stored number for a revoked row would be
 * enforcing a ceiling on spend that cannot happen.
 *
 * ⚠️ THE REVOKED BRANCH IS AN INVARIANT GUARD, NOT REGRESSION COVERAGE, BECAUSE THE
 * STATE IS CURRENTLY UNREACHABLE. Nothing in this codebase ever SETS
 * `app_user_scope_grants.revoked_at` — grep it: every write is `revokedAt: null`
 * (re-granting un-revokes). A revoked row therefore only exists if an operator writes
 * one by hand. The `!row || row.revokedAt` tests here, in `getGrantedScopes`, and in
 * `listMyScopeGrants` are pinning an invariant against a future revoke path, and the
 * tests that exercise them by constructing a revoked row are testing that invariant —
 * they are NOT evidence that a bug was ever possible on this path.
 *
 * 🔴 READS THE PRIMARY BY DEFAULT. This runs on the spend path, immediately after a
 * consent write that may have just LOWERED the budget: served off the replica, a
 * lag window would spend against the OLD, looser ceiling — the one direction a
 * money cap must never drift. The read is a single unique-index lookup.
 *
 * 🔴 A MISSING COLUMN (P2022) RETURNS `null`, AND THAT IS THE TRUE ANSWER, NOT A
 * FALLBACK. Migrations here are applied by hand, so an image can legitimately run
 * against a database that does not yet have `buzz_budget_per_day`. If the column
 * does not exist then no user can ever have set a budget — "no budget set" is not a
 * degraded guess, it is the only state the database can be in — and `null` routes to
 * exactly the same behaviour every pre-column grant already had: the platform's own
 * `BLOCK_BUZZ_CAP_PER_DAY` ceiling keeps enforcing, unchanged. Only P2022 is caught;
 * any other Prisma failure still throws, because for those the budget is UNKNOWN
 * rather than absent, and treating unknown as "no budget" would be a fail-open.
 */
export async function getConsentBuzzBudget(opts: {
  userId: number;
  appBlockId: string;
  db?: 'read' | 'write';
}): Promise<number | null> {
  const client = opts.db === 'read' ? dbRead : dbWrite;
  let row: { buzzBudgetPerDay: number | null; revokedAt: Date | null } | null;
  try {
    row = (await client.appUserScopeGrant.findUnique({
      where: { userId_appBlockId: { userId: opts.userId, appBlockId: opts.appBlockId } },
      select: { buzzBudgetPerDay: true, revokedAt: true },
    })) as { buzzBudgetPerDay: number | null; revokedAt: Date | null } | null;
  } catch (err) {
    if (!isMissingColumnError(err)) throw err;
    logMissingBudgetColumn('getConsentBuzzBudget', err);
    return null;
  }
  if (!row || row.revokedAt) return null;
  const budget = row.buzzBudgetPerDay;
  // Guard the VALUE, not just its presence: a non-positive or non-finite number
  // read back from the DB would otherwise become a cap of 0 or NaN, and `total >
  // NaN` is false — i.e. a corrupt row would silently DISABLE the cap. Treat any
  // unusable value as "no budget set" (the platform cap still applies).
  if (typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0) return null;
  return Math.floor(budget);
}

/**
 * Records (or extends) a user's consent for an app block. ADDITIVE — scopes
 * the user already granted persist; the supplied scopes are unioned in. Writing
 * a grant also clears any prior `revoked_at` (re-granting un-revokes), and
 * stamps the version the consent was taken against.
 *
 * Called from the install / subscribe paths (implicit first-consent) and from
 * the re-consent path. Idempotent on (user, app_block) via the unique index;
 * concurrent first-writes manifest as a P2002 which we retry as an update.
 *
 * `scopes` is filtered to the app's currently-approved scope set by the caller
 * (install/subscribe already resolve the AppBlock manifest) — this service does
 * NOT re-derive the ceiling; it stores exactly what it is told the user
 * consented to. Unknown/garbage scopes simply never match at mint.
 *
 * ## `buzzBudgetPerDay` semantics — NOT additive, and deliberately not
 *
 * The scope set unions because "I already let you read my models" and "now also
 * spend my Buzz" are both true at once. A budget is a single number and cannot
 * union; it can only be kept or replaced. So:
 *
 *   - `buzzBudgetPerDay: <number>` → OVERWRITES the stored value. The user just
 *     told us what they want; the newest statement wins.
 *   - `buzzBudgetPerDay: null`     → OVERWRITES with "no budget" (an explicit
 *     clear — the user removed their limit).
 *   - key OMITTED (`undefined`)    → LEAVES the stored value untouched.
 *
 * That third case is the one that matters, and it is why this is `'buzzBudgetPerDay'
 * in opts` rather than a `!== undefined` test on the value. A re-consent for a NEW
 * scope (the host surfaces `needs_consent`, the user clicks Allow) sends only the
 * scopes; if an omitted budget were written through as NULL, accepting one extra
 * permission would silently wipe a spend limit the user had deliberately set —
 * a widening, performed by a dialog that said nothing about money.
 */
/**
 * 🔴 THE WRITES BELOW MUST NEVER READ A COLUMN BACK. Prisma's DEFAULT selection is
 * "every scalar", so a `create`/`update` with no `select` emits
 * `RETURNING … buzz_budget_per_day` — which makes an ordinary install / subscribe /
 * re-consent throw P2022 against a database that has not had the migration applied
 * yet, i.e. a 500 on every grant write from a deploy that lands first. MEASURED on
 * this PR's own preview environment before this select existed.
 *
 * `id` is picked because it is the primary key: it predates this feature, it can
 * never be the column a future migration is racing, and no caller uses the return
 * value (both writers return `void`). Do NOT widen this to include a column added by
 * a pending migration — the whole point is that these writes read nothing new.
 */
const WRITE_RETURN_SELECT = { id: true } as const;

export async function recordScopeGrant(opts: {
  userId: number;
  appBlockId: string;
  version: string;
  scopes: string[];
  /** Omit to leave any stored budget untouched; `null` explicitly clears it. */
  buzzBudgetPerDay?: number | null;
}): Promise<void> {
  const { userId, appBlockId, version } = opts;
  // Presence of the KEY, not truthiness of the value — see the doc above.
  const budgetSupplied = 'buzzBudgetPerDay' in opts;
  const budgetData = budgetSupplied ? { buzzBudgetPerDay: opts.buzzBudgetPerDay ?? null } : {};
  // Dedup + drop empties so the stored array stays clean.
  const incoming = Array.from(
    new Set(opts.scopes.filter((s) => typeof s === 'string' && s.length > 0))
  );

  const existing = (await dbWrite.appUserScopeGrant.findUnique({
    where: { userId_appBlockId: { userId, appBlockId } },
    select: { id: true, grantedScopes: true },
  })) as { id: string; grantedScopes: string[] } | null;

  if (existing) {
    const merged = Array.from(new Set([...(existing.grantedScopes ?? []), ...incoming]));
    await dbWrite.appUserScopeGrant.update({
      where: { id: existing.id },
      data: { grantedScopes: merged, version, revokedAt: null, ...budgetData },
      select: WRITE_RETURN_SELECT,
    });
    return;
  }

  try {
    await dbWrite.appUserScopeGrant.create({
      data: {
        id: newAppUserScopeGrantId(),
        userId,
        appBlockId,
        version,
        grantedScopes: incoming,
        ...budgetData,
      },
      select: WRITE_RETURN_SELECT,
    });
  } catch (err) {
    // Concurrent first-write race on the (user, app_block) unique index →
    // fall through to an additive update so neither writer's scopes are lost.
    const code = (err as { code?: unknown })?.code;
    if (code !== 'P2002') throw err;
    const row = (await dbWrite.appUserScopeGrant.findUnique({
      where: { userId_appBlockId: { userId, appBlockId } },
      select: { id: true, grantedScopes: true },
    })) as { id: string; grantedScopes: string[] } | null;
    if (!row) throw err;
    const merged = Array.from(new Set([...(row.grantedScopes ?? []), ...incoming]));
    await dbWrite.appUserScopeGrant.update({
      where: { id: row.id },
      data: { grantedScopes: merged, version, revokedAt: null, ...budgetData },
      select: WRITE_RETURN_SELECT,
    });
  }
}

/**
 * Intersects the scopes the token would otherwise carry with the user's
 * granted scopes, returning the granted subset to sign + the withheld scopes
 * the host must re-consent for.
 *
 * `apps:storage:*` (per-user KV) is intentionally NOT consent-gated here — it is
 * an ambient-but-otherwise-gated scope with its own issuance-time / per-op check
 * (resolveStorageContext). Subjecting it to per-user consent would make the
 * publisher re-consent to their own block's storage on every version bump for
 * no security gain. The remaining user-resource scopes (user/ai/buzz/
 * social, models:write) flow through the consent gate.
 *
 * `apps:storage:shared:read` / `apps:storage:shared:write` (the SHARED, app-
 * global / cross-user datastore) are ALSO exempt — and, unlike the per-user
 * scopes, they are NOT publisher-only. Their governance is NOT a per-scope
 * consent prompt but the SERVER-SIDE controls in `resolveSharedContext`
 * (apps-shared.router.ts): a fail-closed min-trust gate (not-anon, not-banned,
 * not-muted, onboarding-complete, email-verified, account age ≥ 7d) plus
 * content moderation and one-vote / per-user-row / rate limits, all enforced at
 * every read/write REGARDLESS of the token scope. `shared:read` is reading
 * PUBLIC community data (anon-safe — the router allows anon reads by design);
 * `shared:write` is trust-gated PUBLIC posting/voting (the resolver rejects anon
 * and any ineligible caller before touching data, whether or not the scope is
 * present). A per-scope consent prompt would add nothing that the trust gate +
 * moderation don't already enforce — so, mirroring the per-user storage scopes,
 * these sign without a grant. (Pre-GA consideration, NOT built here: an EXPLICIT
 * shared-WRITE consent prompt if widening the audience beyond the trust gate.)
 *
 * `models:read:self` is ALSO exempt (allow-by-default): a low-sensitivity read
 * of the viewer's OWN models, and a no-op for an anon viewer (no user → nothing
 * to read), so it is safe in an anon token. Exempting it lets the block render
 * fully for a logged-in viewer with no upfront consent prompt; the consent gate
 * is reserved for the money / AI scopes (`ai:write:budgeted`, `buzz:read:self`),
 * which the host requests lazily on the first buzz-spending action (Generate)
 * rather than on load.
 *
 * `collections:read:self` / `collections:write:self` are exempt — but
 * `collections:read:private` is DELIBERATELY NOT (the read split, below). The
 * exempt pair's gate is SERVER-SIDE per op, not a per-scope consent prompt:
 * read:self covers own-PUBLIC + any PUBLIC collection (public data — nothing
 * sensitive to consent to), and the follow write is SELF-BOUND to the token
 * subject (a bookmark on the caller's OWN account). A per-scope consent prompt
 * would add nothing the visibility/ownership/subject checks don't already
 * enforce. Exempting them is ALSO the #3090 fix: a page-app token that declared a
 * consent-gated scope silently dropped it at mint (the user had no grant row) →
 * every op 403'd; consent-exempt scopes flow through partitionByConsent
 * unconditionally, so the minted PAGE token actually carries them end-to-end.
 *
 * `collections:read:private` (the subject's OWN PRIVATE collections) is the
 * CONSENT-GATED half of the read split and is INTENTIONALLY absent from this set:
 * reading a user's private collections IS sensitive, so it must flow through the
 * gated branch — the host surfaces it as `needs_consent`, the user grants it, and
 * only then does a token carry it. (This is the deliberate contrast to the #3090
 * exemption above: read:self always mints; read:private mints only after consent.)
 */
const CONSENT_EXEMPT_SCOPES = new Set([
  // NOTE: block:settings:* is intentionally ABSENT — those scopes were removed
  // from the block-scope registry (decorative/unenforced). Do NOT re-add them
  // here: if a settings scope is ever reintroduced it must be reintroduced WITH
  // an explicit consent decision, not silently exempted (a stale exempt entry
  // would mint it consent-free the moment it re-entered the registry).
  'apps:storage:read',
  'apps:storage:write',
  // SHARED (cross-user) storage — governed by resolveSharedContext's server-side
  // min-trust gate + content moderation + rate limits, not per-scope consent.
  'apps:storage:shared:read',
  'apps:storage:shared:write',
  'models:read:self',
  // Collections — server-side visibility/ownership (read) + self-bound subject
  // (follow) are the gate; see the block collections endpoints. #3090: exempting
  // them guarantees they reach `claims.scopes` in the minted page token.
  'collections:read:self',
  'collections:write:self',
]);

export function partitionByConsent(
  requestedScopes: string[],
  grantedScopes: Set<string>
): { signable: string[]; missing: string[] } {
  const signable: string[] = [];
  const missing: string[] = [];
  for (const scope of requestedScopes) {
    if (CONSENT_EXEMPT_SCOPES.has(scope) || grantedScopes.has(scope)) {
      signable.push(scope);
    } else {
      missing.push(scope);
    }
  }
  return { signable, missing };
}

/**
 * The consent-gated subset of a scope list — the scopes that REQUIRE a grant
 * (i.e. excluding the consent-exempt publisher/ambient scopes). Used by the
 * install/subscribe paths so the implicit first-consent grant doesn't bother
 * recording exempt scopes (they're not consulted at mint anyway).
 */
export function consentGatedScopes(scopes: string[]): string[] {
  return scopes.filter((s) => !CONSENT_EXEMPT_SCOPES.has(s));
}
