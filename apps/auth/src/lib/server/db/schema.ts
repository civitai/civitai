import type { ColumnType, Generated } from 'kysely';

// Hand-written Kysely table types for ONLY the tables the login hub touches. The end state
// is to generate the full `DB` from @civitai/db-schema via prisma-kysely (as civitai-advertising
// does — `generator kysely { provider = "prisma-kysely" }`), then import `DB` from there and
// delete this file. Kept narrow on purpose so the scaffold compiles without running codegen.

type Json<T> = ColumnType<T, string, string>;

export interface UserTable {
  id: Generated<number>;
  name: string | null;
  username: string | null;
  email: string | null;
  emailVerified: Date | null;
  image: string | null;
  showNsfw: Generated<boolean>;
  blurNsfw: Generated<boolean>;
  browsingLevel: Generated<number>;
  onboarding: Generated<number>;
  flags: Generated<number>;
  isModerator: boolean | null;
  createdAt: Generated<Date>;
  deletedAt: Date | null;
  mutedAt: Date | null;
  muted: Generated<boolean>;
  bannedAt: Date | null;
  customerId: string | null;
  paddleCustomerId: string | null;
  meta: Json<Record<string, unknown>> | null;
  settings: Json<Record<string, unknown>> | null;
}

export interface AccountTable {
  id: Generated<number>;
  userId: number;
  type: string;
  provider: string;
  providerAccountId: string;
  refresh_token: string | null;
  access_token: string | null;
  expires_at: number | null;
  token_type: string | null;
  scope: string | null;
  id_token: string | null;
  session_state: string | null;
  metadata: Generated<Json<Record<string, unknown>>>;
}

export interface VerificationTokenTable {
  identifier: string;
  token: string;
  expires: Date;
}

export interface DB {
  User: UserTable;
  Account: AccountTable;
  VerificationToken: VerificationTokenTable;
}
