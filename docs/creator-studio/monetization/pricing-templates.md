# Pricing templates — implementation plan

> **Status:** proposed, **blocked**. Supersedes the open question **#17** (see
> [Decisions](#decisions)). Owner: unassigned.
>
> 🔴 **Blocked on [paid-access-decay.md](paid-access-decay.md)** — whose design is settled as of
> 2026-09-02, so the block is now on that work shipping rather than on a decision. That change alters the
> shape of a gate, and a template stores one — shipping templates first means migrating stored
> template JSON afterwards. The block is narrow: the table, both targeting axes, ordering,
> conflict detection and the whole licensing-fee half are unaffected, so Phase 1 is not wasted work.
> What waits is the editor's gate panel and the published-version drop rule.

A creator releasing model after model re-enters the same monetization settings every time. A
**pricing template** is a named, creator-authored set of monetization values — licensing fee and
paid access — that targets one or more **model types** and one or more **base models or
ecosystems**, and **pre-fills the version form** when a new version matches it.

**It fills a form. It never applies a charge.** Nothing is priced until the creator saves the
version, and the rights affirmation is never pre-filled, because it is a statement about one
specific model. The retrospective half of this — pricing versions that already exist — already
shipped as the bulk bar (**B7**) and is out of scope here.

---

## What already exists

Read this section before writing anything: three of the pieces are built and the fourth was
designed.

| Piece | Where | Note |
|---|---|---|
| Two-axis targeting UI | [`/models`](../../../apps/creator-studio/src/routes/(app)/models/+page.svelte) | Model-type and base-model filters, both faceted from the creator's own catalogue ([`models.ts`](../../../apps/creator-studio/src/lib/server/models.ts)) |
| Value editors | `BulkActionDialog.svelte`, `PaidAccessEditor.svelte` | The fee and gate editors a template needs, already built for the bulk bar |
| Retrospective apply | [`bulk-actions.ts`](../../../apps/creator-studio/src/lib/monetization/bulk-actions.ts) | `bulkSetFee` / `bulkSetPaidAccess` + select-all-across-filter |
| Per-type memory | [`model-version-monetization-defaults.store.ts`](../../../src/store/model-version-monetization-defaults.store.ts) | localStorage, keyed by model type — the stopgap this replaces |
| Ecosystem hierarchy | `@civitai/shared/basemodel.constants` | `getEcosystem()`, `getEcosystemFamily()`, `getBaseModelsByEcosystemId()` |
| The key shape, designed | `ModelVersion.licensingSourceVersionId` comment | Refers to a `(baseModel, modelType)` **`BaseModelLicensingFee`** rule table that **does not exist** — a system-level rule that was specced and never built. Not this feature (that one is Civitai's default, this one is the creator's), but the same key. |

Scale the two axes span: **23** model types, **101** base models, **77** ecosystems, **24**
families.

---

## Decisions

### #17 / B9 — resolved, no reversal needed

**B9** decided *"No default fee — fees stay off unless a creator turns one on. When they do, seed
the input: LoRA ~0.1, base/checkpoint ~1 buzz/image."* That is a decision about **Civitai's**
suggested values and about nothing being priced without creator action. It does not speak to
creator-authored defaults; that question was never asked.

**#17** flagged a contradiction because Justin expected `/settings` to *set* a default rate plus an
*"apply to all my models"* button. Splitting that in two:

- **The default** — a creator-authored template is opt-in by construction and only fills a form.
  B9's actual requirement (nothing priced without the creator acting) holds.
- **The bulk apply** — decided the other way by **B7** (*"Bulk fee editing is v1… it's the point of
  the tool"*, with confirm-before-continue) and **already shipped**.

So #17 is resolved by B7 plus this feature. A template targeting *any* model type and *any* base
model **is** the per-account default #17 asked for — except it is visible in a list, nameable, and
switchable off, rather than an invisible account setting.

**Consequence for `/settings`:** the fee-defaults section stops being read-only system info and
becomes a link to the templates list. Authoring defaults lives in one place, not two.

### Answered 2026-09-01

| | Decision |
|---|---|
| **Labelled pre-fill** | The form says which template filled it, with a way to clear it for this version. An unexplained number in a fee box is the support ticket. |
| **No bridge to existing versions** | Creating or editing a template offers nothing retrospective — that is what the bulk editors are for. |
| **Who can author** | Anyone who can set a price. The route carries the same eligibility as pricing (creator-score floor), not a looser one. |
| **No cap on template count** | But the list must **flag conflicts** — see below. |
| **Base-model change** | Re-clamp, never re-resolve — but polish, not a blocker. See [Base-model changes mid-form](#base-model-changes-mid-form--a-polish-item-not-a-hole). |

### Conflicts

Two templates conflict when their match sets overlap. With first-match-wins this is never an *error* —
the higher-priority one simply wins — but the creator has to be able to see it, and there are two
degrees worth distinguishing:

- **Shadowed** — B's match set is a subset of a higher-priority A's. B can never apply to anything.
  This is a dead template and reads as a warning.
- **Overlapping** — they share cells but each also matches cells of its own. Informational: the
  shared cells go to whichever is higher.

Computable exactly, and cheaply: expand each template to its set of `(modelType, baseModel)` pairs —
an empty axis expands to all of it, an ecosystem expands via `getBaseModelsByEcosystemId` — then
compare sets. The worst case is 23 × 101 = 2,323 cells per template, so this is a set operation in
the browser, not a query.

This is the second reason the ordering is explicit rather than scored: **a conflict is only legible
when the tie-break is something the creator can see.** Under specificity scoring, "shadowed" would
be a claim the UI could not justify on screen.

### Scope

- **In:** licensing fee, and **the whole paid-access gate** — access price, the generation grant
  (bundled / cheaper generation-only / free for everyone), free preview generations, Blue Buzz
  acceptance, the timed-vs-permanent choice and its window, **and the donation goal**. Targeting on
  model type × base model/ecosystem, explicit ordering, conflict detection.
- **Out:** `licensingSourceVersionId` (version lineage, resolved per-model by `getLicensingRoots`);
  settlement currency (not a creator choice); usage control (changes what the model *is*, not what it
  costs).

**Donation goals are in (2026-09-01), reversing an earlier call of mine.** I had excluded them as a
per-model fundraising target that shouldn't travel. That reasoning confused two things: create-once
and immutable describes editing a goal *after* it exists, not where its initial value comes from. A
creator who runs every release with the same goal wants it templated, and a pre-filled number is one
they can see and change before saving.

One constraint the editor has to enforce: `toDonationGoalInput` returns null for a permanent gate — a
goal ends a *window* early, and a permanent gate has no window. So the goal field exists only while
the template's gate is timed, and disappears when it is switched to permanent.

---

## Price tags — a competing direction

> ⏸ **Review deferred, 2026-09-03.** This is not being evaluated until Justin decides whether
> `DonationGoal` is kept — see
> [donation-goals.md](donation-goals.md#whether-to-keep-donation-goals-at-all). Both questions change
> what creator-facing pricing looks like, and settling the targeting axis first would risk redoing it.
>
> **Unblocks when:** Justin answers the `DonationGoal` question, after which Briant reviews the
> findings below and picks a targeting axis. Until then this section is a record, not a plan.

From the **Creator Studio Review** group DM, 2026-09-02 (JustMaier and alexds9, 8:37 AM – 12:07 PM).
It began as a question about this plan and became a proposal to replace its targeting model.

> *"Something that's on my mind as we discuss this is a different direction: instead of having
> defaults defined by base model and type, just have **price tags**."* — JustMaier, 9:32 AM

### The proposal

A creator defines named price tags and picks one — or defines a new one — when setting up a model.
Two use cases were named:

- **Lifecycle buckets** — *"my latest and greatest models"*, *"my last versions"*, *"bargain bin"*.
  Target by price tag in the bulk model UI and move models between buckets as they age.
- **Ecosystem pricing** — an *"Anima LoRAs"* tag applied as models are posted; when Anima ages out,
  lower the tag's price and every model carrying it follows.

### Why it was preferred over base-model/type defaults

All three reasons are removals of ambiguity, and each maps to a problem this plan currently solves
with machinery:

| Price tags remove | This plan handles it with |
|---|---|
| *"Did I leave this at the default, so will changing the default fix it?"* | precedence rules against the other pre-fill sources |
| *"What if I want a different price?"* — just do not apply a tag | the published-version drop rule and re-clamping |
| **Overlapping defaults** — one tag per version, always chosen explicitly | explicit template ordering, first match wins, plus conflict detection |

🔑 **That third row is the substantive claim.** Conflict detection between double-matching templates
is a real cost in this plan — it needs ordering, a UI to surface conflicts, and a rule for what a
creator sees when two templates match. Price tags do not need any of it, because a version carries
exactly one tag and a human chose it.

### Where it landed

Agreed in principle, no implementation decision recorded. alexds9 (10:28 AM, 👍) called it a good
solution and noted it specifically handles publishing models on the same base model at different
prices — with one condition: creators must be able to **create new tags and apply them to existing
models in bulk**, then hand-edit specific versions.

JustMaier added two scope points at 12:07 PM (both 👍):

- The applied price tag must be **visible in the bulk edit UI**
- Price tags should cover **all monetization**, so generation fees are managed through them too

The conversation then moved to paid galleries. Nothing since.

### What this means for this plan

The two are not compatible as written — they are different answers to *how does a creator say which
models get this price*. Targeting by model type × base model is automatic and can double-match;
tagging is manual and cannot.

**Unresolved, and it should be settled before Phase 1** — though not yet, per the deferral above. The table, the fee half and the pre-fill
mechanism survive either way; what changes is the targeting axis, the conflict-detection work, and
the authoring UI. Note that alexds9's bulk-apply condition reintroduces much of what the
auto-assignment in the mockups already did, so the gap between the two is smaller than it first
appears.

Also tracked as an open item at
[creator-studio-feedback-2026-08-03.md](../../creator-studio-feedback-2026-08-03.md) — *"Named price
groups / price tags"*. The Discord thread is newer and materially extends it: bulk
creation/assignment, visibility in bulk edit, one tag per version, coverage of generation fees, and
the no-overlapping-defaults rationale.

## Data model

One table. Both axes are arrays; empty means *any*.

```prisma
model PricingTemplate {
  id       Int     @id @default(autoincrement())
  userId   Int
  user     User    @relation(fields: [userId], references: [id], onDelete: Cascade)
  name     String
  // Creator-ordered. Lowest value wins; see Resolution.
  priority Int     @default(0)
  enabled  Boolean @default(true)

  // Targeting. Empty array = matches anything on that axis. `baseModels` and `ecosystems` are
  // OR-ed with each other and AND-ed with `modelTypes`.
  modelTypes ModelType[]
  baseModels String[]
  ecosystems String[]

  // Values. Null = this template does not speak to that field.
  licensingFee     Decimal? @db.Decimal(10, 2)
  licensingFeeType LicensingFeeType?
  // The whole gate config, donation goal included — the form's shape, not the API's.
  paidAccess       Json?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([userId, priority])
}
```

**Why `ecosystems` ships in v1 rather than later.** The base-model picker is faceted from base
models the creator has *already used*, so a `baseModels`-only template can only ever target their
past. The moment they adopt a new base model — precisely when a default helps most — nothing
matches. Ecosystem targeting is what makes a template survive "Illustrious v2 shipped".

**Why `paidAccess` is Json.** It holds every field of the gate editor — access price, generation
grant and its optional cheaper price, trial limit, Blue Buzz, timed/permanent, window, donation goal.
`formPaidAccessConfigSchema` already validates exactly that shape, so the column stores it whole with
no `omit` and no second contract to keep in step. Flattening ten fields into columns buys nothing the
list view needs.

**Why the fee stays columns.** So the studio can list and sort templates without parsing Json.

### Migration

`packages/civitai-db-schema/prisma/migrations/<ts>_pricing_template/migration.sql`, then
`pnpm run db:generate` (regenerates the Prisma client, `kysely/types.ts`, `updated-at-tables.ts`) and
`pnpm run db:check-generated`.

**Migrations are applied by hand** — see the Database section of the root `CLAUDE.md`. This one is
additive and touches no existing table, so ordering against a deploy is unconstrained.

`ModelType[]` is a Postgres enum array and needs no new enum value, so the
deploy-before-migrate rule for additive enum values does not apply.

---

## Resolution

Two problems: which templates match a version, and which one wins.

### Matching

A template matches `(modelType, baseModel)` when **both** hold:

- `modelTypes` is empty, or contains `modelType`
- `baseModels` is empty **and** `ecosystems` is empty, or `baseModels` contains `baseModel`, or
  `ecosystems` contains `getEcosystem(baseModel)?.key`

### Precedence: explicit order, first match wins

**Not specificity scoring.** CSS-style "both axes exact beats one wildcard" is invisible: when a
creator's LoRA comes out at the wrong price they have no way to see which template won or why. An
ordered list is a rule they can read off the screen and reorder — the firewall-rules pattern, which
is right whenever a human has to debug the outcome.

Order is `priority ASC, id ASC`. `enabled = false` templates are skipped.

### Where the rule lives

The matching predicate is **pure** and goes in `@civitai/buzz` beside `pricing-allowance.ts`, which
documents the same split:

> Both the main app and the creator-studio spoke enforce these rules themselves… What each app owns
> is the two QUERIES and the ordering; everything a query does not need lives here, so a threshold
> or a message cannot drift between two doors into the same data.

So: `packages/civitai-buzz/src/pricing-template.ts` exports `templateMatches()` and
`resolveTemplate(templates, { modelType, baseModel })`, with a colocated `pricing-template.test.ts`
(runs under `pnpm run test:packages:run`). Each app owns its own query.

### Precedence against the other pre-fill sources

Four things can fill these fields. Ordered, highest first:

1. **A matching pricing template** (new)
2. **`licensingSourceVersionId`** auto-selected from `getLicensingRoots` — lineage, a different
   field, so it does not actually compete for the fee input
3. **`suggestedFee`** — the system per-type constant (**B9**)

The **localStorage per-type memory retires** when templates ship. Its whole job was to approximate a
template, and keeping both means two invisible sources that can disagree. It was persisted with the
same field names as this row deliberately, so existing snapshots can be migrated into templates on
first load, or simply dropped.

---

## Surfaces

### Studio — authoring

New route `apps/creator-studio/src/routes/(app)/templates/`, plus a nav entry.

- **List** — name, targeting summary ("LoRA · Illustrious, Pony"), fee, gate, enabled toggle,
  drag-to-reorder writing `priority`, and a **conflict badge** per row (shadowed / overlapping).
- **Editor** — targeting via the same faceted multi-selects `/models` uses, with an ecosystem
  option alongside base models; values via `BulkActionDialog` / `PaidAccessEditor`.
- **Match preview** — "matches 14 of your versions", computed from the same facet query. This is
  the payoff of naming base models: the editor knows the media type up front (`capMediaType`), so it
  can validate the fee against the **real** ceiling (5× on video) and refuse an impossible template
  at authoring time instead of clamping it silently months later.
- **Writes** — SvelteKit form actions → Kysely, scoped to `locals.user.id`, matching how the studio
  already writes fees ([`monetization/licensing-fee.ts`](../../../apps/creator-studio/src/lib/server/monetization/licensing-fee.ts)).
  No main-app endpoint is needed: this table has no side effects, no buzz call, and no cache to bust.

### Main app — consumption

- **tRPC** `pricingTemplate.getForVersion({ modelType, baseModel })` on a `protectedProcedure`,
  returning the resolved template or null. Resolution runs server-side via the shared helper so the
  client never holds the creator's full template list.
- **`ModelVersionUpsertForm`** — replace the localStorage read in `applyMonetizationDefaults()` with
  this query. Most of the seam transfers unchanged: the effect keyed on `showChargeSettings`, the
  fee clamp, the denominator guard, the `hasExistingCharge` guard, and the drop-not-coerce rule for
  a timed window the version cannot offer.

  Keep the disclosure rule that seam exists for: values land when the pricing controls **mount**,
  never at the monetize switch. At the switch the creator has only the affirmation on screen, so a
  fee applied there is a charge with no control to see it by — and one `requiresRightsAffirmation`
  then refuses the save over.

  **New:** the pre-fill is labelled — "Pricing from *LoRA defaults*" beside the section, with a
  control that clears the applied values for this version only. The template is unaffected.

### Base-model changes mid-form — a polish item, not a hole

An earlier draft of this plan called this "the one place the shipped seam does not transfer" and
"the actual bug". **That was overstated** (corrected 2026-09-01), on two counts.

**The server already guards it, by name.** `assertPricingAllowed` computes `movesToStricterMedia`
and refuses the write with a message that names the ceiling and the base model —
*"A licensing fee can be at most 100 Buzz per generation on this base model. Lower the fee to
continue."* ([`paid-access.service.ts`](../../../src/server/services/paid-access.service.ts), the fee
ceiling block). The comment there already explains the video-to-image case in full. So the failure
mode is a specific, actionable error, not silent corruption.

**And the sequence is rare.** It needs a creator to enable monetization — applying a template — and
*then* go back and change the base model to one on a stricter media axis, in the same session. On a
version that already charges, no template applies at all (`hasExistingCharge`); on a brand-new one
there is no `storedBaseModel`, so the write is refused the same way a hand-typed over-cap fee is.

So: **a client-side re-clamp on `baseModel` change is worth doing as polish** — it turns a server
refusal into a visible adjustment — but it is not a correctness requirement and does not gate Phase 3.
If it is built, the rule is still re-clamp, never re-resolve: silently swapping in a different template
would overwrite edits the creator made deliberately.

The version of this that **is** frequent is authoring-time, and only the editor can catch it: a
template targeting a video ecosystem and an image one has two ceilings, and its fee must clear the
stricter. See the editor's match preview.

---

## Phasing

Each phase names what ends it.

**Phase 1 — data + rule.** Table, migration, `db:generate`; `pricing-template.ts` in `@civitai/buzz`
with its test file.
*Done when:* `pnpm run db:check-generated` passes and `pnpm run test:packages:run` covers matching,
ordering, the empty-axis wildcards, and ecosystem expansion.

**Phase 2 — studio authoring.** Route (gated on the same pricing eligibility as setting a price),
list with conflict badges, editor, reorder, match preview.
*Done when:* a creator can create, reorder, disable and delete a template; a template fully shadowed
by a higher-priority one is flagged as such; and the three `svelte-*-review` agents pass on the
segment.

**Phase 3 — main-app consumption.** tRPC procedure; swap the form's source; add the label. The
base-model re-clamp is optional polish here — the server already refuses an over-cap fee with a
specific message.
*Done when:* the existing `ModelVersionUpsertForm.browser.test.tsx` monetization-defaults tests pass
against the template source, plus new tests for "no template matches → falls back to the B9
suggestion" and "clearing the applied values leaves the template alone".

**Phase 4 — retire the stopgap.** Delete the localStorage store and its schema module (fold
`formPaidAccessConfigSchema` back into the form or keep the module, but drop the persistence).
*Done when:* no import of `model-version-monetization-defaults.store` remains and the suite is green.

---

## Testing

- **Shared rule** (`@civitai/buzz`) — matching, wildcards, ecosystem expansion, ordering, disabled
  templates, and conflict classification (shadowed vs overlapping vs disjoint). Pure functions, no
  fixtures.
- **Studio** — form actions scoped to the owner; a template belonging to another user is not
  editable. Reorder writes the priorities it claims to.
- **Main app** — the browser tests already written for the localStorage version transfer as-is; add
  the no-match fallback case.
- Every guard needs a test that **fails when the guard is removed** — check the revert, not just the
  green run. The existing monetization-defaults tests were each verified this way and are the model
  to follow.

---

## Risks

- **Two pre-fill sources during Phase 3.** Between shipping templates and retiring localStorage, a
  creator can have both. Phase 4 is not optional, and should land in the same release.
- **A template that matches nothing.** Faceted pickers show only what the creator has used; an
  ecosystem-targeted template for an ecosystem they have not adopted yet legitimately matches zero
  versions today. The match preview must say "0 today" without reading as an error.
- **Fee ceilings move with the base model, not the template.** A template targeting both an image
  and a video ecosystem has two different ceilings. The editor validates against the **strictest**
  match (image), so a video-only template is the way to charge a video rate.
- **Allowance surprise.** Templates do not spend monthly pricing slots — the save does
  (`assertPricingAllowed`). A creator who templates a fee across many uploads still meets the tier
  allowance one save at a time. Surfacing remaining allowance near the pre-filled fee is a
  nice-to-have, not a blocker.
