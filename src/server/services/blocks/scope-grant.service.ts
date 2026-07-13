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
import { newAppUserScopeGrantId } from '~/server/utils/app-block-ids';

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
 */
export async function recordScopeGrant(opts: {
  userId: number;
  appBlockId: string;
  version: string;
  scopes: string[];
}): Promise<void> {
  const { userId, appBlockId, version } = opts;
  // Dedup + drop empties so the stored array stays clean.
  const incoming = Array.from(new Set(opts.scopes.filter((s) => typeof s === 'string' && s.length > 0)));

  const existing = (await dbWrite.appUserScopeGrant.findUnique({
    where: { userId_appBlockId: { userId, appBlockId } },
    select: { id: true, grantedScopes: true },
  })) as { id: string; grantedScopes: string[] } | null;

  if (existing) {
    const merged = Array.from(new Set([...(existing.grantedScopes ?? []), ...incoming]));
    await dbWrite.appUserScopeGrant.update({
      where: { id: existing.id },
      data: { grantedScopes: merged, version, revokedAt: null },
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
      },
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
      data: { grantedScopes: merged, version, revokedAt: null },
    });
  }
}

/**
 * Intersects the scopes the token would otherwise carry with the user's
 * granted scopes, returning the granted subset to sign + the withheld scopes
 * the host must re-consent for.
 *
 * `block:settings:*` and `apps:storage:*` (per-user KV) are intentionally NOT
 * consent-gated here — they are publisher-only / ambient-but-otherwise-gated
 * scopes that have their own issuance-time checks (caller-is-installer,
 * resolveStorageContext). Subjecting them to per-user consent would make the
 * publisher re-consent to their own block's settings on every version bump for
 * no security gain. The remaining user-resource scopes (media/user/ai/buzz/
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
 */
const CONSENT_EXEMPT_SCOPES = new Set([
  'block:settings:read',
  'block:settings:write',
  'apps:storage:read',
  'apps:storage:write',
  // SHARED (cross-user) storage — governed by resolveSharedContext's server-side
  // min-trust gate + content moderation + rate limits, not per-scope consent.
  'apps:storage:shared:read',
  'apps:storage:shared:write',
  'models:read:self',
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
