import { db } from '$lib/server/db/db';

/**
 * The scope `userId` has already granted `clientId`: the remembered consent if there is one, else the
 * scope of the user's newest live refresh token for that client (an approval made without "remember").
 * Null when the user has granted this client nothing.
 */
export async function getGrantedScope(
  userId: number,
  clientId: string,
  now: Date = new Date()
): Promise<number | null> {
  const consent = await db
    .selectFrom('OauthConsent')
    .select(['scope'])
    .where('userId', '=', userId)
    .where('clientId', '=', clientId)
    .executeTakeFirst();
  if (consent) return consent.scope;

  const refresh = await db
    .selectFrom('ApiKey')
    .select(['tokenScope'])
    .where('userId', '=', userId)
    .where('clientId', '=', clientId)
    .where('type', '=', 'Refresh')
    .where((eb) => eb.or([eb('expiresAt', '>=', now), eb('expiresAt', 'is', null)]))
    .orderBy('createdAt', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  return refresh?.tokenScope ?? null;
}
