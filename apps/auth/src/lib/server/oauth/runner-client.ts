import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { TokenScope } from '@civitai/auth/token-scope';
import { readRunnerBindingStatus } from '@civitai/db-queries/recipe-runner';
import { db } from '$lib/server/db/db';
import { DEVICE_CODE_GRANT, SYSTEM_USER_ID } from './constants';
import { carriesRunnerOnlyScope } from './scope';

/** A recipe runner's token: the mint, plus the UserRead every OAuth token carries. Nothing else. */
export const RUNNER_TOKEN_SCOPE = TokenScope.RunnerMint | TokenScope.UserRead;

type RunnerClient = {
  userId: number;
  isConfidential: boolean;
  skipConsent: boolean;
  grants: string[];
  accessMode: string;
};

/**
 * Civitai-owned, confidential, consented, open, and no device flow. `grants` stores the URN; the
 * bare name is refused too, so a hand-written row cannot slip past.
 */
export function isRunnerClient(client: RunnerClient | undefined): boolean {
  return (
    client != null &&
    client.userId === SYSTEM_USER_ID &&
    client.isConfidential === true &&
    client.skipConsent === false &&
    client.accessMode === 'open' &&
    !client.grants.includes(DEVICE_CODE_GRANT) &&
    !client.grants.includes('device_code')
  );
}

/**
 * Whether `clientId` is a recipe runner: runner-shaped (`isRunnerClient`) and bound to an app block.
 * `active` may hold runner tokens; `suspended` is still a runner, and holds nothing more than
 * UserRead. Null: an ordinary client, whatever its shape.
 */
export async function readRunnerAdmission(
  clientId: string
): Promise<'active' | 'suspended' | null> {
  const client = await db
    .selectFrom('OauthClient')
    .select(['userId', 'isConfidential', 'skipConsent', 'grants', 'accessMode'])
    .where('id', '=', clientId)
    .executeTakeFirst();
  if (!isRunnerClient(client)) return null;
  const status = await readRunnerBindingStatus(db as unknown as Kysely<DB>, clientId);
  if (status === null) return null;
  return status === 'active' ? 'active' : 'suspended';
}

/** Whether a library scope string (one decimal bitmask) carries a runner-only bit. */
export function scopeStringCarriesRunner(scope: string | string[] | undefined): boolean {
  const str = Array.isArray(scope) ? scope[0] : scope;
  return str != null && /^\d+$/.test(str) && carriesRunnerOnlyScope(BigInt(str));
}
