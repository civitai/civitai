---
name: add-ecosystem
description: Add a new ecosystem and base model to basemodel.constants.ts. Use when onboarding a new model family from providers like Baidu, ByteDance, Google, etc. Handles ECO constants, BM constants, ecosystem record, family (creates new if needed), license (creates new if needed), and base model record. Optionally triggers add-generation-support at the end.
---

# Add Ecosystem

Adds a new ecosystem and base model entry to [basemodel.constants.ts](src/shared/constants/basemodel.constants.ts). Everything else downstream (generation support, graph, handler, workflow wiring) is handled by the **add-generation-support** skill.

## When to use

Use when a new model provider or variant is being added to Civitai — e.g., new provider (Baidu's Ernie), new architecture (Flux's Kontext), or a distinct variant of an existing family that should appear as its own selection in the UI.

## Workflow (interactive after research)

Do research first, then ask the user only for what can't be inferred.

### 1. Gather model info

Ask the user for the model name and a reference link (HuggingFace page, official repo, announcement). Then research before asking anything else:

- **WebFetch** the reference link to extract:
  - Provider/company (drives family selection)
  - License (match against existing `licenses` array or flag as new)
  - Model type (`image` vs `video` — sometimes both)
  - Short description for the base model record
- Search the codebase for prior patterns: `Grep` for the provider name to see if a family already exists

### 2. Pick IDs

Read the current state of [basemodel.constants.ts](src/shared/constants/basemodel.constants.ts) to determine the next available IDs. Use Read with offsets — don't load the whole file.

- **`ECO.<Name>`**: next available ecosystem ID. Groupings in `ECO`:
  - Image models: 1-50 range (first come, first served; find next gap)
  - Video models: 47-66 range
  - Utility: 66+
  - Child ecosystems (`parentEcosystemId` set): 100+ for SDXL children, 200+ for AuraFlow children
  - Pick the next unused number within the appropriate block
- **`BM.<Name>`**: next available base model ID. Read the `BM` constant block, find the next unused number.
- **Family ID**: try to match an existing family in `ecosystemFamilies`. If none match, propose creating a new one (confirm with user).
- **License ID**: try to match an existing license in `licenses` by name/URL. If none match, create a new entry (confirm with user).
- **`sortOrder`**: follow the pattern of the family. Image family numbers are usually sequential starting from an offset tied to the family. If the family has existing ecosystems, use the next number in its block. If new family, start at a round number (10, 20, 30, etc. — match surrounding patterns).

### 3. Confirm the plan with the user

Before editing, present a summary:

```
Adding ecosystem: <DisplayName>
- ECO.<Name> = <id>
- BM.<Name> = <id>
- Family: <existing family name> (familyId: <id>) OR [new: <name>]
- License: <existing license name> (licenseId: <id>) OR [new: <name>, <url>]
- Type: image | video
- sortOrder: <n>
- Description: "<short description>"
```

Wait for user confirmation. Accept corrections.

### 4. Make the edits

Apply all changes in one pass:

1. **`ECO` constant**: add the new key under the appropriate section comment (e.g., `// Baidu` for Ernie). Keep sections grouped.
2. **`BM` constant**: add the new key in the matching block.
3. **`ecosystemFamilies`** (only if creating new): append at the end. Use the next family ID.
4. **`licenses`** (only if creating new): append at the end. Use the next license ID.
5. **`ecosystems`**: add the new `EcosystemRecord` under the right family's section comment. Include `parentEcosystemId` only if it's a child ecosystem (rare).
6. **`baseModelRecords`**: add the new `BaseModelRecord` in alphabetical or thematic position (scan existing entries for the pattern).

### 5. Typecheck

```bash
pnpm run typecheck
```

If it fails, fix the error and re-run. Don't continue until clean.

### 6. Offer generation support

After the ecosystem is added and typecheck passes, ask:

> Do you want to add generation support now? This wires the ecosystem into the generation form with a graph, handler, and workflow config. (Runs the `add-generation-support` skill.)

If yes, invoke the `add-generation-support` skill. If no, stop — the ecosystem record alone is enough for it to appear in model listings.

## Record structures

### `EcosystemRecord`
```ts
{
  id: ECO.<Name>,
  key: '<Name>',                // Stable identifier (e.g., 'Ernie')
  name: '<name>',               // lowercase (e.g., 'ernie')
  displayName: '<Display Name>', // UI (e.g., 'Ernie')
  familyId: <id>,
  sortOrder: <n>,
  parentEcosystemId?: <id>,     // Only for child ecosystems
  description?: string,         // Rarely needed
}
```

### `BaseModelRecord`
```ts
{
  id: BM.<Name>,
  name: '<Name>',
  description: "<Provider>'s <type> generation model",
  type: 'image' | 'video' | ['image', 'video'],
  ecosystemId: ECO.<Name>,
  licenseId: <id>,
  hidden?: boolean,      // true if not user-facing yet
  experimental?: boolean,
  disabled?: boolean,
}
```

### `BaseModelFamilyRecord` (create only if needed)
```ts
{
  id: <next id>,
  name: '<Provider Name>',
  description: "<Provider>'s <description of product lineup>",
}
```

### `LicenseRecord` (create only if needed)
```ts
{
  id: <next id>,
  name: '<License Name>',       // Exact name from the source
  url: '<canonical license URL>',
  notice?: string,              // Only if the license requires a copyright notice
  poweredBy?: string,           // Only if attribution is required
  disableMature?: boolean,      // Only if the license prohibits NSFW
}
```

## Notes

- **Do not** add to `ecosystemSupport`, `ecosystemSettings`, workflows, graph, or handler files in this skill — those are generation-support concerns and belong to the `add-generation-support` skill.
- **Do not** skip the typecheck step. The base model records are validated against ecosystem IDs, and a mismatch breaks the entire constants file.
- If a new ecosystem is a child of an existing one (e.g., fine-tunes of SDXL), set `parentEcosystemId` and use a sort order from the child range (100+, 200+).
- `name` (lowercase) is used for matching against orchestrator responses — keep it consistent with what the orchestrator returns.

## Examples of past additions

- **Ernie** (Baidu, image): new family, new license; ECO.Ernie = 67, BM.Ernie = 83, familyId 17, licenseId 13 (Apache 2.0 — matched existing).
- **Seedance** (ByteDance, video): family 12 (ByteDance — existed), licenseId 23 (Seedream — shared with Seedream since ByteDance uses the same agreement).
