# Guide: Adding New Base Models & Ecosystems

**Purpose**: This guide provides step-by-step instructions and critical questions for adding new base models and ecosystems to `basemodel.constants.ts`.

**When to use**: When a new AI model needs to be added to the platform for generation, training, or auction support.

---

## Table of Contents
1. [Overview & Key Concepts](#overview--key-concepts)
2. [Decision Tree](#decision-tree)
3. [Information Gathering Questions](#information-gathering-questions)
4. [Step-by-Step Implementation](#step-by-step-implementation)
5. [Examples](#examples)
6. [Validation Checklist](#validation-checklist)

---

## Overview & Key Concepts

### Architecture Components

The basemodel.constants.ts file uses an ecosystem-based architecture with these key components:

1. **Ecosystems** (`EcosystemRecord`): Organizational units representing model families
   - Has: `id`, `key`, `name`, `displayName`, `description`, `parentEcosystemId`, `familyId`, `sortOrder`
   - Example: "SDXL", "Flux1", "WanVideo14B_T2V"
   - Can have parent-child relationships (e.g., Pony is a child of SDXL)

2. **Base Models** (`BaseModelRecord`): Specific model variants within an ecosystem
   - Has: `id`, `name`, `description`, `type` (image/video), `ecosystemId`, `licenseId`, `hidden`, `disabled`, `experimental`
   - Example: "SDXL 1.0", "Flux.1 D", "Wan Video 14B t2v"
   - Always belongs to exactly one ecosystem

3. **Ecosystem Support** (`EcosystemSupport`): Defines what model types each ecosystem supports
   - Supports: `generation`, `training`, `auction`
   - Model types: `Checkpoint`, `LORA`, `TextualInversion`, `Controlnet`, etc.
   - Can be disabled with `disabled: true`

4. **Ecosystem Settings** (`EcosystemSettings`): Default parameters for generation
   - `model` (default checkpoint), `modelLocked`, `engine` (orchestrator engine identifier)

5. **Cross-Ecosystem Rules** (`CrossEcosystemRule`): Defines partial compatibility between ecosystems
   - Example: SD1 TextualInversion works in SDXL
   - Always `support: 'partial'`

6. **Licenses** (`LicenseRecord`): Legal terms for model usage
   - Has: `id`, `name`, `url`, `notice`, `poweredBy`, `disableMature`

---

## Decision Tree

```
New Model Request
    │
    ├─ Is this a new family/brand? (e.g., first Google model, first ByteDance model)
    │  └─ YES: Create new ECOSYSTEM + BASE MODEL + FAMILY (if needed)
    │
    ├─ Is this a variant of existing ecosystem? (e.g., Flux.2 Klein 9B vs Flux.1)
    │  └─ YES: Create new ECOSYSTEM + BASE MODEL (variant)
    │
    ├─ Is this a fine-tune/derivative of existing model? (e.g., Pony based on SDXL)
    │  └─ YES: Create new ECOSYSTEM (child) + BASE MODEL
    │
    └─ Is this just a checkpoint within existing ecosystem? (e.g., SDXL 0.9 vs SDXL 1.0)
       └─ YES: Create BASE MODEL only
```

---

## Information Gathering Questions

### Essential Questions (Always Ask)

1. **What is the model name?**
   - Full official name (e.g., "Flux.2 Klein 9B", "Wan Video 2.5 T2V")
   - How should it display in UI? (displayName)

2. **What type of media does it generate?**
   - `image` or `video`?

3. **What ecosystem does it belong to?**
   - Is it part of an existing family (SDXL, Flux, WanVideo, etc.)?
   - Or is this a completely new ecosystem?

4. **What is the license?**
   - Open source? What license? (Apache 2.0, CreativeML, etc.)
   - Commercial restrictions?
   - NSFW restrictions? (`disableMature: true`)
   - License URL/documentation?
   - Any required notices or powered-by text?

5. **What model types does it support?**
   - Checkpoint only? (`checkpointOnly`)
   - Checkpoint + LORA? (`checkpointAndLora`)
   - Full addon support? (Checkpoint, LORA, TextualInversion, Controlnet, etc.) (`fullAddonTypes`)
   - LORA only? (`loraOnly`)

6. **What capabilities does it have?**
   - Generation support? (yes/no)
   - Training support? (can users train LoRAs on it?)
   - Auction support? (can it be used in bounties/auctions?)

### Contextual Questions (Ask When Relevant)

7. **Is this model ready for production?**
   - Should it be hidden initially? (`hidden: true`)
   - Is it experimental/beta? (`experimental: true`)
   - Is it completely disabled? (`disabled: true`)

8. **Parent/Child Relationships**
   - Is this a fine-tune of another ecosystem? (e.g., Pony is child of SDXL)
   - Should it inherit support from parent?
   - If yes, what is the parent ecosystem?

9. **Cross-Ecosystem Compatibility**
   - Can resources from other ecosystems work with this model?
   - Examples: Can SD1 embeddings work here? Can Flux1 LORAs work here?
   - Which specific model types are compatible?

10. **Default Generation Settings**
    - What engine should be used? (e.g., "wan", "hunyuan", "veo3", "sora2")
    - Default sampler? (e.g., "Euler a", "DPM++ 2M Karras")
    - Default steps? CFG scale?
    - Default resolution (width x height)?
    - Is the model/checkpoint locked (user cannot change it)? Common for video models.

11. **Family Grouping**
    - Should this be grouped with related models in the UI?
    - What family does it belong to?
      - Flux Family (familyId: 1)
      - Stable Diffusion Family (familyId: 2)
      - Google Models (familyId: 3)
      - New family?

12. **Sort Order**
    - Where should this appear in lists relative to similar models?

---

## Step-by-Step Implementation

### Step 1: Add Ecosystem ID Constant (if new ecosystem)

**Location**: Line ~111 in `ECO` constant object

```typescript
export const ECO = {
  // ... existing ecosystems ...

  NewEcosystem: 59, // Use next available ID
} as const;
```

**ID Ranges**:
- 1-99: Root ecosystems
- 100-199: Child ecosystems (SDXL derivatives)
- 200-299: Child ecosystems (AuraFlow derivatives)

### Step 2: Add Base Model ID Constant

**Location**: Line ~1535 in `BM` constant object

```typescript
export const BM = {
  // ... existing base models ...

  NewModel: 100, // Use next available ID
} as const;
```

### Step 3: Add License (if new license)

**Location**: Line ~1632 in `licenses` array

```typescript
{
  id: 25, // Next available ID
  name: 'License Name',
  url: 'https://...',
  notice: 'Optional legal notice text',
  poweredBy: 'Optional powered by text',
  disableMature: true, // If NSFW content is restricted
},
```

### Step 4: Add Ecosystem Family (if new family)

**Location**: Line ~1792 in `ecosystemFamilies` array

```typescript
{
  id: 5, // Next available ID
  name: 'Family Name',
  description: 'Brief description of this model family',
},
```

### Step 5: Add Ecosystem Record

**Location**: Line ~190 in `ecosystems` array (grouped by family)

```typescript
{
  id: ECO.NewEcosystem,
  key: 'NewEcosystem',               // Stable identifier (no spaces)
  name: 'newecosystem',              // Lowercase for matching
  displayName: 'New Ecosystem',      // Human-readable name for UI
  description: 'Brief description',  // Optional: for UI tooltips/help
  parentEcosystemId: ECO.Parent,     // Optional: if this is a child ecosystem
  familyId: 1,                       // Optional: for UI grouping
  sortOrder: 10,                     // Optional: for UI ordering
},
```

### Step 6: Add Base Model Record

**Location**: Line ~1883 in `baseModelRecords` array (grouped by ecosystem)

```typescript
{
  id: BM.NewModel,
  name: 'New Model Name',
  description: 'Model description for UI',
  type: 'image', // or 'video'
  ecosystemId: ECO.NewEcosystem,
  licenseId: 13, // Reference to license
  hidden: false, // Set to true to hide from activeBaseModels
  disabled: false, // Set to true to completely disable
  experimental: false, // Set to true to show experimental warning
},
```

### Step 7: Add Ecosystem Support

**Location**: Line ~713 in `ecosystemSupport` array

**Common patterns**:
```typescript
// Pattern 1: Checkpoint only (most API/closed-source models)
{
  ecosystemId: ECO.NewEcosystem,
  supportType: 'generation',
  modelTypes: checkpointOnly
},

// Pattern 2: Checkpoint + LORA (common for open models)
{
  ecosystemId: ECO.NewEcosystem,
  supportType: 'generation',
  modelTypes: checkpointAndLora
},
{
  ecosystemId: ECO.NewEcosystem,
  supportType: 'training',
  modelTypes: [ModelType.LORA]
},

// Pattern 3: Full addon support (SD-based models)
{
  ecosystemId: ECO.NewEcosystem,
  supportType: 'generation',
  modelTypes: fullAddonTypes
},
{
  ecosystemId: ECO.NewEcosystem,
  supportType: 'training',
  modelTypes: [ModelType.LORA]
},
{
  ecosystemId: ECO.NewEcosystem,
  supportType: 'auction',
  modelTypes: checkpointAndLora
},

// Pattern 4: LORA only (for models that require a base checkpoint)
{
  ecosystemId: ECO.NewEcosystem,
  supportType: 'generation',
  modelTypes: loraOnly
},

// Pattern 5: Disabled (model exists but generation is disabled)
{
  ecosystemId: ECO.NewEcosystem,
  supportType: 'generation',
  modelTypes: checkpointOnly,
  disabled: true
},
```

**Available model type arrays**:
- `checkpointOnly` = `[ModelType.Checkpoint]`
- `loraOnly` = `[ModelType.LORA]`
- `checkpointAndLora` = `[ModelType.Checkpoint, ModelType.LORA]`
- `fullAddonTypes` = `[ModelType.Checkpoint, ModelType.LORA, ModelType.TextualInversion, ModelType.Controlnet]`

### Step 8: Add Ecosystem Settings (if needed)

**Location**: Line ~845 in `ecosystemSettings` array

**When to add**: If the model needs specific default parameters or engine configuration.

```typescript
{
  ecosystemId: ECO.NewEcosystem,
  defaults: {
    engine: 'engineName',      // Orchestrator engine identifier (required for video models)
    modelLocked: true,         // Optional: true for video models (user can't change base)
    model: { id: BM.NewModel },// Optional: default checkpoint model
  },
},
```

**Note**: Generation parameters like sampler, steps, CFG, and resolution are configured in data-graph workflow configs, not in ecosystem settings.

**Common engines**:
- `'wan'` - WanVideo models
- `'hunyuan'` - Hunyuan models
- `'veo3'` - Veo3
- `'vidu'` - Vidu
- `'kling'` - Kling
- `'seedance'` - Seedance
- `'lightricks'` - LTXV
- `'ltx2'` - LTXV2/LTXV2.3

### Step 9: Add Cross-Ecosystem Rules (if applicable)

**Location**: Line ~1187 in `crossEcosystemRules` array

**When to add**: When resources from one ecosystem can work (with partial support) in another.

```typescript
{
  sourceEcosystemId: ECO.SourceEcosystem,
  targetEcosystemId: ECO.NewEcosystem,
  supportType: 'generation',
  modelTypes: [ModelType.LORA], // or other types
  support: 'partial', // Always 'partial'
},
```

**Common cross-ecosystem patterns**:
- SD1 TextualInversion → SDXL family
- SDXL ↔ Pony/Illustrious/NoobAI (`sdxlCrossAddonTypes` — parent↔child, includes VAE)
- Pony ↔ Illustrious ↔ NoobAI (`sdxlSiblingAddonTypes` — siblings, no VAE)
- Flux1 ↔ FluxKrea (LORA + Checkpoint)
- WanVideo 2.2 LORA → WanVideo 14B variants

---

## Examples

### Example 1: New Closed-Source API Model (Checkpoint Only)

**Scenario**: Adding "Imagen 5" from Google

**Answers**:
1. Name: "Imagen 5"
2. Type: image
3. Ecosystem: New ecosystem (Imagen5)
4. License: Google proprietary (id: 21)
5. Model types: Checkpoint only
6. Capabilities: Generation only
7. Ready: Yes, not hidden
8. Parent: None
9. Cross-ecosystem: None
10. Settings: No special engine needed
11. Family: Google Models (familyId: 3)

**Implementation**:
```typescript
// 1. Add ecosystem ID
export const ECO = {
  // ...
  Imagen5: 60,
} as const;

// 2. Add base model ID
export const BM = {
  // ...
  Imagen5: 101,
} as const;

// 3. License already exists (Google proprietary, id: 21)

// 4. Family already exists (Google Models, familyId: 3)

// 5. Add ecosystem
ecosystems: [
  // ... in Google family section ...
  {
    id: ECO.Imagen5,
    key: 'Imagen5',
    name: 'imagen5',
    displayName: 'Imagen 5',
    description: 'Google\'s latest text-to-image model',
    familyId: 3,
    sortOrder: 22,
  },
]

// 6. Add base model
baseModelRecords: [
  // ... in Imagen section ...
  {
    id: BM.Imagen5,
    name: 'Imagen5',
    description: 'Text-to-image model with enhanced capabilities',
    type: 'image',
    ecosystemId: ECO.Imagen5,
    licenseId: 21,
  },
]

// 7. Add support
ecosystemSupport: [
  // ...
  { ecosystemId: ECO.Imagen5, supportType: 'generation', modelTypes: checkpointOnly },
]

// 8. No settings needed (standard image generation)
// 9. No cross-ecosystem rules needed
```

### Example 2: New Open-Source Model (Checkpoint + LORA)

**Scenario**: Adding "DreamFlow 1.0" - open-source image model

**Answers**:
1. Name: "DreamFlow 1.0"
2. Type: image
3. Ecosystem: New ecosystem (DreamFlow)
4. License: Apache 2.0 (id: 13)
5. Model types: Checkpoint + LORA
6. Capabilities: Generation + Training + Auction
7. Ready: Yes
8. Parent: None
9. Cross-ecosystem: None initially
10. Settings: None (standard defaults)
11. Family: New family

**Implementation**:
```typescript
// 1. Add ecosystem ID
export const ECO = {
  // ...
  DreamFlow: 61,
} as const;

// 2. Add base model ID
export const BM = {
  // ...
  DreamFlow10: 102,
} as const;

// 3. License exists (Apache 2.0, id: 13)

// 4. Add new family
ecosystemFamilies: [
  // ...
  { id: 6, name: 'DreamFlow', description: 'Open-source creative generation models' },
]

// 5. Add ecosystem
ecosystems: [
  // ...
  {
    id: ECO.DreamFlow,
    key: 'DreamFlow',
    name: 'dreamflow',
    displayName: 'DreamFlow',
    description: 'Open-source creative text-to-image model',
    familyId: 6,
    sortOrder: 0,
  },
]

// 6. Add base model
baseModelRecords: [
  // ...
  {
    id: BM.DreamFlow10,
    name: 'DreamFlow 1.0',
    description: 'First generation DreamFlow model',
    type: 'image',
    ecosystemId: ECO.DreamFlow,
    licenseId: 13,
  },
]

// 7. Add support (full support: generation, training, auction)
ecosystemSupport: [
  // ...
  { ecosystemId: ECO.DreamFlow, supportType: 'generation', modelTypes: checkpointAndLora },
  { ecosystemId: ECO.DreamFlow, supportType: 'training', modelTypes: [ModelType.LORA] },
  { ecosystemId: ECO.DreamFlow, supportType: 'auction', modelTypes: checkpointAndLora },
]

// 8. No special settings needed
// 9. No cross-ecosystem rules initially
```

### Example 3: Video Model with Engine

**Scenario**: Adding "VidGen Pro" - proprietary video model

**Answers**:
1. Name: "VidGen Pro"
2. Type: video
3. Ecosystem: New (VidGenPro)
4. License: Custom proprietary
5. Model types: Checkpoint only
6. Capabilities: Generation only
7. Ready: Yes
8. Parent: None
9. Cross-ecosystem: None
10. Settings: Requires engine "vidgen", model locked, default resolution 1280x720
11. Family: New family

**Implementation**:
```typescript
// 1. Add ecosystem ID
export const ECO = {
  // ...
  VidGenPro: 62,
} as const;

// 2. Add base model ID
export const BM = {
  // ...
  VidGenPro: 103,
} as const;

// 3. Add new license
licenses: [
  // ...
  {
    id: 26,
    name: 'VidGen Pro License',
    url: 'https://vidgen.com/license',
    notice: 'VidGen Pro is licensed for commercial use with attribution.',
    poweredBy: 'Powered by VidGen',
  },
]

// 4. Add new family
ecosystemFamilies: [
  // ...
  { id: 7, name: 'VidGen', description: 'VidGen video generation models' },
]

// 5. Add ecosystem
ecosystems: [
  // ...
  {
    id: ECO.VidGenPro,
    key: 'VidGenPro',
    name: 'vidgenpro',
    displayName: 'VidGen Pro',
    description: 'Professional video generation model',
    familyId: 7,
    sortOrder: 0,
  },
]

// 6. Add base model
baseModelRecords: [
  // ...
  {
    id: BM.VidGenPro,
    name: 'VidGen Pro',
    description: 'Professional-grade text-to-video generation',
    type: 'video',
    ecosystemId: ECO.VidGenPro,
    licenseId: 26,
  },
]

// 7. Add support
ecosystemSupport: [
  // ...
  { ecosystemId: ECO.VidGenPro, supportType: 'generation', modelTypes: checkpointOnly },
]

// 8. Add settings (REQUIRED for video models with custom engine)
ecosystemSettings: [
  // ...
  {
    ecosystemId: ECO.VidGenPro,
    defaults: {
      engine: 'vidgen',
      modelLocked: true, // User cannot change the base model
      model: { id: BM.VidGenPro }, // Default checkpoint
    },
  },
]
// Note: Resolution, sampler, steps, CFG are configured in data-graph workflow configs

// 9. No cross-ecosystem rules
```

### Example 4: Child Ecosystem (Fine-tune)

**Scenario**: Adding "AnimeXL" - a fine-tune of SDXL specialized for anime

**Answers**:
1. Name: "AnimeXL"
2. Type: image
3. Ecosystem: Child of SDXL
4. License: Same as SDXL (CreativeML Open RAIL++-M, id: 3)
5. Model types: Inherits from SDXL (full addon support)
6. Capabilities: Inherits from SDXL (generation, training, auction)
7. Ready: Yes
8. Parent: SDXL (ECO.SDXL)
9. Cross-ecosystem: Inherits SDXL cross-ecosystem rules
10. Settings: Uses SDXL defaults
11. Family: Stable Diffusion Family (familyId: 2)

**Implementation**:
```typescript
// 1. Add ecosystem ID (child ecosystem range: 100-199 for SDXL derivatives)
export const ECO = {
  // ...
  AnimeXL: 103,
} as const;

// 2. Add base model ID
export const BM = {
  // ...
  AnimeXL: 104,
} as const;

// 3. License exists (id: 3)

// 4. Family exists (Stable Diffusion, familyId: 2)

// 5. Add ecosystem WITH parentEcosystemId
ecosystems: [
  // ... in SDXL family section ...
  {
    id: ECO.AnimeXL,
    key: 'AnimeXL',
    name: 'animexl',
    displayName: 'AnimeXL',
    description: 'SDXL fine-tuned for anime-style generation',
    parentEcosystemId: ECO.SDXL, // IMPORTANT: marks as child
    familyId: 2,
    sortOrder: 15,
  },
]

// 6. Add base model
baseModelRecords: [
  // ... in SDXL section ...
  {
    id: BM.AnimeXL,
    name: 'AnimeXL',
    description: 'SDXL model specialized for anime and manga styles',
    type: 'image',
    ecosystemId: ECO.AnimeXL,
    licenseId: 3,
  },
]

// 7. NO ecosystem support needed - inherits from parent (SDXL)
// Child ecosystems automatically inherit parent's support configuration

// 8. NO settings needed - uses parent defaults

// 9. Cross-ecosystem rules are EXPLICIT - they do NOT inherit from parent
// You must add rules for each ecosystem that needs cross-compatibility
// Use sdxlCrossAddonTypes for parent↔child (includes VAE)
// Use sdxlSiblingAddonTypes for sibling↔sibling (no VAE)
{ sourceEcosystemId: ECO.SDXL, targetEcosystemId: ECO.AnimeXL, supportType: 'generation', modelTypes: sdxlCrossAddonTypes, support: 'partial' },
{ sourceEcosystemId: ECO.AnimeXL, targetEcosystemId: ECO.SDXL, supportType: 'generation', modelTypes: sdxlCrossAddonTypes, support: 'partial' },
// Also add sibling rules with other SDXL children (Pony, Illustrious, NoobAI, etc.)
```

---

## Validation Checklist

After adding a new model, verify:

### Code Completeness
- [ ] Added ecosystem ID constant in `ECO` object (if new ecosystem)
- [ ] Added base model ID constant in `BM` object
- [ ] Added license record (if new license)
- [ ] Added ecosystem family record (if new family)
- [ ] Added ecosystem record in `ecosystems` array
- [ ] Added base model record in `baseModelRecords` array
- [ ] Added ecosystem support in `ecosystemSupport` array
- [ ] Added ecosystem settings in `ecosystemSettings` array (if needed)
- [ ] Added cross-ecosystem rules in `crossEcosystemRules` array (if applicable)

### ID Management
- [ ] Used unique, sequential IDs (no conflicts)
- [ ] Used appropriate ID range (1-99 for root, 100+ for children)
- [ ] No duplicate ecosystem keys
- [ ] No duplicate base model names within ecosystem

### Correctness
- [ ] Media type matches model capability (image vs video)
- [ ] License restrictions match model terms
- [ ] Model types array matches actual support
- [ ] Parent-child relationship correct (if child ecosystem)
- [ ] Settings appropriate for model type (engine for video, etc.)
- [ ] Cross-ecosystem rules make technical sense

### Testing
- [ ] TypeScript compiles without errors (`pnpm run typecheck`)
- [ ] Model appears in `baseModels` array export
- [ ] Model appears in `activeBaseModels` if not hidden
- [ ] Ecosystem appears in `baseModelGroups` array export
- [ ] `getBaseModelGenerationConfig()` includes new ecosystem (if has generation support)
- [ ] `getGenerationBaseModelConfigs()` includes new ecosystem (if has generation support)

### Documentation
- [ ] Updated this guide with new patterns (if introducing new pattern)
- [ ] Added example if significantly different from existing models
- [ ] Documented any special considerations in code comments

---

## Common Patterns Quick Reference

### Pattern: Standard Open-Source Image Model
```typescript
// Ecosystem: New root ecosystem
// Support: Checkpoint + LORA for generation, LORA for training, auction support
// License: Apache 2.0 or CreativeML
```

### Pattern: Closed-Source API Model
```typescript
// Ecosystem: New root ecosystem
// Support: Checkpoint only for generation
// License: Proprietary
// Hidden: May start hidden (hidden: true) until ready
```

### Pattern: Video Model
```typescript
// Ecosystem: New root ecosystem
// Support: Checkpoint only or Checkpoint + LORA
// Settings: MUST have engine, usually modelLocked: true
// License: Varies
```

### Pattern: Fine-tune/Derivative
```typescript
// Ecosystem: Child ecosystem (set parentEcosystemId)
// Support: Inherits from parent (no explicit support needed)
// License: Often same as parent
```

### Pattern: Experimental/Beta Model
```typescript
// Base Model: experimental: true
// May also be: hidden: true initially
```

### Pattern: Deprecated/Disabled Model
```typescript
// Base Model: disabled: true
// Ecosystem Support: disabled: true (if just disabling generation)
```

---

## Notes

### Hidden vs Disabled
- **Hidden** (`hidden: true`): Model exists but doesn't appear in activeBaseModels. Can still have generation/training support via API.
- **Disabled** (`disabled: true`): Completely disables ALL functionality (generation, training, auction). Model is deprecated.

### Model Types
- **Checkpoint**: The base model itself
- **LORA**: Low-Rank Adaptation (fine-tuning method)
- **TextualInversion**: Embedding/concept injection
- **Controlnet**: Conditional control (pose, depth, etc.)
- **Hypernetwork**: Neural network modifier
- **VAE**: Variational Autoencoder (color/detail adjustment)
- **Upscaler**: Resolution enhancement
- **MotionModule**: Animation/motion control
- **Poses**: Pose templates
- **Wildcards**: Dynamic prompt templates
- **Workflows**: Complete generation pipelines

### Support Types
- **generation**: Model can be used for image/video generation
- **training**: Users can train LoRAs on this model
- **auction**: Model can be used in bounties/competitions

### Inheritance
- Child ecosystems (with `parentEcosystemId`) automatically inherit:
  - Ecosystem support configuration
  - Ecosystem settings (defaults)
- Cross-ecosystem rules are **NOT inherited** — they must be added explicitly for each ecosystem pair
- Use `sdxlCrossAddonTypes` (includes VAE) for parent↔child rules and `sdxlSiblingAddonTypes` (no VAE) for sibling↔sibling rules

---

## Getting Help

If you encounter any of these situations:
1. **Unclear license terms** → Ask user for official license URL and restrictions
2. **Unknown model architecture** → Ask if it's compatible with existing ecosystems
3. **Uncertain about compatibility** → Conservative approach: no cross-ecosystem rules initially
4. **New model type** → Check if it's a variant of existing types or truly new
5. **Complex parent-child relationship** → Verify technical compatibility with parent

**Always prefer asking clarifying questions over making assumptions.**
