import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NormalizedProfile } from '../providers';

// findOrCreateUser records the scope a provider actually GRANTED on the Account (e.g. Discord's
// role_connections.write for the linked-roles flow). We drive it with a fake kysely `db` and assert WHERE the
// scope lands across the three provisioning paths (returning / link-by-email / create), plus the no-wipe rule.
// `./session`'s toSessionUser is stubbed (the read-back shape is irrelevant to scope math).
const h = vi.hoisted(() => ({
  linkedUserId: undefined as number | undefined, // step 1: Account already linked → this userId
  existingUserByEmail: undefined as number | undefined, // step 2: User matched by verified email
  createdUserId: 5, // id returned when a fresh User is inserted
  scopeUpdates: [] as Array<string | null | undefined>, // setAccountScope → updateTable('Account').set({ scope })
  accountInserts: [] as Array<{ scope?: string | null }>, // insertInto('Account').values({ ... })
  userCreated: false, // insertInto('User') ran → distinguishes create vs link
}));

vi.mock('../session', () => ({
  toSessionUser: (row: { id: number; username: string | null }) => ({
    id: row.id,
    username: row.username ?? undefined,
  }),
}));

vi.mock('../../db/db', () => {
  const db = {
    selectFrom: (_table: string) => ({
      select: () => ({
        where: () => ({
          // 2-where chain = the Account "already linked?" probe (provider + providerAccountId)
          where: () => ({
            executeTakeFirst: async () =>
              h.linkedUserId != null ? { userId: h.linkedUserId } : undefined,
          }),
          // 1-where chain = the User "match by verified email" probe
          executeTakeFirst: async () =>
            h.existingUserByEmail != null ? { id: h.existingUserByEmail } : undefined,
        }),
      }),
      selectAll: () => ({
        where: () => ({
          executeTakeFirstOrThrow: async () => ({ id: h.createdUserId, username: null }),
        }),
      }),
    }),
    insertInto: (table: string) => ({
      values: (vals: { scope?: string | null }) => ({
        // insertInto('User') — fresh user
        returning: () => ({
          executeTakeFirstOrThrow: async () => {
            h.userCreated = true;
            return { id: h.createdUserId };
          },
        }),
        // insertInto('Account') — link / create path
        execute: async () => {
          if (table === 'Account') h.accountInserts.push(vals);
        },
      }),
    }),
    updateTable: (table: string) => ({
      set: (vals: { scope?: string | null; username?: string }) => ({
        where: () => ({
          // 2-where chain = setAccountScope (provider + providerAccountId)
          where: () => ({
            execute: async () => {
              if (table === 'Account') h.scopeUpdates.push(vals.scope);
            },
          }),
          // 1-where chain = assignUsername write (id) — succeed silently
          execute: async () => {},
        }),
      }),
    }),
  };
  return { db };
});

import { findOrCreateUser } from '../users';

const profile = (overrides: Partial<NormalizedProfile> = {}): NormalizedProfile => ({
  providerAccountId: 'discord-abc',
  email: 'mod@example.com',
  emailVerified: true,
  name: 'Mod',
  ...overrides,
});

const DISCORD_SCOPE = 'identify email role_connections.write';

beforeEach(() => {
  h.linkedUserId = undefined;
  h.existingUserByEmail = undefined;
  h.createdUserId = 5;
  h.scopeUpdates = [];
  h.accountInserts = [];
  h.userCreated = false;
});

describe('findOrCreateUser — granted-scope storage', () => {
  it('stores the granted scope on the Account when CREATING a new user', async () => {
    // no linked account, no email match → fresh user + account
    const user = await findOrCreateUser('discord', profile({ emailVerified: false }), DISCORD_SCOPE);
    expect(user.id).toBe(5);
    expect(h.userCreated).toBe(true);
    expect(h.accountInserts).toHaveLength(1);
    expect(h.accountInserts[0].scope).toBe(DISCORD_SCOPE);
    expect(h.scopeUpdates).toHaveLength(0); // no update path on create
  });

  it('updates the stored scope when a RETURNING user re-grants it (e.g. Discord linked-roles)', async () => {
    h.linkedUserId = 5;
    await findOrCreateUser('discord', profile(), DISCORD_SCOPE);
    expect(h.scopeUpdates).toEqual([DISCORD_SCOPE]);
    expect(h.accountInserts).toHaveLength(0); // returning user → no new account
    expect(h.userCreated).toBe(false);
  });

  it('NEVER wipes a stored scope when the token response carries no scope (null)', async () => {
    h.linkedUserId = 5;
    await findOrCreateUser('discord', profile(), null);
    expect(h.scopeUpdates).toHaveLength(0); // setAccountScope no-ops on null
  });

  it('stores the scope on the Account when LINKING to an existing verified-email user', async () => {
    h.existingUserByEmail = 5; // email matches an existing user
    await findOrCreateUser('google', profile({ providerAccountId: 'google-xyz' }), 'openid email profile');
    expect(h.userCreated).toBe(false); // linked, not created
    expect(h.accountInserts).toHaveLength(1);
    expect(h.accountInserts[0].scope).toBe('openid email profile');
    expect(h.scopeUpdates).toHaveLength(0);
  });

  it('does NOT link on an UNVERIFIED email — creates a fresh user instead', async () => {
    h.existingUserByEmail = 5; // a user with this email exists...
    await findOrCreateUser('discord', profile({ emailVerified: false }), DISCORD_SCOPE);
    // ...but the email isn't verified, so step 2 is skipped and a new user is created (no takeover)
    expect(h.userCreated).toBe(true);
    expect(h.accountInserts[0].scope).toBe(DISCORD_SCOPE);
  });
});
