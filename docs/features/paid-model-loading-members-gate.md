# Members-only loading for cold checkpoints — implementation plan

Only members may **start a download** by generating with a checkpoint that is not resident. Anything
already loaded stays available to everyone, and every other resource type — LoRAs, embeddings, VAEs —
is untouched whether it is resident or not.

Status: **planned, not built.** Feature it extends:
[paid-model-loading.md](paid-model-loading.md).

---

## The decision

**A Flipt flag owns the audience; a generation gate rule owns how the gate looks.**

`src/shared/data-graph/generation/gates.ts` already carries an audience, a presentation and a refusal
path; what it cannot express is the target, because "checkpoints that are not currently resident" is a
predicate rather than a list. So we add one condition to the rules model and reuse the rest.

What the rule cannot do is **ramp**. `availableTo` is an enum — moderators, testers, members, nobody —
with no "members plus 10% of everyone else". The launch plan is member-only at first and open to
everyone once loading has proved itself, with the option of closing it again quickly if it has not, so
the audience belongs on a flag:

`GENERATION_LOADING_MEMBERS_ONLY = 'generation-loading-members-only'`

- **On** → the condition rule applies → cold checkpoints are members-only.
- **Off** → the rule stops applying → everyone can start a download.
- **Percentage** → that share of non-members is exempt, which is the ramp a rule cannot give.

One operational switch, in the same system as `generation-coverage-next`, which remains the wider
control: coverage off means nobody gets cold checkpoints at all, flag on means only members do.
The rule stays a mod-editable home for the presentation and the copy.

Default **on**, so the members-only state survives an unreachable Flipt — the safe failure for a
launch gate is the narrower audience, not the wider one.

## What already exists

| Need | Already in `gates.ts` |
| --- | --- |
| Audience | `availableTo: 'members'` — members + mods keep access |
| Show it but say why | `presentation: 'disabled'` — "keeps a MODEL VERSION selectable so the form can say why" |
| Hide it instead | `presentation: 'hidden'`, switchable per rule |
| Upsell copy | `message`, layered on the standard UI |
| Refusal at submit | `gatedSelectionRefusal`, called from `orchestration-new.service.ts:848` |
| Audience stays server-side | `applicableRulesFor` on the server; `rulesToStates` in the graph |

The module already states the behaviour this plan wants: *"A disabled or members-only target stays
selectable; its generation requests are refused instead."*

## The one new concept

A **condition target** — a rule that applies to resources matching a predicate rather than to a named
list:

```ts
conditions: z.array(z.enum(['coldCheckpoint'])).default([])
```

`coldCheckpoint` is `model.type === 'Checkpoint'` and `generatorReadiness(version) === 'cold'`. It
needs no new Meilisearch field: `type` and `versions.generatorLoaded` are both already filterable and
were applied to the live index on 2026-09-23. Deriving it anywhere else would be a second encoding of
residency, which is what `no-divergent-generator-readiness` exists to prevent.

---

## Phases

### 0. Prerequisite — event-driven residency. **Done.**

A gate keyed on residency that trails by five minutes would refuse models that are in fact loaded —
a support ticket, where the same staleness in a *label* is only an annoyance. That risk is gone:
`src/pages/api/webhooks/resource-availability.ts` is on `main` and writes `generatorLoaded` as each
batch arrives, with `sync-generator-loaded-resources` left as the backstop. Residency is read from
`workersAvailable` rather than the `loaded` flag beside it, since a resource with no worker cannot
serve a generation whatever the flag says.

**This branch is behind `main` and does not have it yet** — merge before building, or the gate will be
written against the five-minute world.

### 1. Stop hard-coding membership

`getCanGenerateHiddenGates` (`generation.service.ts:1044`) passes `isMember: true` unconditionally, so
every member-scoped rule currently applies to everyone as though they were a member. Pass the real
value from `SessionUser.tier`.

**Verified safe as of 2026-09-24:** all seven live gate rules are `available to moderators`; none is
`members`, so fixing this changes nobody's behaviour today. Re-check before landing — if a `members`
rule exists by then, this commit starts gating people.

Own commit, separate from the rest.

### 2. Condition targets in the rules model

- `gateRuleSchema` gains `conditions`.
- `rulesToStates` resolves condition rules alongside the three target maps, keeping `pickStrongerGate`
  so an overlapping version-id rule still wins where it is stronger.
- The per-version lookup applies condition rules where the resource satisfies the predicate.
- `CanGenerateBlockedTargets` keeps its rule that only `hidden` hard-blocks `canGenerate`; a
  `hidden` condition rule has to reach it too.

Tests: a condition rule gates a cold checkpoint and not a resident one, not a cold LoRA, and not a
member; `pickStrongerGate` still resolves an overlapping rule; and — per the repo's revert rule — each
assertion fails legibly when the condition is dropped.

### 3. The surfaces

Three doors, and they do not behave the same today:

- **Generator form** — consumes gate states already. A `disabled` condition rule works here as soon as
  phase 2 lands: the version stays selectable and the form says why.
- **Submit** — `gatedSelectionRefusal` must evaluate conditions. Without this the gate is cosmetic.
- **Resource picker** — consumes **no** gate state at all (verified). Wire it to the resolved state
  rather than re-deriving the predicate from the index, which would be the same divergence phase 2
  avoids.
- **Model page Create button** — reads `canGenerate` only, and `disabled` rules deliberately do not
  affect `canGenerate`. So a non-member would press Create and meet the refusal later, in the
  generator. Either thread the gate state to the button, or accept that the generator is where the
  upsell is made — the resource arrives pre-selected and the form explains, which is arguably the
  better placement. **Decide before building phase 3.**

### 4. Copy and rollout

Create the rule with `availableTo: 'members'`, `presentation: 'disabled'` and a message that says a
membership starts the download — not that the model is unavailable, which is what a non-member would
otherwise read. Test on preview with a non-member account, then decide whether to keep `disabled` or
switch to `hidden`; that is a per-rule change, no deploy.

---

## Deliberately not covered

- **Boosting.** A non-member who cannot start a cold checkpoint never reaches its boost. They can
  still boost a workflow whose LoRA is downloading, which is fine and stays as it is.
- **The moderator load tool** (`resourceLoad.submit`) keeps its own path.
- **The "Loaded only" chip** needs no change: nothing is implicitly filtered under `disabled`, so it
  keeps working and becomes the non-member's own way to narrow to what they can use now.

## Open decisions

1. `disabled` or `hidden` at launch — recommendation: `disabled`, since hiding a model only inside the
   generator, while it stays visible everywhere else on the site, produces the confusion this feature
   set out to end.
2. Whether the model page Create button carries the reason, or defers to the generator (phase 3).

## Why this is a rollout stage, not a takeaway

Before paid model loading, a non-resident checkpoint blocked the submit for everyone. A non-member
under this rule lands on approximately that behaviour, while members get the new one. Worth saying in
the copy.
