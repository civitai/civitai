# Generation Presets

## Overview

Users can save named snapshots of their generation settings as **presets** and load them back into the GenerationForm. Presets are **private to the user** in v1 — there is no sharing, browsing, or copying between users. Users can also set a preferred default ecosystem for image and video output types.

## Requirements

### Default Ecosystem Preferences

- Users can set a preferred default ecosystem for **image** output (e.g., SDXL, Flux) and **video** output (e.g., Kling, Wan)
- Applied on form init when no other context overrides it (remix, replay, etc.)
- Personal preference only — never shared

### Generation Presets

- A preset captures the **entire generation-graph output** at save time (all current node values). No field picker — save everything.
- Every preset is scoped to a **single ecosystem** (auto-detected from the form's current ecosystem at save time)
- When a user is in the GenerationForm, they see the list of presets that **apply to their current ecosystem** — this includes:
  - Presets saved directly for that ecosystem
  - Presets from other ecosystems whose resources are cross-ecosystem compatible (see [Cross-Ecosystem Querying](#cross-ecosystem-querying))
- On apply: the full preset values are loaded into the form. The graph handles ecosystem switching when the preset's checkpoint belongs to a different ecosystem — checkpoints always denote which ecosystem to use.
- On apply: resource availability is validated via `getGenerationData` — unavailable resources are flagged to the user
- Applying a preset **overwrites** the current generator panel values (plain replace; no prompt merge modes)
- All presets are **private** in v1 (no `public` toggle, no sharing, no copy)
- Users can reorder their own presets
- Images/video input nodes are **excluded** from presets
- Unlimited presets per user

## Database Schema

### Default Ecosystem Preferences

Stored in the existing `User.settings` JSON column via `generationSettingsSchema`:

```ts
// src/server/schema/user.schema.ts
const generationSettingsSchema = z.object({
  advancedMode: z.boolean().optional(),
  // NEW
  defaultEcosystems: z.object({
    image: z.string().optional(),
    video: z.string().optional(),
  }).optional(),
});
```

No migration needed — additive change to an existing JSON field.

### Generation Presets Table

New table:

```prisma
model GenerationPreset {
  id          Int      @id @default(autoincrement())
  userId      Int
  user        User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  name        String   @db.VarChar(100)
  description String?  @db.VarChar(500)

  // Scoping — every preset is owned by exactly one ecosystem
  // Stored as the ecosystem key string (e.g., 'SDXL', 'Flux1') — matches how ecosystems
  // are persisted elsewhere. No FK because ecosystems aren't a DB-bound table yet.
  // Cross-ecosystem visibility is computed at query time via basemodel.constants helpers.
  ecosystem   String

  // The full generation-graph output at save time. Applied via graph.set(values) on load.
  // Resource refs store { id, strength? } — see "Resource reference shape" below.
  // Images/video input nodes are excluded at save time.
  values      Json

  // User's personal ordering
  sortOrder   Int      @default(0)

  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@index([userId])
  @@index([userId, ecosystem])
}
```

Requires a Prisma migration.

## Implementation Plan

### Phase 1: Schema & API

1. **Extend `generationSettingsSchema`** in `src/server/schema/user.schema.ts`
   - Add `defaultEcosystems: { image?: string, video?: string }`
   - Extend `setUserSettingsInput` to accept it

2. **Create Prisma migration** for `GenerationPreset` table
   - Add relation to `User` model in `schema.full.prisma`

3. **Add tRPC router** for preset CRUD
   - `generationPreset.getForEcosystem({ ecosystem })` — list presets applicable to a given ecosystem (owner's presets only, expanded via cross-ecosystem rules)
   - `generationPreset.getOwn` — list current user's presets (all ecosystems)
   - `generationPreset.getById({ id })` — get a single preset (owner only)
   - `generationPreset.create({ name, description?, values })` — save a new preset; `ecosystem` is derived server-side from the form context sent alongside
   - `generationPreset.update({ id, name?, description?, values? })` — edit own preset
   - `generationPreset.delete({ id })` — delete own preset
   - `generationPreset.reorder({ orderedIds: number[] })` — bulk-assign `sortOrder` by array index

### Phase 2: Default Ecosystem Integration

4. **Read default ecosystem on form init** in `GenerationFormProvider`
   - Fetch `settings.generation.defaultEcosystems` from user settings
   - Apply as initial ecosystem when no remix/replay/stored preference overrides
   - Falls back to current behavior (hardcoded defaults) if not set

5. **UI for setting default ecosystem**
   - Small control in generation form header or settings area
   - Calls `setUserSettings` with updated `generation.defaultEcosystems`

### Phase 3: Preset Save/Load

6. **Save preset flow**
   - User clicks "Save as preset" in generation form — there is no in-form "Save" button; every save goes through the modal
   - Modal fields: **name** (required) and **description** (optional)
   - If the user types a name that matches one of their existing presets for the current ecosystem, the modal offers to **overwrite** that preset (calls `generationPreset.update`); otherwise it creates a new one (`generationPreset.create`)
   - Grab the full graph output via `graph.getSnapshot()` (excluding images/video input nodes)
   - Auto-detect current ecosystem for scoping (preset's `ecosystem` = current ecosystem)

7. **Load preset flow**
   - Preset selector in the generation form, populated via `generationPreset.getForEcosystem({ ecosystem })`
   - On select: `graph.set(preset.values)` applies the full saved state
   - If the preset includes a checkpoint from a different ecosystem, the graph's existing ecosystem-switch behavior handles the switch (checkpoints denote ecosystem)
   - If any resources are unavailable, surface the same warning pattern remix uses via `getGenerationData`

8. **Manage presets UI**
   - List view of user's presets with reorder, rename, edit description, delete
   - Accessible from the generation form (e.g., "Manage presets" menu item)

## Authorization

Every route is owner-scoped in v1 — there are no public presets.

| Procedure            | Who can call                 | Ownership check                     |
| -------------------- | ---------------------------- | ----------------------------------- |
| `getForEcosystem`    | authenticated user           | implicit `userId = ctx.user.id`     |
| `getOwn`             | authenticated user           | implicit `userId = ctx.user.id`     |
| `getById`            | authenticated user           | `preset.userId === ctx.user.id`     |
| `create`             | authenticated user           | row created with `ctx.user.id`      |
| `update`             | authenticated user           | `preset.userId === ctx.user.id`     |
| `delete`             | authenticated user           | `preset.userId === ctx.user.id`     |
| `reorder`            | authenticated user           | all `orderedIds` belong to the user |

## Key Integration Points

### Saving — `graph.getSnapshot()`

The DataGraph's `getSnapshot()` returns all current node values. At save time we take the whole snapshot (minus the excluded input keys) and send it to `generationPreset.create`:

```ts
const snapshot = graph.getSnapshot();
const EXCLUDED = new Set(['images', 'video']); // input references, not saved
const values = Object.fromEntries(
  Object.entries(snapshot).filter(([k]) => !EXCLUDED.has(k))
);
```

### Applying — `graph.set(values)`

```ts
// graph.set accepts partial updates; inactive/unknown nodes are silently ignored.
// The graph handles ecosystem switching when the checkpoint belongs to a different ecosystem.
graph.set(preset.values);
```

### Resource reference shape

Resources inside `values` store the minimum needed to re-hydrate plus the user-tunable strength:

```ts
{
  model:     { id: number },                      // checkpoint
  resources: Array<{ id: number; strength?: number }>, // LoRAs and similar
  vae:       { id: number }                       // optional
}
```

On apply, full resource metadata is re-resolved via `getGenerationData` — same pattern remix uses. If a resource is unavailable, the user sees the standard unavailable-resource warning.

### Values validation at the API boundary

The `values` column is `Json`. We rely on the generation graph's existing **per-node validation** to handle malformed or out-of-range data on apply — invalid nodes are dropped, valid ones are applied. The tRPC input validates the outer shape (`values` is an object with expected top-level keys), not the full per-node schema.

## Cross-Ecosystem Querying

Presets are saved against a single `ecosystem`, but a preset can still be **applied** in a different ecosystem when its resources are cross-compatible (e.g., an SDXL LoRA can run inside Pony/Illustrious/NoobAI), or when it's a settings-only preset shared within the same family. The generation form should surface all such presets to the user.

### Helpers in `basemodel.constants.ts`

The compatibility layer already exposes everything we need:

- `crossEcosystemRules` — the rule table keyed by `(sourceEcosystemId, targetEcosystemId, supportType, modelTypes?)`
- `getGenerationSupport(checkpointEcosystemId, addonEcosystemId, modelType)` — returns `'full' | 'partial' | null`
- `areResourcesCompatible(ecosystemId, resources)` — returns `true` if **every** resource is compatible with the target ecosystem
- `getResourceEcosystemCompatibility(ecosystemId, baseModel, modelType)` — single-resource variant
- `getRootEcosystem(ecosystemId)` — used to bound settings-only preset visibility to a shared family

### Query flow for `generationPreset.getForEcosystem`

Given the user's current `ecosystem` (and filtered to `userId = ctx.user.id`):

1. **Direct matches** — presets where `preset.ecosystem === currentEcosystem` (no compatibility check needed)
2. **Cross-compatible matches** — presets where `preset.ecosystem !== currentEcosystem`:
   - If `preset.values` contains resource refs (`model` / `resources` / `vae`) → visible iff `areResourcesCompatible(currentEcosystem, <extracted resources>)` returns `true`
   - If `preset.values` has no resource refs (settings / prompt only) → visible iff the two ecosystems share a root via `getRootEcosystem` (keeps SDXL-family settings visible within the family but avoids SDXL settings leaking into Flux)

Because `values` is a single JSON bag, the server extracts resource refs on the fly when running compatibility checks. Cross-compatibility is a sparse rule table (not a parent-chain inference — see comment at [basemodel.constants.ts:3049](../src/shared/constants/basemodel.constants.ts#L3049)), so it's cheap to expand the user's current ecosystem into a set of "source ecosystems whose resources can run here" and pre-filter candidates by that set before the per-preset check.

## Design Decisions

### Single-ecosystem storage with cross-ecosystem query expansion

A preset is owned by one ecosystem (`ecosystem`). Broader applicability is **derived at query time** via the cross-ecosystem rules rather than stored on the row. This keeps the row shape simple and guarantees we use the same compatibility rules everywhere (a preset's reach automatically widens when a new cross-ecosystem rule is added to `basemodel.constants.ts`).

### Save the full graph, not a user-picked subset

We considered a field picker in the create modal. Dropping it keeps v1 scope minimal and matches user intent ("save what I have"). Users can still delete a preset and save a new one if they want a different shape.

### Checkpoint carries ecosystem context on apply

Because a checkpoint always denotes an ecosystem, applying a preset whose `model` belongs to a different ecosystem triggers the graph's existing ecosystem-switch behavior. We don't need special "apply settings only" logic at the API layer — the graph owns that transition.

### Private-only in v1

All presets are private. No public toggle, no sharing, no copy. This defers the content-moderation surface entirely and keeps the row shape minimal. Sharing (with or without prompts) can be added later as an additive change — the schema won't need to change to support read-only public rows.

### Resource references store `{ id, strength? }`

Storing just `id` (plus `strength` where applicable) keeps rows small and ensures that model metadata (availability, baseModel, permissions) is always re-resolved at apply time. This matches the remix flow.


@dev - in the client, we will show a save button next to the help icon that starts the tour at the top of the generation panel. This will open the modal to save the preset. When a preset is selected, we will show the preset name above the generation form workflow selectors. When the form values have diverged from the preset values, we will show something that indicates that the preset is dirty. There will be a "save" button as well as a "save as" button when the preset is dirty. Save will simply update the preset, while "save as" will opent the preset modal so that the user can enter a different name for the preset.