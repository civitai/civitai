/**
 * The rulings a moderator can record on a `/decisions` item, and the sources an item can come from.
 *
 * 🔴 IN `$lib`, NOT `$lib/server`, FOR THE REASON `abuse-verdicts.ts` GIVES: the buttons that render
 * these are client code, and SvelteKit will not bundle `$lib/server` into it. One tuple, imported by
 * the page, the form action and — through `decision-resolution.schema.test.ts` — checked against the
 * CHECK constraints in `apps/moderator/decisions/schema.sql`, in both directions. A second copy is how
 * a button appears that the database then refuses.
 *
 * 🔴 EVERY VALUE BELOW IS STORED. Renaming one orphans the rows already written with it (they stop
 * matching every read that filters on the new spelling) and needs a hand-applied migration.
 */

/** `source` column values. Widened per source, together with the DDL's CHECK. */
export const DECISION_SOURCES = ['support-ticket'] as const;
export type DecisionSource = (typeof DECISION_SOURCES)[number];

/**
 * Rulings on a WHOLE item (support: one issue group). Order is the order the panel offers them.
 *
 * `skip` is a decision ("I looked and I am not calling it"), not an absence — an item with no row at
 * all is what "unruled" means.
 *
 * `resolved` records the group's canonical answer, and implies the grouping is correct. It replaces
 * any earlier group ruling like every other, so withdrawing an answer is a newer ruling (normally
 * `correct`) — the table stays append-only.
 */
export const GROUP_RULINGS = [
  'correct',
  'split',
  'duplicate_of',
  'park',
  'escalate',
  'skip',
  'resolved',
] as const;
export type GroupRuling = (typeof GROUP_RULINGS)[number];

/** Labels on ONE member of an item (support: one ticket's membership of its group). */
export const MEMBER_RULINGS = ['belongs', 'not_belongs', 'unsure'] as const;
export type MemberRuling = (typeof MEMBER_RULINGS)[number];

export const DECISION_RULINGS = [...GROUP_RULINGS, ...MEMBER_RULINGS] as const;
export type DecisionRuling = (typeof DECISION_RULINGS)[number];

/**
 * Rulings that ask the SOURCE to change something. v1 only records them: the source stays the only
 * writer to its own data, and applying a ruling is that source's job. They are written
 * `apply_state = 'pending'`; every other ruling is a label and is written `'n/a'`.
 */
export const PENDING_RULINGS = ['duplicate_of', 'park'] as const satisfies readonly GroupRuling[];

export const APPLY_STATES = ['n/a', 'pending', 'applied', 'rejected'] as const;
export type ApplyState = (typeof APPLY_STATES)[number];

const includes = (set: readonly string[], value: unknown): boolean =>
  typeof value === 'string' && set.includes(value);

export const isGroupRuling = (value: unknown): value is GroupRuling =>
  includes(GROUP_RULINGS, value);
export const isMemberRuling = (value: unknown): value is MemberRuling =>
  includes(MEMBER_RULINGS, value);

/** The `apply_state` a NEW ruling is written with. The DDL enforces the same relation. */
export const initialApplyState = (ruling: DecisionRuling): ApplyState =>
  includes(PENDING_RULINGS, ruling) ? 'pending' : 'n/a';

export const GROUP_RULING_LABEL: Record<GroupRuling, string> = {
  correct: 'Correct grouping',
  split: 'Wrong — should be split',
  duplicate_of: 'Duplicate of another group',
  park: 'Park (no longer active)',
  escalate: 'Escalate to a human',
  skip: 'Skip — looked, not calling it',
  resolved: 'Resolved — record the answer',
};

export const MEMBER_RULING_LABEL: Record<MemberRuling, string> = {
  belongs: 'Belongs',
  not_belongs: 'Does not belong',
  unsure: 'Unsure',
};

/** The same, as the compact buttons on a member row show them — under a "Fits the definition?"
 *  heading. Their accessible name leads with this word and carries the full label. */
export const MEMBER_RULING_SHORT_LABEL: Record<MemberRuling, string> = {
  belongs: 'Yes',
  not_belongs: 'No',
  unsure: 'Unsure',
};

/** The inbox's per-item state, derived from the latest group ruling. */
export const ITEM_STATES = ['unruled', 'ruled', 'escalated', 'resolved'] as const;
export type ItemState = (typeof ITEM_STATES)[number];

export const itemState = (latest: GroupRuling | null): ItemState =>
  latest === null
    ? 'unruled'
    : latest === 'escalate'
    ? 'escalated'
    : latest === 'resolved'
    ? 'resolved'
    : 'ruled';

/** The longest answer accepted. The DDL's `decision_resolution_answer_valid` enforces the same bound. */
export const ANSWER_MAX_LENGTH = 8000;
