import { randomBytes, randomInt } from 'crypto';
import type { SessionUser } from '@civitai/auth';
import { db } from '../db/db';
import { toSessionUser } from './session';
import type { NormalizedProfile } from './providers';

// Username assignment — mirrors the main app's NextAuth `events.createUser` / `setUserName`
// (next-auth-options.ts): sanitize a seed (email/name), suffix a random 3-digit int, and retry
// on the unique-constraint collision. New users MUST get a username — a null one breaks main-app
// invariants (profile routes, etc.). We assign it after insert (rather than inserting a raw
// provider username, which can collide and 500 the insert).
const sanitizeSeed = (s: string) => s.split('@')[0].replace(/[^A-Za-z0-9_]/g, '');

const randomSeed = (len: number) =>
  randomBytes(len * 2)
    .toString('base64')
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, len);

async function assignUsername(
  userId: number | undefined,
  seeds: Array<string | null | undefined>
): Promise<void> {
  if (userId == null) return;
  const candidates = seeds
    .map((s) => (s ? sanitizeSeed(s.trim()) : ''))
    .filter((s) => s.length > 0);
  candidates.push(`${randomSeed(5)}_`); // always-available fallback, like generateToken(5) + '_'

  for (const base of candidates) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const username = `${base}${randomInt(100, 1000)}`;
      try {
        await db.updateTable('User').set({ username }).where('id', '=', userId).execute();
        return;
      } catch {
        // unique-constraint collision — retry with a fresh suffix (then the next seed)
      }
    }
  }
  // Extremely unlikely (the random fallback collided 2×); leave username unset rather than throw.
}

// Resolve (or provision) a Civitai user for an upstream OAuth profile, then link the Account.
// Mirrors NextAuth's adapter behavior: match by linked account → verified email → create.
export async function findOrCreateUser(
  provider: string,
  profile: NormalizedProfile
): Promise<SessionUser> {
  // 1. Already-linked account.
  const linked = await db
    .selectFrom('Account')
    .select('userId')
    .where('provider', '=', provider)
    .where('providerAccountId', '=', profile.providerAccountId)
    .executeTakeFirst();

  let userId = linked?.userId;

  // 2. Otherwise link to an existing user by email — but ONLY if the provider VERIFIED it. This is
  //    the safe analogue of the main app's `allowDangerousEmailAccountLinking` (Google/GitHub):
  //    those providers verify emails, so a 2nd-provider login on the same verified address links to
  //    the existing user (no duplicate) — but we deliberately DON'T link on an UNverified email,
  //    which would be an account-takeover vector. (GitHub private emails are recovered + marked
  //    verified in fetchProfile, so this path covers them too.)
  if (!userId && profile.email && profile.emailVerified) {
    const existing = await db
      .selectFrom('User')
      .select('id')
      .where('email', '=', profile.email)
      .executeTakeFirst();
    if (existing) {
      userId = existing.id;
      await db
        .insertInto('Account')
        .values({
          userId,
          type: 'oauth',
          provider,
          providerAccountId: profile.providerAccountId,
        })
        .execute();
    }
  }

  // 3. Otherwise create a fresh user + account. Omitted NOT-NULL columns use their DB defaults.
  // username is assigned post-insert (see assignUsername) — never the raw provider handle.
  if (!userId) {
    const created = await db
      .insertInto('User')
      .values({
        email: profile.email ?? null,
        username: null,
        name: profile.name ?? null,
        image: profile.image ?? null,
        emailVerified: profile.email && profile.emailVerified ? new Date() : null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    userId = created.id;
    await db
      .insertInto('Account')
      .values({ userId, type: 'oauth', provider, providerAccountId: profile.providerAccountId })
      .execute();
    await assignUsername(userId, [profile.email, profile.name, profile.username]);
  }

  // Read back via db — read-your-writes (the user may have just been created on primary).
  const row = await db
    .selectFrom('User')
    .selectAll()
    .where('id', '=', userId)
    .executeTakeFirstOrThrow();

  return toSessionUser(row);
}

// Email magic-link sign-in: clicking the verified link proves email ownership, so the user is
// created (or matched) with emailVerified set.
export async function findOrCreateUserByEmail(email: string): Promise<SessionUser> {
  const existing = await db
    .selectFrom('User')
    .select('id')
    .where('email', '=', email)
    .executeTakeFirst();

  let userId = existing?.id;
  if (!userId) {
    const created = await db
      .insertInto('User')
      .values({ email, emailVerified: new Date() })
      .returning('id')
      .executeTakeFirstOrThrow();
    userId = created.id;
    await assignUsername(userId, [email]);
  } else {
    // Mark verified if it wasn't already.
    await db
      .updateTable('User')
      .set({ emailVerified: new Date() })
      .where('id', '=', userId)
      .where('emailVerified', 'is', null)
      .execute();
  }

  const row = await db
    .selectFrom('User')
    .selectAll()
    .where('id', '=', userId)
    .executeTakeFirstOrThrow();

  return toSessionUser(row);
}
