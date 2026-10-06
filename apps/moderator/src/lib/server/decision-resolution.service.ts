import type { Kysely } from 'kysely';
import { getModeratorDb } from './moderator-db';
import type { DecisionResolutionTables } from './decision-resolution-tables';
import {
  initialApplyState,
  isGroupRuling,
  isMemberRuling,
  type ApplyState,
  type DecisionRuling,
  type DecisionSource,
  type GroupRuling,
  type MemberRuling,
} from '../decision-rulings';
import { moderatorDbStatus } from '../moderator-db-status';

/**
 * Human rulings on `/decisions` items — the app's own record, and the labelled data they produce.
 *
 * 🔴 THE ONLY WRITE PATH FOR A RULING, AND IT NEVER TOUCHES THE SOURCE. A ruling that asks the source
 * to change something (`duplicate_of`, `park`) is stored `apply_state = 'pending'` and stops there.
 */

type ResolutionDb = Kysely<DecisionResolutionTables>;

// The cast narrows the shared client to the one table this module touches. It is a SUBSET of the
// client's real type, and it is what lets the pglite tests hand in a client over this table alone.
const defaultDb = (): ResolutionDb =>
  getModeratorDb().withTables<DecisionResolutionTables>() as unknown as ResolutionDb;

export const SCHEMA_FILE = 'apps/moderator/decisions/schema.sql';

export type Resolution = {
  id: string;
  itemKey: string;
  subKey: string;
  ruling: DecisionRuling;
  targetKey: string | null;
  escalateTo: string | null;
  note: string | null;
  ruledBy: number;
  ruledAt: Date;
  applyState: ApplyState;
};

/**
 * The CURRENT ruling per (item, sub-item) — the latest row of each, since the table is append-only.
 *
 * 🔴 `id` BREAKS A `ruled_at` TIE. Two rulings in one transaction share `now()`, and without a
 * tie-breaker `DISTINCT ON` keeps an arbitrary one of them.
 */
export async function currentResolutions(
  input: { source: DecisionSource; sourceVersion: string; itemKeys: readonly string[] },
  db: ResolutionDb = defaultDb()
): Promise<Resolution[]> {
  if (input.itemKeys.length === 0) return [];
  const rows = await db
    .selectFrom('decision_resolution')
    .distinctOn(['item_key', 'sub_key'])
    .select([
      'id',
      'item_key',
      'sub_key',
      'ruling',
      'target_key',
      'escalate_to',
      'note',
      'ruled_by',
      'ruled_at',
      'apply_state',
    ])
    .where('source', '=', input.source)
    .where('source_version', '=', input.sourceVersion)
    .where('item_key', 'in', [...input.itemKeys])
    .orderBy('item_key')
    .orderBy('sub_key')
    .orderBy('ruled_at', 'desc')
    .orderBy('id', 'desc')
    .execute();
  return rows.map((r) => ({
    id: String(r.id),
    itemKey: r.item_key,
    subKey: r.sub_key,
    ruling: r.ruling,
    targetKey: r.target_key,
    escalateTo: r.escalate_to,
    note: r.note,
    ruledBy: r.ruled_by,
    ruledAt: new Date(r.ruled_at as unknown as string | Date),
    applyState: r.apply_state,
  }));
}

export type GroupRulingSummary = {
  ruling: GroupRuling;
  ruledBy: number;
  ruledAt: Date;
  targetKey: string | null;
};
export type MemberLabelSummary = { ruling: MemberRuling; ruledBy: number; ruledAt: Date };

/**
 * Split current resolutions into the ruling on each WHOLE item and the labels on its members.
 *
 * 🔴 THE ONE PLACE `sub_key = ''` IS READ AS "THE WHOLE ITEM". The inbox and the detail page both need
 * this split; two copies of a stored-value convention disagree the first time one is edited, and then
 * the inbox and the item page differ on whether an item is ruled. The DDL's scope CHECK pairs the
 * convention with the ruling kind; the guards here narrow the type to match.
 */
export function partitionResolutions(resolutions: readonly Resolution[]): {
  groups: Map<string, GroupRulingSummary>;
  members: Map<string, Record<string, MemberLabelSummary>>;
} {
  const groups = new Map<string, GroupRulingSummary>();
  const members = new Map<string, Record<string, MemberLabelSummary>>();
  for (const r of resolutions) {
    if (r.subKey === '' && isGroupRuling(r.ruling))
      groups.set(r.itemKey, {
        ruling: r.ruling,
        ruledBy: r.ruledBy,
        ruledAt: r.ruledAt,
        targetKey: r.targetKey,
      });
    else if (r.subKey !== '' && isMemberRuling(r.ruling)) {
      const labels = members.get(r.itemKey) ?? {};
      labels[r.subKey] = { ruling: r.ruling, ruledBy: r.ruledBy, ruledAt: r.ruledAt };
      members.set(r.itemKey, labels);
    }
  }
  return { groups, members };
}

export type NewResolution = {
  source: DecisionSource;
  itemKey: string;
  /** '' for a ruling on the whole item. */
  subKey: string;
  sourceVersion: string;
  area: string | null;
  ruling: DecisionRuling;
  targetKey: string | null;
  escalateTo: string | null;
  note: string | null;
  ruledBy: number;
  /** What the source said about the item when the ruling was made. */
  shown: Record<string, unknown>;
};

/**
 * Append one ruling. Returns how many rows were written — the caller treats 0 as a failure.
 *
 * 🔴 A WRITE DOES NOT DEGRADE. Accepting a ruling the database never stored is worse than refusing
 * it, so a missing table or wrong-role table is rethrown as a message naming the file to apply.
 */
export async function recordResolution(
  input: NewResolution,
  db: ResolutionDb = defaultDb()
): Promise<{ inserted: number; id: string | null }> {
  try {
    const row = await db
      .insertInto('decision_resolution')
      .values({
        source: input.source,
        item_key: input.itemKey,
        sub_key: input.subKey,
        source_version: input.sourceVersion,
        area: input.area,
        ruling: input.ruling,
        target_key: input.targetKey,
        escalate_to: input.escalateTo,
        note: input.note,
        ruled_by: input.ruledBy,
        apply_state: initialApplyState(input.ruling),
        shown: JSON.stringify(input.shown),
      })
      .returning('id')
      .executeTakeFirst();
    return row ? { inserted: 1, id: String(row.id) } : { inserted: 0, id: null };
  } catch (e) {
    const status = moderatorDbStatus(e);
    if (status === 'no-schema')
      throw new Error(`decision_resolution does not exist — apply ${SCHEMA_FILE}`, { cause: e });
    if (status === 'no-grant')
      throw new Error(
        `this role cannot write decision_resolution — re-run ${SCHEMA_FILE} as the application ` +
          'role, or transfer ownership to it (see the file header)',
        { cause: e }
      );
    throw e;
  }
}
