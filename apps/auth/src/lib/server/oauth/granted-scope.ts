import { sql } from 'kysely';
import { db } from '$lib/server/db/db';
import { scopeFromColumn } from './scope';

/**
 * The scope `userId` has already granted `clientId`: the remembered consent combined with every live
 * refresh token the user holds for that client (approvals made without "remember", or on another
 * device). Null when the user has granted this client nothing.
 */
export async function getGrantedScope(
  userId: number,
  clientId: string,
  now: Date = new Date()
): Promise<bigint | null> {
  const [consent, refresh] = await Promise.all([
    db
      .selectFrom('OauthConsent')
      .select(['scope'])
      .where('userId', '=', userId)
      .where('clientId', '=', clientId)
      .executeTakeFirst(),
    db
      .selectFrom('ApiKey')
      // The wide column where it is set, else the 32-bit one (rows written before the wide column).
      .select(
        sql<string | number | null>`bit_or(coalesce("tokenScopeWide", "tokenScope"))`.as('scope')
      )
      .where('userId', '=', userId)
      .where('clientId', '=', clientId)
      .where('type', '=', 'Refresh')
      .where((eb) => eb.or([eb('expiresAt', '>=', now), eb('expiresAt', 'is', null)]))
      .executeTakeFirst(),
  ]);

  const refreshScope = refresh?.scope == null ? null : scopeFromColumn(refresh.scope);
  if (!consent && refreshScope == null) return null;
  const consentScope = consent?.scope == null ? 0n : scopeFromColumn(consent.scope);
  return consentScope | (refreshScope ?? 0n);
}
