import { createHash } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { DB as MainDB } from '@civitai/db-schema/kysely';

// The one definition of a Model rules run's rule state: starting a run records this hash and the
// worker compares against it, so both must come from here.
export type RuleStateEntry = { id: number; versionId: number | null; enabled: boolean };

export const canonicalRuleState = (state: readonly RuleStateEntry[]) =>
  JSON.stringify([...state].sort((a, b) => a.id - b.id).map((r) => [r.id, r.versionId, r.enabled]));

export const ruleStateHash = (state: readonly RuleStateEntry[]) =>
  createHash('sha256').update(canonicalRuleState(state)).digest('hex');

/** Pass the primary: a run started just after a rule save must see that save. */
export async function liveModelRuleState(main: Kysely<MainDB>): Promise<RuleStateEntry[]> {
  const rows = await main
    .selectFrom('ModerationRule as r')
    .select((eb) => [
      'r.id',
      'r.enabled',
      eb
        .selectFrom('ModerationRuleVersion as v')
        .whereRef('v.ruleId', '=', 'r.id')
        .select((v) => v.fn.max('v.id').as('maxId'))
        .as('versionId'),
    ])
    .where('r.entityType', '=', 'Model')
    .orderBy('r.id')
    .execute();
  return rows.map((r) => ({ id: r.id, versionId: r.versionId ?? null, enabled: r.enabled }));
}

export const liveRuleStateHash = async (main: Kysely<MainDB>) =>
  ruleStateHash(await liveModelRuleState(main));
