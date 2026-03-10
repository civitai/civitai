# Generation Presets

## Overview

Users can save and share generation presets — named snapshots of generation settings scoped to specific ecosystems and workflows. Users can also set a preferred default ecosystem for image and video output types.

## Requirements

### Default Ecosystem Preferences
- Users can set a preferred default ecosystem for **image** output (e.g., SDXL, Flux) and **video** output (e.g., Kling, Wan)
- Applied on form init when no other context overrides it (remix, replay, etc.)
- Personal preference only — never shared

### Generation Presets
- Users can save their current generation settings as a named preset
- Presets are scoped to one or more **workflows**
- Two types of presets based on whether resources are included:
  - **Settings-only presets**: Can target multiple ecosystems (e.g., all SD-family). No resource refs.
  - **Resource presets**: Include model/LoRA/VAE references. Locked to a **single ecosystem** (resources are ecosystem-specific).
- On apply, resource availability is validated via `getGenerationData` — unavailable resources are flagged to the user
- Presets can optionally include prompt/negativePrompt with merge modes (prepend, append, replace)
- Presets are private by default; users can opt-in to make them public
- Users can browse and copy public presets from other users
- Users can reorder their own presets

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

  // Scoping — which ecosystems and workflows this preset is compatible with
  // If resources are included, this MUST be a single-element array
  ecosystems  String[] // e.g., ['SDXL', 'Pony', 'Illustrious'] or ['Flux1'] (if resources present)
  workflows   String[] // e.g., ['image:create', 'image:animate']

  // The saved node values (settings, prompt with merge modes)
  values      Json     // e.g., { sampler: 'DPM++ 2M Karras', steps: 25, cfgScale: 7 }

  // Optional resource references — when present, ecosystems must be a single value
  // Stored as model version IDs; validated via getGenerationData on apply
  resources   Json?    // e.g., { model: { id: 123 }, resources: [{ id: 456, strength: 0.8 }], vae: { id: 789 } }

  // Visibility
  private     Boolean  @default(true)

  // User's personal ordering
  sortOrder   Int      @default(0)

  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@index([userId])
  @@index([private, ecosystems])
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
   - `generationPreset.getOwn` — list current user's presets
   - `generationPreset.getById` — get a single preset (respects `private` flag)
   - `generationPreset.getPublic` — browse public presets with ecosystem/workflow filters
   - `generationPreset.create` — save a new preset from current graph state
   - `generationPreset.update` — rename, change description, toggle private, update values
   - `generationPreset.delete` — delete own preset
   - `generationPreset.reorder` — update `sortOrder` for user's presets
   - `generationPreset.copy` — copy a public preset to own collection

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
   - User clicks "Save as preset" in generation form
   - Modal: name, description, field picker (which values to include)
   - Auto-detect current ecosystems + workflow for scoping
   - `graph.getSnapshot()` → filter to selected keys → `generationPreset.create`

7. **Load preset flow**
   - Preset selector dropdown/menu in the generation form
   - Filter presets by current ecosystem + workflow compatibility
   - On select: `graph.set(preset.values)`
   - If preset targets a different ecosystem, switch ecosystem first (reuse existing compatibility modal)

8. **Manage presets UI**
   - List view of user's presets with reorder, edit, delete
   - Toggle private/public per preset
   - Accessible from generation form or account settings

### Phase 4: Sharing & Discovery (future)

9. **Browse public presets**
   - Filterable by ecosystem, workflow
   - Copy to own collection

10. **Social features** (optional, later)
    - Copy count tracking
    - User bookmarks (join table)
    - Featured/popular presets

## Key Integration Points

### Saving — `graph.getSnapshot()`

The DataGraph's `getSnapshot()` returns all current node values. To save a preset:

```ts
const snapshot = graph.getSnapshot();
// Filter to only settings keys (exclude model, resources, vae, images, video, prompt)
const settingsKeys = ['sampler', 'steps', 'cfgScale', 'clipSkip', 'aspectRatio', 'seed', 'denoise', ...];
const values = Object.fromEntries(
  settingsKeys.filter(k => k in snapshot).map(k => [k, snapshot[k]])
);
```

### Applying — `graph.set(values)`

The DataGraph's `set()` accepts partial updates. Applying a preset:

```ts
// Check ecosystem compatibility
if (!preset.ecosystems.includes(currentEcosystem)) {
  // Switch ecosystem or show compatibility modal
}
// Apply values — inactive nodes are silently ignored
graph.set(preset.values);
```

### Which keys go where

Per-ecosystem graphs define settings, resources, and prompt nodes. All three categories can be saved to a preset, but resources have special handling:

| Settings (always in `values`) | Resources (optional, in `resources`) | Prompt (optional, in `values`) | Excluded |
|---|---|---|---|
| sampler, steps, cfgScale | model | prompt | images |
| clipSkip, aspectRatio | resources (LoRAs) | negativePrompt | video |
| seed, denoise | vae | | |
| quantity, priority | | | |
| outputFormat | | | |
| Ecosystem-specific: guidance, mode, duration, etc. | | | |

When `resources` is present on a preset, ecosystems must be a single value (enforced on save).

### Prompt handling in presets

Presets can optionally include `prompt` and/or `negativePrompt` values. Because **token order affects weight** in SD-family models (earlier tokens have more influence), presets store a **mode** alongside each prompt value to control how it merges with the user's existing prompt:

```ts
// Inside preset values JSON
{
  // Plain settings — applied directly
  sampler: "DPM++ 2M Karras",
  steps: 25,

  // Prompt values — stored with a merge mode
  prompt: { value: "masterpiece, best quality, detailed", mode: "prepend" },
  negativePrompt: { value: "bad hands, bad anatomy, blurry", mode: "append" },
}
```

**Merge modes:**

| Mode | Behavior | Use case |
|---|---|---|
| `prepend` | Insert before existing prompt, separated by a comma | Style tokens that need high weight |
| `append` | Insert after existing prompt, separated by a comma | Quality tags, negative prompt boilerplate |
| `replace` | Overwrite existing prompt entirely | Full template prompts |

The preset **author** chooses the mode during save — they know whether their tokens are meant to lead (high weight) or supplement (low weight). The preset consumer just clicks "apply" and the merge happens automatically.

**Apply logic:**

```ts
function applyPromptPreset(
  existing: string,
  preset: { value: string; mode: 'prepend' | 'append' | 'replace' }
): string {
  if (preset.mode === 'replace' || !existing.trim()) return preset.value;
  const separator = ', ';
  return preset.mode === 'prepend'
    ? preset.value + separator + existing
    : existing + separator + preset.value;
}
```

@dev: Need to consult domain experts on whether a comma or `\n` is the right separator for certain ecosystems. Also worth confirming weight-by-position behavior across SD, Flux, and video models — the merge mode concept should hold regardless, but defaults might vary.

## Design Decisions

### Two preset types: settings-only vs resource presets

**Settings-only presets** (no `resources` field):
- Can target multiple ecosystems (e.g., all SD-family share sampler/steps/cfgScale nodes)
- Portable and always applicable — no availability concerns
- Good for style configs, quality profiles, speed presets

**Resource presets** (`resources` field present):
- Locked to a **single ecosystem** — enforced on save, since a model/LoRA is only valid for one ecosystem
- On apply, resource availability is validated via `getGenerationData` from `generation.service.ts`
- If a resource is unavailable (deleted, restricted, can't generate), the user is shown a warning with options:
  - Apply settings only (skip resources)
  - Cancel
- This reuses the same substitution/validation pattern that remix already uses in `GenerationFormProvider`

### Scoping by ecosystem array + workflow array

A preset scoped to `ecosystems: ['SDXL', 'Pony', 'Illustrious']` means the values are compatible with all SD-family ecosystems (they share the same node set). The `workflows` array scopes to specific workflow keys like `image:create` or `image:animate`.

This aligns with how the storage adapter already groups ecosystems (ecosystem groups in `GenerationFormProvider`) and how workflow compatibility is checked.

### Private by default

Presets start private. Users explicitly publish them. This is the safer default and avoids accidental sharing of work-in-progress settings.
