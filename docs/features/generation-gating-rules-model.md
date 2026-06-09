# Generation Gating — Rules Model

> Status: **Implemented — the single gating system.** The legacy
> `generation:ecosystem-config` gating matrix (disabled / mod-only / testing
> ecosystems + IDs, `nsfwIds`, `disabledWorkflows`) has been **removed**; all
> gating now lives in one normalized **rules** store (`generation:gate-rules`).
> Each rule names **who keeps access** (`availableTo`) + **how it appears to
> everyone else** (`presentation`) + any mix of ecosystem / workflow /
> modelVersion targets. The self-hosted toggle is kept as its own feature.
>
> Supersedes the "descriptor-form" idea in
> [generation-gating-consolidation.md](./generation-gating-consolidation.md).

## As built

- **Resolver** — [`src/shared/data-graph/generation/gates.ts`](../../src/shared/data-graph/generation/gates.ts):
  `gateRuleSchema` (+ `GateRule` via `z.infer`), `applicableRulesFor` (server,
  `availableTo` filter), `rulesToStates` / `mergeGateStates` / `pickStrongerGate`
  (graph, no user). **Positive "available to" framing** — `moderators` /
  `testers` / `members` / `nobody` (the named tier keeps access, everyone else is
  gated), matching the old "testers enabled, others hidden". 3 resolved states
  `hidden`/`disabled`/`memberOnly`, precedence `hidden > disabled > memberOnly`;
  `memberOnly` (upsell) derives only from `availableTo: members` + `disabled`.
- **Store + API** — `getGateRules`/`setGateRules` (Redis `generation:gate-rules`,
  fail-open `[]`); mod `getGateRules`/`setGateRules` endpoints. `getGenerationConfig`
  returns the user's applicable rules.
- **Graph (generator UI + submit)** — `GenerationCtx.gateRules` (+ `selfHostedMode`),
  populated by both ext builders. The ecosystem + workflow nodes merge the
  self-hosted toggle + rules into one per-item state map; the model node hides
  rule-gated version IDs. Node refines enforce on submit server-side.
- **Site-wide `canGenerate`** — `getResourceCanGenerate` now blocks **only on the
  `hidden` state** (`getCanGenerateHiddenGates`): membership is ignored (no tier
  lookup — `isMember: true` drops member rules), so model pages / search / the
  API hard-block a resource only when a rule hides its ecosystem or version.
  Disabled / members-only remain generator-UI affordances, not a site-wide block.
- **Pickers** — `BaseModelInput` / `WorkflowInput` read one per-item state;
  `FormFooter` resolves the selected ecosystem's state (members-only reuses the
  existing upsell + CTA).
- **Mod UI** — a "Gate rules" rule-card editor on `/moderator/generation-config`.
  The old ecosystem-config form is gone; only an `experimentalEcosystems` alert
  control (not a gate) remains alongside it.

**Kept (not folded into rules):** the self-hosted toggle (`selfHostedMode` +
`SELF_HOSTED_ECOSYSTEM_KEYS`), the `generation-testing` Flipt flag (resolves the
`testers` tier), and `experimentalEcosystems` (an alert flag).

## Why

Gating is a sparse matrix today: `target` (ecosystem / modelVersion / workflow)
× `state` (disabled / modOnly / testing / memberOnly / experimental / nsfw), and
every cell is its own list (`disabledEcosystems`, `modOnlyIds`, …, ~10 lists and
growing). Adding `memberOnly` ecosystems means another list + UI field + resolver
branch. Normalizing to rules makes a new state/target a **registry entry**, and
gives one store + one UI.

Honest scope note: this is primarily an **extensibility / maintainability** win
(a future gate is one registry line; one mod UI instead of N fields). Raw line
count today is roughly neutral — the lists become rules + a registry, not less
code. The payoff is every change _after_ this one.

## Data model

A rule is two independent axes — **who** it gates and **how** the gated item is
presented — over a target value:

```ts
type GateTarget = 'ecosystem' | 'modelVersion' | 'workflow';

// WHO keeps access — everyone else is gated. Positive ("available to") framing:
// the named tier is exempt, everyone else gets the presentation below.
type GateAvailableTo = 'moderators' | 'testers' | 'members' | 'nobody';

// HOW a gated item is presented to a gated user. These are DISTINCT — `disabled`
// is always shown, `hidden` is always removed. The mod chooses per rule.
type GatePresentation =
  | 'disabled' // STILL SHOWN — greyed, not selectable, with a message saying it's
  //              off right now ("currently unavailable" / "members only"). The
  //              feature visibly exists. This is the default for most gating.
  | 'hidden'; //  Removed from the picker. Use only when it shouldn't be
//              advertised at all — because hidden reads as "the feature is gone".

// A rule is ONE gate config (who + how + message) with any number of targets
// attached to it — not one row per item.
type GateRule = {
  id: string; // stable id (for editing)
  name: string; // mod-facing name, e.g. "Maintenance window", "Premium tier"
  availableTo: GateAvailableTo;
  presentation: GatePresentation;
  // OPTIONAL extra copy layered on the state's standard badge/alert (for
  // `members` + `disabled`, the client also renders the Become-a-member CTA).
  message?: string;
  // attach any number of targets:
  ecosystems: string[];
  workflows: string[];
  modelVersionIds: number[];
};
```

Stored in Redis as `GateRule[]` (hash field `generation:gate-rules`). This is now
the **only** gating store — the old `generation:ecosystem-config` gating lists
have been removed. `GateTarget` is just the union of the three attach-lists.

## The two axes (the declarative core)

`presentation` is data on the rule — you pick hide vs show-disabled per rule.
`availableTo` is the only thing that needs evaluating per user (does this rule
GATE the user, i.e. are they outside the exempt tier):

```ts
const isGatedFor: Record<GateAvailableTo, (u: GateUserCtx) => boolean> = {
  moderators: (u) => !u.isModerator,
  testers: (u) => !u.hasTestingAccess, // mods always have testing access
  members: (u) => !u.isMember && !u.isModerator, // mods + members keep access
  nobody: () => true, // kill-switch (mods included)
};
// GateUserCtx = { isModerator; isMember; hasTestingAccess }
```

For `presentation: 'disabled'`, the badge **message** derives from `availableTo`
(`members` → "members only" + upsell, else → "currently unavailable") — reusing
the machinery the self-hosted toggle already has.

### `disabled` (shown) vs `hidden` — the distinction you flagged

These are two different things, and the model keeps them separate:

- **`disabled` is shown.** A mod disables `img2img` for everyone → users still see
  it in the picker, greyed, with "currently unavailable." They know it exists and
  is coming back. **This is the normal way to gate.**
- **`hidden` is removed.** Reserved for things that shouldn't be advertised at
  all (mod-only, internal testing, NSFW on green). Looks "gone" — which is fine
  _for those cases_, wrong for a temporary disable.

So `disabled ≠ hidden` ever. A mod picks which per rule.

Example rules (each one gate, many targets):

```ts
// Maintenance: disable some workflows + an ecosystem for everyone, keep visible:
{ id: 'r1', name: 'Maintenance', availableTo: 'nobody', presentation: 'disabled',
  message: 'Down for maintenance — back shortly.',
  workflows: ['img2img', 'img2img:upscale'], ecosystems: ['Flux1'], modelVersionIds: [] }

// Premium tier: members keep access; free users see greyed + upsell:
{ id: 'r2', name: 'Premium', availableTo: 'members', presentation: 'disabled',
  message: 'Available to members.', // CTA added automatically because `members`
  ecosystems: ['Flux2'], workflows: [], modelVersionIds: [987] }

// Internal: only mods see it; everyone else has it removed entirely:
{ id: 'r3', name: 'Internal', availableTo: 'moderators', presentation: 'hidden',
  ecosystems: ['SecretX'], workflows: [], modelVersionIds: [] }
```

> **`experimental` is not a gate** — it doesn't hide or disable, it just shows an
> "experimental build" banner on a usable item. It stays its own small concern
> (a separate annotation list), not a `GateRule`, so it doesn't muddy hide/disable.

## Resolved state — three states, per item

A rule's `(availableTo, presentation)` resolves, for a given user, to one of
**three client states** (`memberOnly` is its own state — it's only off for
non-members, so calling it "disabled" is wrong):

```ts
type GateState = 'hidden' | 'disabled' | 'memberOnly';
type GateResolution = { state: GateState; message?: string };
//   hidden     → removed from the picker
//   disabled   → shown greyed, standard "currently unavailable" UI
//   memberOnly → shown greyed, standard members-only UI INCLUDING the upsell
//                alert + Become-a-member CTA (same as the self-hosted system)

// presentation 'hidden'                       → 'hidden'
// presentation 'disabled' + availableTo members → 'memberOnly'
// presentation 'disabled' + any other tier    → 'disabled'
```

> **Site-wide `canGenerate`** (model pages / search / API) blocks on `hidden`
> ONLY — disabled / members-only are generator-UI affordances, and membership is
> ignored there to avoid a per-resource tier lookup. See "As built".

A target can match multiple rules; precedence is the most-restrictive state:
**`hidden` > `disabled` > `memberOnly`** — so a globally-down item never upsells.

**Messaging is additive.** The state's standard UI always renders — the
disabled/members-only badge, and for `memberOnly` the **upsell alert + CTA we
already show today** (`SelfHostedBlockedAlert`). A rule's `message` is _optional
extra copy layered on top_; it never replaces the standard badge/alert/CTA.

## Architecture — rules live in the graph context

The generator gating is applied in **one place: the generation graph**, which
runs both client-side (the picker) and server-side (submit validation). Instead
of the server pre-resolving per-user gated lists and shipping those, we ship the
**rules** and let the graph resolve them. (Site-wide `canGenerate` resolves the
`hidden` rules separately — see "As built".)

1. **Shared resolver** — the `GateRule` / `GateState` types + the
   rules→states resolver live in a shared module (`src/shared/data-graph/generation/gates.ts`),
   since the graph is shared.
2. **Server returns the user's _applicable_ rules** — `getGenerationConfig`
   includes `gateRules: GateRule[]`, with **`availableTo` evaluated server-side**
   (authoritative; the granular tiers never leave the server).
3. **`GenerationCtx.gateRules`** carries them into the graph (alongside the
   self-hosted toggle fields, which the nodes merge in).
4. **The graph nodes apply them.** The ecosystem / workflow / model nodes resolve
   each item to a `GateState` and act: `hidden` → drop from `compatibleEcosystems`;
   `disabled` / `memberOnly` → keep, put `{ state, message }` in node `meta`, and
   reject in the `output` refine (so submit is blocked client- and server-side).
5. **Picker + footer read node `meta`** — badge from `state`; `memberOnly` shows
   the existing `syncAccount(…/pricing)` CTA (`SelfHostedBlockedAlert`'s button).

**Key simplification:** because the server already filtered by `availableTo`, the
graph never needs the user's tier context — each applicable rule maps to a state
purely from its own `(availableTo, presentation)`. So the resolver splits:

- **server**: `applicableRulesFor(allRules, user)` — the `availableTo` filter.
- **shared/graph**: `rulesToStates(applicableRules)` → `Map<value, GateResolution>` —
  no user needed.

The graph nodes resolve `ctx.gateRules` into per-item state, and the pickers read
node `meta`. `BaseModelInput`'s badge + the `FormFooter` alert use the per-item
`GateState` + `message`; the member-only CTA is reused as-is.

> `experimental` remains separate (an annotation, not a gate) — see above.

## Moderator UI

A **list of rule cards** on `/moderator/generation-config`. Each card edits one
`GateRule`:

- **Available to** dropdown (`moderators` / `testers` / `members` / `nobody`) +
  **presentation** dropdown (disabled / hidden).
- **Message** field — optional extra copy on top of the standard badge/alert;
  for `members` + `disabled` the card notes the upsell CTA is auto-added.
- Three target inputs — **ecosystems**, **workflows**, **model version IDs**.
- Add rule / remove rule.

## Migration (deploy cutover)

There was **no auto-migration**. The legacy `generation:ecosystem-config` gating
lists were removed in code; production gating is recreated as **rules by hand**
(updating `generation:gate-rules` via the mod UI) before/at deploy, so it's a
clean switch. `experimentalEcosystems` (alert flag) stays in the ecosystem-config
store.

## Folding in the self-hosted toggle (still deferred)

The self-hosted toggle (`selfHostedMode` + `SELF_HOSTED_ECOSYSTEM_KEYS` +
`getSelfHostedDisabledEcosystems` + `SelfHostedGenerationStatusCard`) is kept as
its own feature. It's expressible as one rule
(`{ availableTo: 'members', presentation: 'disabled', ecosystems: [<the 26>] }`),
but the set is **code** knowledge (orchestrator engine routing), not a mod
opinion — so folding it in cleanly wants a `@self-hosted` target-group reference
that expands at resolve time, rather than a hand-maintained list. Out of scope
for now.
