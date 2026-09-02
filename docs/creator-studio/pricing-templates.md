# Pricing templates — implementation plan

> **Status:** proposed, not started. Supersedes the open question **#17** (see
> [Decisions](#decisions)). Owner: unassigned.

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
| Two-axis targeting UI | [`/models`](../../apps/creator-studio/src/routes/(app)/models/+page.svelte) | Model-type and base-model filters, both faceted from the creator's own catalogue ([`models.ts`](../../apps/creator-studio/src/lib/server/models.ts)) |
| Value editors | `BulkActionDialog.svelte`, `PaidAccessEditor.svelte` | The fee and gate editors a template needs, already built for the bulk bar |
| Retrospective apply | [`bulk-actions.ts`](../../apps/creator-studio/src/lib/monetization/bulk-actions.ts) | `bulkSetFee` / `bulkSetPaidAccess` + select-all-across-filter |
| Per-type memory | [`model-version-monetization-defaults.store.ts`](../../src/store/model-version-monetization-defaults.store.ts) | localStorage, keyed by model type — the stopgap this replaces |
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

### Scope

- **In:** licensing fee, paid access (gate terms + prices), targeting on model type × base
  model/ecosystem, multiple templates with explicit ordering.
- **Out:** donation goals (per-model fundraising target, create-once and immutable — carrying one
  across models sets a goal against a window nobody chose); `licensingSourceVersionId` (version
  lineage, resolved per-model by `getLicensingRoots`); settlement currency (not a creator choice);
  usage control (changes what the model *is*, not what it costs).

---

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

**Why `paidAccess` is Json.** It is a nested object (`permanent`, `timeframeDays`, `terms.download`,
`terms.generation`, `acceptsBlueBuzz`); `modelVersionPaidAccessInputSchema` already validates that
shape on the way in, and `toFormPaidAccessConfig` already maps it to the form's shape on the way
out. Flattening it into columns forks a contract that exists.

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
  drag-to-reorder writing `priority`.
- **Editor** — targeting via the same faceted multi-selects `/models` uses, with an ecosystem
  option alongside base models; values via `BulkActionDialog` / `PaidAccessEditor`.
- **Match preview** — "matches 14 of your versions", computed from the same facet query. This is
  the payoff of naming base models: the editor knows the media type up front (`capMediaType`), so it
  can validate the fee against the **real** ceiling (5× on video) and refuse an impossible template
  at authoring time instead of clamping it silently months later.
- **Writes** — SvelteKit form actions → Kysely, scoped to `locals.user.id`, matching how the studio
  already writes fees ([`monetization/licensing-fee.ts`](../../apps/creator-studio/src/lib/server/monetization/licensing-fee.ts)).
  No main-app endpoint is needed: this table has no side effects, no buzz call, and no cache to bust.

### Main app — consumption

- **tRPC** `pricingTemplate.getForVersion({ modelType, baseModel })` on a `protectedProcedure`,
  returning the resolved template or null. Resolution runs server-side via the shared helper so the
  client never holds the creator's full template list.
- **`ModelVersionUpsertForm`** — replace the localStorage read in `applyMonetizationDefaults()` with
  this query. **The seam is already built and tested**: the effect keyed on `showChargeSettings`,
  the fee clamp, the denominator guard, the `hasExistingCharge` guard, and the drop-not-coerce rule
  for a timed window the version cannot offer. Only the source of the values changes.

  Keep the disclosure rule that seam exists for: values land when the pricing controls **mount**,
  never at the monetize switch. At the switch the creator has only the affirmation on screen, so a
  fee applied there is a charge with no control to see it by — and one `requiresRightsAffirmation`
  then refuses the save over.

---

## Phasing

Each phase names what ends it.

**Phase 1 — data + rule.** Table, migration, `db:generate`; `pricing-template.ts` in `@civitai/buzz`
with its test file.
*Done when:* `pnpm run db:check-generated` passes and `pnpm run test:packages:run` covers matching,
ordering, the empty-axis wildcards, and ecosystem expansion.

**Phase 2 — studio authoring.** Route, list, editor, reorder, match preview.
*Done when:* a creator can create, reorder, disable and delete a template, and the three
`svelte-*-review` agents pass on the segment.

**Phase 3 — main-app consumption.** tRPC procedure; swap the form's source.
*Done when:* the existing `ModelVersionUpsertForm.browser.test.tsx` monetization-defaults tests pass
against the template source, and a new test covers "no template matches → falls back to the B9
suggestion".

**Phase 4 — retire the stopgap.** Delete the localStorage store and its schema module (fold
`formPaidAccessConfigSchema` back into the form or keep the module, but drop the persistence).
*Done when:* no import of `model-version-monetization-defaults.store` remains and the suite is green.

---

## Testing

- **Shared rule** (`@civitai/buzz`) — matching, wildcards, ecosystem expansion, ordering, disabled
  templates. Pure functions, no fixtures.
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
