import type { SessionUser } from '@civitai/auth';
import { db } from '../db/db';
import { toSessionUser } from './session';
import type { NormalizedProfile } from './providers';

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

  // 2. Otherwise link to an existing user by email (only if the provider verified it).
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
  if (!userId) {
    const created = await db
      .insertInto('User')
      .values({
        email: profile.email ?? null,
        username: profile.username ?? null,
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
