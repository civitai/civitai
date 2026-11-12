import { db } from '$lib/server/db/db';

/**
 * The scope `userId` has already granted `clientId`: the remembered consent combined with every live
 * refresh token the user holds for that client (approvals made without "remember", or on another
 * device). Null when the user has granted this client nothing.
 */
export async function getGrantedScope(
  userId: number,
  clientId: string,
  now: Date = new Date()
): Promise<number | null> {
  const [consent, refresh] = await Promise.all([
    db
      .selectFrom('OauthConsent')
      .select(['scope'])
      .where('userId', '=', userId)
      .where('clientId', '=', clientId)
      .executeTakeFirst(),
    db
      .selectFrom('ApiKey')
      .select((eb) => eb.fn<number | null>('bit_or', ['tokenScope']).as('scope'))
      .where('userId', '=', userId)
      .where('clientId', '=', clientId)
      .where('type', '=', 'Refresh')
      .where((eb) => eb.or([eb('expiresAt', '>=', now), eb('expiresAt', 'is', null)]))
      .executeTakeFirst(),
  ]);

  const refreshScope = refresh?.scope ?? null;
  if (!consent && refreshScope == null) return null;
  return (consent?.scope ?? 0) | (refreshScope ?? 0);
}
