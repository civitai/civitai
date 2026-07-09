import { createHash, randomBytes } from 'crypto';
import { env } from '$env/dynamic/private';
import { db } from '../db/db';

// Magic-link verification tokens, stored in the shared VerificationToken table (the same table
// NextAuth's EmailProvider uses). The raw token goes in the emailed link; only its hash is
// persisted, so a DB leak can't be used to forge a sign-in.

const TTL_MS = 24 * 60 * 60 * 1000; // 24h, matches NextAuth's EmailProvider default

const hashToken = (raw: string) =>
  createHash('sha256')
    .update(`${raw}${env.NEXTAUTH_SECRET ?? ''}`)
    .digest('hex');

/** Issue a token for `email`; returns the raw token to embed in the link. */
export async function createVerificationToken(email: string): Promise<string> {
  const raw = randomBytes(32).toString('hex');
  await db
    .insertInto('VerificationToken')
    .values({ identifier: email, token: hashToken(raw), expires: new Date(Date.now() + TTL_MS) })
    .execute();
  return raw;
}

/**
 * Validate a magic-link token. Intentionally NOT consumed on use: email scanners (Outlook ATP, Proofpoint)
 * prefetch links and would otherwise burn a single-use token before the real click. The token stays valid for
 * its TTL (replay bounded by it); expired rows are pruned on access. Matches the legacy NextAuth adapter.
 */
export async function consumeVerificationToken(email: string, raw: string): Promise<boolean> {
  const token = hashToken(raw);
  const row = await db
    .selectFrom('VerificationToken')
    .select('expires')
    .where('identifier', '=', email)
    .where('token', '=', token)
    .executeTakeFirst();

  if (!row) return false;
  if (new Date(row.expires).getTime() <= Date.now()) {
    await db.deleteFrom('VerificationToken').where('token', '=', token).execute(); // expired → clean up + reject
    return false;
  }
  return true;
}
