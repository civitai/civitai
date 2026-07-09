/**
 * Generation gating — rules model.
 *
 * A `GateRule` is ONE named gate — *who* it applies to (`audience`) and *how* a
 * gated item is presented (`presentation`) — with any number of targets
 * (ecosystems / workflows / model-version IDs) attached. It replaces the sparse
 * matrix of per-(target × state) lists with a single normalized shape a mod can
 * author by hand.
 *
 * Two halves, split by where they run:
 *   - `applicableRulesFor(rules, user)` — SERVER side. Filters the stored rules
 *     down to the ones whose audience includes this user (the only per-user
 *     evaluation). The result rides to the client + into `GenerationCtx`, so the
 *     audience logic never leaves the server.
 *   - `rulesToStates(rules)` — runs in the GRAPH (client + server), on the
 *     already-applicable rules. No user needed: it just folds each rule's
 *     presentation/audience into one effective `GateState` per target.
 *
 * Rules coexist with the legacy `generation:ecosystem-config` lists + the
 * self-hosted toggle — the graph nodes merge all sources into one state map via
 * `pickStrongerGate`. See `docs/features/generation-gating-rules-model.md`.
 */

import { z } from 'zod';

// WHO keeps access — everyone else is gated. Positive ("available to") framing,
// matching the legacy allow-list model ("testers have it; others hidden"):
//   - `moderators` → mod-only.
//   - `testers`    → testers + mods (mods always have testing access).
//   - `members`    → members + mods.
//   - `nobody`     → kill-switch, gated for all (mods included).
export const gateAvailableToSchema = z.enum(['moderators', 'testers', 'members', 'nobody']);
export type GateAvailableTo = z.infer<typeof gateAvailableToSchema>;

// HOW a gated item is presented to a gated user. `disabled` is always SHOWN
// (greyed, not selectable, with messaging); `hidden` is always removed.
export const gatePresentationSchema = z.enum(['disabled', 'hidden']);
export type GatePresentation = z.infer<typeof gatePresentationSchema>;

export const gateRuleSchema = z.object({
  id: z.string(),
  /** Mod-facing name, e.g. "Maintenance window", "Premium tier". */
  name: z.string().default(''),
  availableTo: gateAvailableToSchema,
  presentation: gatePresentationSchema,
  /**
   * OPTIONAL extra copy layered on top of the state's standard UI — it never
   * replaces the badge/alert/CTA, only adds context.
   */
  message: z.string().nullish(),
  // attach any number of targets:
  ecosystems: z.array(z.string()).default([]),
  workflows: z.array(z.string()).default([]),
  modelVersionIds: z.array(z.number().int().positive()).default([]),
});
export type GateRule = z.infer<typeof gateRuleSchema>;

export type GateUserCtx = {
  isModerator: boolean;
  isMember: boolean;
  hasTestingAccess: boolean;
};

/** Whether a rule GATES this user (i.e. they're outside its `availableTo` tier). */
const isGatedFor: Record<GateAvailableTo, (u: GateUserCtx) => boolean> = {
  moderators: (u) => !u.isModerator,
  testers: (u) => !u.hasTestingAccess, // mods always have testing access
  members: (u) => !u.isMember && !u.isModerator, // mods + members keep access
  nobody: () => true, // kill-switch, gated for all
};

/**
 * SERVER: narrow the stored rules to those that gate this user. The `availableTo`
 * tier is the only per-user evaluation, so the granular logic stays on the
 * server and the client/graph receive a ready-to-apply list.
 */
export function applicableRulesFor(rules: GateRule[], user: GateUserCtx): GateRule[] {
  return rules.filter((r) => isGatedFor[r.availableTo](user));
}

/**
 * The effective gate on one item — one of THREE states the client renders.
 * `memberOnly` is its own state, not a flavor of `disabled`: it's only off for
 * non-members (with an upsell), whereas `disabled` is off for the whole gated
 * audience.
 *   - `hidden`     → removed from the picker.
 *   - `disabled`   → shown greyed, the standard "currently unavailable" UI.
 *   - `memberOnly` → shown greyed, the standard members-only UI **including the
 *                    upsell alert + Become-a-member CTA** (same as the existing
 *                    self-hosted memberOnly experience).
 * The state's standard messaging ALWAYS renders. A rule's `message` is OPTIONAL
 * extra copy layered on top — it never replaces the badge/alert/CTA.
 */
export type GateState = 'hidden' | 'disabled' | 'memberOnly';
export type GateResolution = { state: GateState; message?: string };

/**
 * A picker-facing shown-but-disabled entry (hidden items are removed from the
 * list upstream, so they never carry one). Used by both the ecosystem and
 * workflow pickers to badge an item + drive its tooltip/alert copy.
 */
export type GateItemState = { key: string; state: Exclude<GateState, 'hidden'>; message?: string };

/** Per-target maps of value → its single effective gate for this user. */
export type ResolvedGates = {
  ecosystems: Map<string, GateResolution>;
  workflows: Map<string, GateResolution>;
  modelVersionIds: Map<number, GateResolution>;
};

// Precedence when an item is gated by several sources/rules: the more
// restrictive state wins — hidden (gone) > disabled (off for all) > memberOnly
// (off for non-members) — so we never upsell something that's actually down.
const STATE_RANK: Record<GateState, number> = { hidden: 2, disabled: 1, memberOnly: 0 };

/**
 * The stronger of two resolutions (or `b` if there is no `a`). Exported so the
 * graph nodes can fold the legacy lists + self-hosted toggle into the same
 * per-item state map as the rules.
 */
export function pickStrongerGate(a: GateResolution | undefined, b: GateResolution): GateResolution {
  return !a || STATE_RANK[b.state] > STATE_RANK[a.state] ? b : a;
}

/**
 * Merge a legacy "disabled for everyone" list with the rule-resolved states for
 * one target type into the picker split: `hidden` (remove from the list) vs
 * `states` (shown-but-disabled, badged). Shared by the workflow node + picker so
 * client and server agree. The ecosystem side has its own helper because it
 * also folds the self-hosted toggle + compatible filtering.
 */
export function mergeGateStates(
  legacyDisabled: string[] | undefined,
  ruleStates: Map<string, GateResolution>
): { hidden: string[]; states: GateItemState[] } {
  const map = new Map<string, GateResolution>();
  for (const key of legacyDisabled ?? [])
    map.set(key, pickStrongerGate(map.get(key), { state: 'disabled' }));
  for (const [key, res] of ruleStates) map.set(key, pickStrongerGate(map.get(key), res));
  const hidden = [...map].filter(([, r]) => r.state === 'hidden').map(([key]) => key);
  const states = [...map]
    .filter(([, r]) => r.state !== 'hidden')
    .map(([key, r]) => ({ key, state: r.state as GateItemState['state'], message: r.message }));
  return { hidden, states };
}

// `memberOnly` (upsell) only applies to member-restricted rules — you can become
// a member, but you can't buy your way into testing/mod, so those just disable.
const ruleState = (rule: GateRule): GateState =>
  rule.presentation === 'hidden'
    ? 'hidden'
    : rule.availableTo === 'members'
    ? 'memberOnly'
    : 'disabled';

/**
 * GRAPH: fold already-applicable rules into one effective gate per target.
 * Assumes `rules` is the output of `applicableRulesFor` (no audience re-check).
 */
export function rulesToStates(rules: GateRule[]): ResolvedGates {
  const ecosystems = new Map<string, GateResolution>();
  const workflows = new Map<string, GateResolution>();
  const modelVersionIds = new Map<number, GateResolution>();

  for (const rule of rules) {
    const resolution: GateResolution = {
      state: ruleState(rule),
      message: rule.message ?? undefined,
    };
    for (const e of rule.ecosystems)
      ecosystems.set(e, pickStrongerGate(ecosystems.get(e), resolution));
    for (const w of rule.workflows)
      workflows.set(w, pickStrongerGate(workflows.get(w), resolution));
    for (const id of rule.modelVersionIds)
      modelVersionIds.set(id, pickStrongerGate(modelVersionIds.get(id), resolution));
  }

  return { ecosystems, workflows, modelVersionIds };
}
