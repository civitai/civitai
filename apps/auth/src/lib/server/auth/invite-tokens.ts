import { createHash, randomBytes } from 'crypto';
import { env } from '$env/dynamic/private';
import { logAxiomError } from '../axiom';
import { db } from '../db/db';

// Single use, unlike the magic link: spent on the accept page's POST, never its GET, since mail scanners
// prefetch links.

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const hashToken = (raw: string) =>
  createHash('sha256')
    .update(`invite:${raw}${env.NEXTAUTH_SECRET ?? ''}`)
    .digest('hex');

export type Invite = { clientId: string; email: string; returnUrl: string };

/**
 * Issues an invite and hands its raw token to `deliver`. Only once delivery succeeds does it replace the
 * earlier link for the same client, returnUrl and address (in any letter case), so a failed resend leaves
 * the earlier link working; if delivery throws, the new token is removed and the error rethrown.
 */
export async function issueInvite(
  invite: Invite,
  deliver: (token: string) => Promise<void>
): Promise<{ expiresAt: Date }> {
  const raw = randomBytes(32).toString('hex');
  const tokenHash = hashToken(raw);
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + INVITE_TTL_MS);
  await db
    .insertInto('OauthInvite')
    .values({ tokenHash, ...invite, expiresAt, createdAt })
    .execute();
  try {
    await deliver(raw);
  } catch (e) {
    await db.deleteFrom('OauthInvite').where('tokenHash', '=', tokenHash).execute();
    throw e;
  }
  // Only links older than this one are replaced, so of two overlapping sends the newer link survives rather
  // than each deleting the other. The email is already out, so a failure here is logged, not raised.
  try {
    await db
      .deleteFrom('OauthInvite')
      .where('tokenHash', '!=', tokenHash)
      .where((eb) =>
        eb.or([
          eb('expiresAt', '<=', new Date()),
          eb.and([
            eb('clientId', '=', invite.clientId),
            eb(eb.fn('lower', ['email']), '=', invite.email.toLowerCase()),
            eb('returnUrl', '=', invite.returnUrl),
            // Older, or created in the same millisecond with a smaller hash: exactly one of a tied pair goes.
            eb.or([
              eb('createdAt', '<', createdAt),
              eb.and([eb('createdAt', '=', createdAt), eb('tokenHash', '<', tokenHash)]),
            ]),
          ]),
        ])
      )
      .execute();
  } catch (e) {
    void logAxiomError(e, { event: 'invite cleanup failed', clientId: invite.clientId });
  }
  return { expiresAt };
}

/** The live invite for a token, without spending it. */
export async function findInvite(raw: string): Promise<Invite | null> {
  const row = await db
    .selectFrom('OauthInvite')
    .select(['clientId', 'email', 'returnUrl'])
    .where('tokenHash', '=', hashToken(raw))
    .where('expiresAt', '>', new Date())
    .executeTakeFirst();
  return row ?? null;
}

/** Spend an invite token: the invite it was issued for, or null if it is unknown, used or expired. */
export async function consumeInviteToken(raw: string): Promise<Invite | null> {
  // Expiry is compared in SQL so it doesn't depend on how the driver parses a timestamp without time zone.
  // Expired rows are left for issueInvite to prune.
  const row = await db
    .deleteFrom('OauthInvite')
    .where('tokenHash', '=', hashToken(raw))
    .where('expiresAt', '>', new Date())
    .returning(['clientId', 'email', 'returnUrl'])
    .executeTakeFirst();
  return row ?? null;
}
