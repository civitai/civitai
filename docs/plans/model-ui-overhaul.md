# UI Overhaul to Support Quants & Base Model Types

**Session ID:** 62c4ea14-8388-48c4-8611-ec3a66e74ed3
**ClickUp Issue:** [868h3r3bx](https://app.clickup.com/t/868h3r3bx)
**Created:** 2026-01-15

---

## Problem Summary

Civitai's current Model → Version paradigm was designed for single-file checkpoints evolving over time. The ecosystem has since become modular and component-based. The existing UI and data model no longer map cleanly to how models are created, distributed, or consumed.

### Core Problems

1. **Overloaded "Version" concept** - A version can mean:
   - A true iteration (v1, v2, v3)
   - A different file format of the same weights
   - A required component (VAE, text encoder)
   - An optional helper (workflow, config, example)

2. **Poor discoverability** - Users cannot easily tell:
   - Which file is the primary model
   - Which files are required to run it
   - Which files are optional

3. **Misuse of versions as workaround** - Creators upload VAEs, workflows, encoders as "versions" because there's no better place.

4. **Quantization doesn't fit** - Auto-generated quants would flood the UI if treated as versions.

5. **Legacy terminology** - "Checkpoint" implies monolithic bundles, but modern pipelines separate UNets, text encoders, VAEs, workflows.

---

## Current Data Model Analysis

### Database Structure

```
Model (ModelType: Checkpoint, LORA, VAE, etc.)
  └─ ModelVersion (name, baseModel, baseModelType, vaeId)
       └─ ModelFile (type, metadata: {format, size, fp})
```

### Current ModelFile Types
```typescript
['Model', 'Text Encoder', 'Pruned Model', 'Negative', 'Training Data', 'VAE', 'Config', 'Archive']
```

### Current File Metadata
```typescript
{
  format: 'SafeTensor' | 'PickleTensor' | 'GGUF' | 'Diffusers' | 'Core ML' | 'ONNX',
  size: 'full' | 'pruned',
  fp: 'fp32' | 'fp16' | 'bf16' | 'fp8' | 'nf4'  // This is essentially quantization level
}
```

### Existing Relationships
- `ModelVersion.vaeId` → Links to another ModelVersion (VAE)
- `ModelAssociations` → Generic model-to-model linking
- `RecommendedResource` → Suggested complementary models

### Key Insight
The `fp` field already captures quantization levels (fp32, fp16, fp8, nf4), but:
- Multiple quants are stored as separate `ModelFile` records under the same `ModelVersion`
- The UI doesn't present these as selectable download options
- There's no clear "primary file" indicator

---

## Data Analysis (from Production Database)

### Model Distribution by Type
| Type | Count | % |
|------|-------|---|
| LORA | 709,353 | 91.4% |
| Checkpoint | 25,755 | 3.3% |
| LoCon | 14,553 | 1.9% |
| TextualInversion | 14,328 | 1.8% |
| Workflows | 6,655 | 0.9% |
| Other types | ~5,800 | 0.7% |

**Key insight:** LoRAs dominate the platform. Checkpoint changes will affect only 3% of models but likely a higher % of downloads/traffic.

### Version Usage Patterns
| Versions per Model | Model Count | % |
|--------------------|-------------|---|
| 1 version | 652,223 | 84% |
| 2 versions | 86,105 | 11% |
| 3-5 versions | 31,352 | 4% |
| 6+ versions | 6,760 | <1% |
| 20+ versions | 1,100 | <0.2% |

**Key insight:** 84% of models have only 1 version. The "version misuse" problem affects a minority of models but includes high-profile cases.

### Examples of High Version Counts (Potential Misuse)
| Model | Type | Versions | Pattern |
|-------|------|----------|---------|
| SmhSmh's Styles for Pony | LORA | 180 | Style collection |
| MIHOYO Collection | LORA | 139 | Character collection |
| ControlNetXL | Checkpoint | 131 | Different controlnet variants |
| THE PONYDEX | LORA | 109 | Pokemon character collection |
| 100 United States Senators | LORA | 100 | Person collection |

**Key insight:** High version counts are often "collections" where each "version" is a different subject (character, style, person). This is a valid use case that current UI doesn't support well.

### File Format Distribution
| Format | Count | % |
|--------|-------|---|
| SafeTensor | 881,070 | 97.2% |
| PickleTensor | 17,798 | 2.0% |
| Zip/Diffusers | 5,160 | 0.6% |
| GGUF | 1,023 | 0.1% |
| Other | 1,614 | 0.2% |

**Key insight:** SafeTensors is overwhelmingly dominant. GGUF is currently tiny (1,023 files) but growing with Flux/video models.

### Quantization (fp) Field Usage
| fp + format | Count |
|-------------|-------|
| SafeTensor (no fp set) | 823,899 |
| SafeTensor fp16 | 47,877 |
| PickleTensor (no fp) | 11,645 |
| PickleTensor fp16 | 6,359 |
| SafeTensor fp32 | 4,841 |
| SafeTensor fp8 | 1,999 |
| SafeTensor bf16 | 1,996 |
| GGUF fp16 | 376 |
| GGUF fp8 | 342 |
| SafeTensor nf4 | 236 |
| GGUF nf4 | 138 |
| GGUF bf16 | 128 |

**Key insight:** Only 7% of files have the `fp` field set. The infrastructure exists but isn't being used. This suggests the upload UI doesn't encourage/require it.

### File Variants per Version
| Files per Version | Version Count | % |
|-------------------|---------------|---|
| 1 file | 883,961 | 98.8% |
| 2 files | 10,212 | 1.1% |
| 3-5 files | 512 | <0.1% |
| 6+ files | 68 | <0.01% |

**Key insight:** Almost all versions have exactly 1 file. Versions with multiple files (quant variants) are rare but growing.

### Example: Well-Structured File Variants
Model version with 6 files (same weights, different formats):
```
Furation-Pear-[FULL].safetensors        - fp32 full  (9.1 GB)
Furation-Pear-[FP32-NO-EMA].safetensors - fp32 pruned (5.8 GB)
Furation-Pear-[FULL-BF16].safetensors   - bf16 full  (4.0 GB)
Furation-Pear-[FULL-FP16].safetensors   - fp16 full  (4.0 GB)
Furation-Pear-[BF16-NO-EMA].safetensors - bf16 pruned (2.3 GB)
Furation-Pear-[FP16-NO-EMA].safetensors - fp16 pruned (2.3 GB)
```

**Key insight:** Some creators ARE using the variant system correctly. The UI just doesn't surface it well.

### Wan Video 2.1 - Version Misuse Example
From model 1329096 (cited in the issue):
| Version Name | Purpose | Should Be |
|--------------|---------|-----------|
| wan2.1_t2v_1.3B_fp16 | Main model | Primary file |
| Wan 2.1 VAE | Required component | Component (VAE) |
| umt5_xxl_fp8_e4m3fn_scale | Text encoder | Component (TextEncoder) |
| Clip Vision h | Vision encoder | Component (VisionEncoder) |
| wan2.1_i2v_480p_14B_fp8 | Different resolution variant | File variant |
| wan2.1_i2v_720p_14B_fp8 | Different resolution variant | File variant |

**Key insight:** This model uses 7 "versions" for what should be 1 version with components + variants.

### Existing Relationship Usage
| Feature | Count | Notes |
|---------|-------|-------|
| ModelVersion.vaeId (VAE linked) | 4,910 | Only 0.5% of versions use this |
| ModelAssociations | 475,520 | Heavily used for "suggested" models |
| RecommendedResource | 171,581 | Also heavily used |

**Key insight:** Model linking infrastructure exists and is used. The `vaeId` feature is underutilized (probably because creators don't know about it or the UI doesn't surface it).

### GGUF Distribution
- **Total GGUF files:** 1,027
- **Models with GGUF:** 261 (all Checkpoints)
- **Max GGUF files per model:** 32

Top models by GGUF count:
| Model | GGUF Files |
|-------|------------|
| WAN 2.2 Enhanced NSFW | 32 |
| Chroma GGUF | 25 |
| Nepotism | 23 |
| Flux1-DedistilledMixTuned | 18 |

**Key insight:** GGUF is concentrated in ~261 Checkpoint models, with some having 30+ quant variants. These are the models that will flood the UI if quants are treated as versions.

### Component File Types
| File Type | Count | Model Types |
|-----------|-------|-------------|
| Config | 649 | Mostly Checkpoints (584) |
| Text Encoder | 238 | Mostly LORAs (225) |
| VAE | 0 | (uploaded as separate Models, not files) |

**Key insight:** VAEs are uploaded as separate `Model` entities (type=VAE), not as files within a Checkpoint. This is another form of "working around" the current structure.

---

## Proposals

### Proposal A: File Variants with Grouping (Minimal Schema Change)

**Concept:** Keep the existing schema but add a "file group" concept and UI improvements to better present file variants.

#### Changes

**1. Add `primaryFileId` to ModelVersion**
```prisma
model ModelVersion {
  // ... existing fields
  primaryFileId  Int?  // Points to the "main" ModelFile
}
```

**2. Add file grouping logic**
Files with the same `type` but different `metadata.fp` or `metadata.format` are considered variants of each other.

**3. UI Changes**
- Download button shows primary file by default
- Dropdown expands to show variants (fp16, fp8, GGUF, etc.)
- "Components" section shows Text Encoders, VAEs, Configs separately

#### Pros
- Minimal database changes
- Backwards compatible
- Quick to implement

#### Cons
- Doesn't solve the "version misuse" problem
- Still conflates true versions with file variants
- Components still live under versions

@dev: This seems like it could work. Can you go ahead and maybe mock up what the side panel would look like if we did this? You can use your quick mock-up skill. Be sure to reference the existing UI so you have an idea of what the current layout is like. We don't need it to be exactly the same. Obviously, we're open to change here, but it's just good to understand for context what's over there right now.

@ai: Done! Created initial mockups (v1-v4). See updated mockups below.

@dev: Can you give me two or three versions with interactive dropdowns, Generate as primary action, components as collapsible accordions, and all the version details included?

@ai: Created multiple iterations. Final approved mockups:

#### Final Mockup: Model Detail Sidebar
**[v9-components-grouped.html](./model-ui-overhaul-mockups/model-sidebar.html)** - Complete interactive sidebar with grouped component variants

**Key design decisions:**
- **Generate is primary** - Big blue button at top, Download is secondary below
- **Interactive variant dropdown** - Click to see all variants grouped by format (SafeTensor vs GGUF)
- **Component variants grouped** - Components with multiple precision/quant variants show expandable lists
- **"Best match" auto-selected** - Based on user preferences, with badge indicator
- **Single-variant components** - Show without dropdown (e.g., VAE with only fp16)
- **"Download All Components"** - Downloads user's preferred variant of each component
- **Required Components as accordion** - Yellow warning styling, collapsible
- **Optional Files as accordion** - Muted styling, collapsible
- **Version Details preserved** - Type, Stats, Published date, Base Model, Hash, etc.
- **All actions present** - Share, Like, Vault, Bookmark, Bid, Report
- **Creator Card** - With Tip button
- **License & Permissions** - At bottom with permission icons

Previous iterations: [v8-refined-full-sidebar.html](../working/mockups/model-file-variants/v8-refined-full-sidebar.html) (components not grouped)

#### Final Mockup: File Upload UI
**[v4-components-with-precision.html](./model-ui-overhaul-mockups/file-upload.html)** - Sectioned file upload with full precision/quant/format support

**Key design decisions:**
- **Three sections:** Model Files, Required Components (yellow warning), Optional Files
- **No primary toggle** - User preferences auto-select the best file
- **Components have same dropdowns as model files:**
  - SafeTensor: Type + Precision (fp16, fp8, bf16, fp32)
  - GGUF: Type + Quant (Q8_0, Q6_K, Q5_K_M, Q4_K_M)
  - ZIP: Type + Format (Diffusers, Core ML, ONNX) + Precision
- **Multiple variants per component** - e.g., Text Encoder fp16 AND fp8
- **Components are upload OR link** - Dropzone for upload, separate "Link to Existing Model" button
- **Link Modal with type-first flow** - Select type → Search models → Pick version → Pick file
- **Tips section** - Educates users on proper file organization

Previous iterations: [v3-with-component-types.html](../working/mockups/file-upload/v3-with-component-types.html), [v2-refined.html](../working/mockups/file-upload/v2-refined.html)

---

### Proposal B: Introduce "Release" Layer (Medium Schema Change)

**Concept:** Add a new `ModelRelease` entity between Model and ModelVersion. Versions become "file variants" under releases.

#### New Hierarchy
```
Model (identity)
  └─ ModelRelease (v1.0, v2.0 - true iterations)
       ├─ ModelFile (primary model files, variants)
       └─ ModelComponent (VAE, Text Encoder, Config, Workflow)
```

#### Schema Changes

**1. New ModelRelease table**
```prisma
model ModelRelease {
  id              Int           @id @default(autoincrement())
  modelId         Int
  model           Model         @relation(fields: [modelId])
  name            String        // "v1.0", "v2.0"
  description     String?
  baseModel       String        // "SD 1.5", "SDXL"
  baseModelType   String        // "Standard", "Inpainting"
  trainedWords    String[]
  publishedAt     DateTime?
  status          ModelStatus   @default(Draft)

  files           ModelFile[]
  components      ModelComponent[]

  // Migrate from ModelVersion
  steps           Int?
  epochs          Int?
  clipSkip        Int?
}
```

**2. New ModelComponent table**
```prisma
model ModelComponent {
  id              Int               @id @default(autoincrement())
  releaseId       Int
  release         ModelRelease      @relation(fields: [releaseId])
  type            ComponentType     // VAE, TextEncoder, Workflow, Config
  name            String
  description     String?
  required        Boolean           @default(false)

  // Can link to external model OR be a direct file
  linkedModelVersionId  Int?        // Link to existing Model on platform
  files           ModelFile[]       // Or uploaded directly
}

enum ComponentType {
  VAE
  TextEncoder
  Workflow
  Config
  Sampler
  Other
}
```

**3. Update ModelFile**
```prisma
model ModelFile {
  // ... existing fields
  releaseId       Int?              // New: links to release
  componentId     Int?              // New: links to component

  // New fields for variant grouping
  variantGroup    String?           // e.g., "base", "pruned"
  isDefault       Boolean           @default(false)
}
```

#### UI Presentation

**Model Page:**
```
┌──────────────────────────────────────────────────┐
│  Model Name                                       │
│  Release: v2.0 ▾ (dropdown to switch)            │
│                                                  │
│  [Download ▾]  ←─ Shows default file             │
│    ├─ fp16 SafeTensor (2.1 GB) ✓                │
│    ├─ fp8 SafeTensor (1.1 GB)                   │
│    ├─ GGUF Q4_K_M (800 MB)                      │
│    └─ GGUF Q8_0 (1.2 GB)                        │
│                                                  │
│  ─── Required Components ───                     │
│  [!] VAE: sd-vae-ft-mse (linked) [Download]     │
│  [!] Text Encoder: T5-XXL [Download]            │
│                                                  │
│  ─── Optional Files ───                          │
│  [ ] ComfyUI Workflow [Download]                │
│  [ ] Config: yaml [Download]                    │
├──────────────────────────────────────────────────┤
│  Previous Releases: v1.0, v1.5                   │
└──────────────────────────────────────────────────┘
```

#### Migration Strategy
1. Map existing `ModelVersion` → `ModelRelease` (1:1)
2. Keep `ModelVersion` table for backwards compatibility (deprecate over time)
3. New uploads use `ModelRelease`
4. API endpoints support both during transition

#### Pros
- Clean separation of concerns
- Explicitly models components vs. variants
- Scalable for future model types
- Clear "what do I need?" UX

#### Cons
- Significant schema change
- Migration complexity
- API changes needed
- Longer implementation time

---

### Proposal C: Enhanced File Metadata + UI (No Schema Change)

**Concept:** Use the existing `ModelFile.metadata` JSON field more aggressively, with major UI improvements.

#### Changes

**1. Extend metadata schema**
```typescript
type ModelFileMetadata = {
  // Existing
  format?: ModelFileFormat;
  size?: 'full' | 'pruned';
  fp?: 'fp32' | 'fp16' | 'bf16' | 'fp8' | 'nf4';

  // New
  isPrimary?: boolean;           // Is this the recommended download?
  variantOf?: number;            // FileId this is a variant of
  quantType?: string;            // e.g., "Q4_K_M", "Q8_0" for GGUF
  isRequired?: boolean;          // Required to use the model?
  componentType?: 'VAE' | 'TextEncoder' | 'Workflow' | 'Config' | null;
};
```

**2. Add conventions for file types**
Formalize that certain `type` values indicate components:
- `Model` / `Pruned Model` → Primary model files
- `VAE` / `Text Encoder` / `Config` → Components
- `Archive` / `Training Data` → Extras

**3. UI Changes**
Same as Proposal B but without schema changes - inferred from metadata.

#### Pros
- No schema changes
- No migration
- Can iterate quickly
- Backwards compatible

#### Cons
- JSON metadata is less queryable
- No referential integrity for component links
- Conventions can be inconsistent
- Doesn't truly solve version misuse (just hides it)

---

### Proposal D: Hybrid Approach (Recommended)

**Concept:** Implement Proposal C immediately for quick wins, then migrate to Proposal B over time.

#### Phase 1 (2-4 weeks): UI + Metadata Improvements

1. **Update metadata schema** (Proposal C)
   - Add `isPrimary`, `quantType`, `componentType`, `isRequired`
@justin: as part of option A, would we be adding quant type and component type and stuff like that? How are those getting handled as part of proposal A? I know that we have them included in our mockups.

@ai:* Yes! Here's how these fit into Proposal A:

**In ModelFile.metadata (JSON field):**
- `quantType`: For GGUF files - stores Q8_0, Q4_K_M, etc. (already discussed in Q6)
- `componentType`: For required component files - stores VAE, TextEncoder, UNet, etc. (uses existing `type` field or extends metadata)

**Changes to user preferences:**
- Add `quantType` preference so GGUF users can set their preferred quant level
- The existing `format`, `size`, `fp` preferences continue to work

**No new database columns needed** - we extend the existing `metadata` JSON field and user `filePreferences` JSON field.

**What we dropped:** `isPrimary` - not needed since user preferences auto-select the best file.

2. **Build new download UI**
   - Variant selector dropdown
   - Components section with required/optional indicators
   - "What do I need?" guidance

3. **Update upload flow**
   - Allow marking files as primary
   - Component type selection
   - Required flag for dependencies

4. **Auto-detect file variants**
   - Group files by `variantOf` or same type + different fp/format

#### Phase 2 (Future): Schema Evolution

1. Introduce `ModelRelease` and `ModelComponent` tables
2. Build migration tooling
3. Gradually migrate existing data
4. Deprecate version misuse patterns

#### Why This Approach?

- **Immediate value**: Users get better UX now
- **No breaking changes**: Existing models work fine
- **Reversible**: If Proposal B proves wrong, we haven't committed
- **Data-informed**: Phase 1 teaches us what creators actually need

@dev: Does this phased approach make sense? What's your appetite for a longer-term schema evolution?

---

## Open Questions

### ✅ Resolved: Approach Selection
Based on discussion, we're proceeding with **Proposal A (Minimal Schema Change)** with a focus on UI improvements first. The mockups above reflect this direction.

---

### Q1: Automatic Quantization Generation ✅ RESOLVED (Deferred)
> The issue mentions "automatic quantization can generate many variants per model"

@dev: Yes, we will be adding it later.

@ai: Acknowledged - auto quant generation is out of scope for Phase 1.

### Q2: Model Type Distinctions ✅ RESOLVED
> "Replace single Checkpoint paradigm with accurate model types"

@ai: The current `ModelType` enum has `Checkpoint`. Should we:
- **A)** Add new types: `DiffusionModel`, `UNet`, `FullPipeline`
- **B)** Add a `checkpointStructure` field: `Monolithic`, `Modular`, `ComponentOnly`
- **C)** Keep `Checkpoint` but add `ModelFile.componentType` to distinguish parts ← **CHOSEN**
- **D)** Something else?

@dev: I think C sounds the most correct. What people are posting is still a "checkpoint" but the check point has components like a UNet, TextEncoder, etc... Right?

@ai: Correct. We'll add `componentType` to distinguish parts (VAE, TextEncoder, UNet, etc.) while keeping the model-level type as Checkpoint.

### Q3: Component Linking Strategy ✅ RESOLVED
When a model needs a specific VAE (e.g., Wan 2.1 example):

@ai: Should components be:
- **A)** Uploaded directly under the model (current workaround)
- **B)** Linked to another Model on the platform (like `ModelVersion.vaeId`)
- **C)** Both options available to creator ← **CHOSEN**
- **D)** External URL links allowed

@dev: Yes

@ai: Implemented in v3 mockup with both upload dropzone and "Link to Existing Model" button.

### Q4: Backwards Compatibility ✅ RESOLVED
> "Existing models should remain accessible"

@ai: For the migration:
- Should we auto-classify existing versions as "releases"?
- What about models already using versions as components (like Wan 2.1)?
- Display a "legacy" badge on unmigrated models?

@ai: Since we're doing Proposal A (minimal schema), the backwards compatibility concern is lower. The main question is: **do we need a migration at all, or do we just improve the UI and let existing models stay as-is?**

@dev: We would need to do something to set the primaryId, right?

@ai: Actually no! Per Q9, we're **dropping primaryId entirely**. User preferences auto-select the best file. So backwards compatibility is simple:
- Existing models work as-is
- New metadata fields (`quantType`, `componentType`) are optional
- Old files without these fields still display fine
- **No migration needed** - just UI changes + optional metadata enrichment

### Q5: Priority of Problems ✅ RESOLVED
@ai: Which problem is most urgent to solve?
1. Quantization display (quants flooding UI) ← **Addressed by sidebar dropdown**
2. Component clarity (what do I need to download?) ← **Addressed by Required Components section**
3. Version semantics (true versions vs. packaging) ← **Partially addressed by file upload UI**
4. New model type support (UNets, diffusers) ← **Addressed by component type selector**

@dev: Isn't 4 technically handled as well, UNets and TextEncoders could now be "Required Components". I'm realizing now looking at the mockups, that people will need the ability to set what type of thing the "required component" is... Can you create a new version of the mockup that adds that?

@ai: Done! Created mockups with component type support. Latest version: [v4-components-with-precision.html](./model-ui-overhaul-mockups/file-upload.html)
- Component Type dropdown on each required component (VAE, Text Encoder, UNet, CLIP Vision, ControlNet, Config, Other)
- Precision/Quant/Format dropdowns matching model files
- UNet example to show it's now a first-class component type
- Link modal with type-first flow

### Q6: GGUF Quant Types ✅ RESOLVED
The issue links to [HuggingFace GGUF quant types](https://huggingface.co/docs/hub/en/gguf#quantization-types):
- Q2_K, Q3_K_S, Q3_K_M, Q3_K_L, Q4_0, Q4_K_S, Q4_K_M, Q5_0, Q5_K_S, Q5_K_M, Q6_K, Q8_0, etc.

@ai: Should we:
- **A)** Add these to `modelFileFp` enum
- **B)** Add a separate `quantType` field in metadata ← **CHOSEN**
- **C)** Store in metadata only
- **D)** Auto-detect from filename

@dev: Yes, Option B and storing the new value in the file metadata.

@ai: Will add `quantType` to `ModelFile.metadata` JSON. This stores the GGUF-specific quant level (Q8_0, Q4_K_M, etc.) separately from the general `fp` field.

---

### New Questions from Mockups

### Q7: Link Modal Flow ✅ RESOLVED
The file upload mockup has a "Link to Existing Model on Civitai" button that opens a modal.

@ai: What should the modal flow look like?
- Search/browse all models filtered by type (VAE, TextEncoder, etc.)?
- Auto-filter to compatible base models only?
- Show just the model, or drill down to version → file?

@dev: that's not the same. Don't we currently allow people to select a VAE to attach or whatever? I think we handle that by giving them a search UI and just filtering to specific criteria. We would essentially do the same thing here where they would select the model, pick a version, and then pick a file, I guess. Maybe the way that we need to have it is rather than going that direction, they need to say, hey, yep, I'm going to add a text-encoder as a required file here, and then they can see all of the models that have a text-encoder file or something. So we can go backwards. So it would be choose the type of thing that you're uploading, see all of the models that have those things, find the model you're looking for, pick the version that has the text encoder that you wanted or whatever.

@ai: Got it! Type-first flow implemented in v3 mockup:
1. **Select component type** (VAE, Text Encoder, UNet, CLIP Vision, ControlNet, Other)
2. **Search models** filtered to those with that file type
3. **Pick version** from the model
4. **Pick file** from that version

This is the reverse of what I initially had (which was model-first). The type-first approach makes more sense because it pre-filters the search results.

### Q8: Required vs Recommended Components ✅ RESOLVED
The mockup has "Required Components" (must download) but the existing site has "Recommended Resources" (nice to have).

@ai: Are these different concepts, or should we merge them?
- **Required Components**: Won't run without these (VAE, Text Encoder)
- **Recommended Resources**: Works better with these (LoRAs, workflows)

@dev: Yeah, different things. The idea with required components is it gives them the ability to have units in there, text encoders in there, so you have at the top level the combined thing, and then if you want to get the parts, you can do it below. I guess one of the things that's maybe a little bit weird is, and I think that this was part of the problem statement, that there are some models where they always keep them separate. You have the unit and you have the text encoder. And I think in that situation it makes sense to not have the singular download option, instead you would just have the required component section. Right?

@ai: Confirmed - two different concepts:
- **Required Components**: Parts needed to run (VAE, UNet, Text Encoder) - lives in file upload UI
- **Recommended Resources**: Nice-to-have suggestions (LoRAs, workflows) - existing feature, stays separate

**New insight for component-only models:** When a model is ONLY components (no single file, just UNet + TextEncoder separately), we should hide the main download button and only show the Required Components section. Need to add this case to the sidebar mockup.

### Q9: Primary File Auto-Selection ✅ RESOLVED (Dropped!)
@ai: When a creator uploads multiple file variants, how do we determine the initial primary?
- **A)** First uploaded file
- **B)** Largest file (assume most complete)
- **C)** Most common format (fp16 SafeTensor)
- **D)** Creator must explicitly select

@dev: Currently, we smart select the primary version based on user settings. So a user can say, hey, I want pruned, I want FP16. And we pick that as long as it exists. So having the user select the primary might not actually make sense here. I wonder if maybe we drop the primary concept altogether, actually. Which in a way, I guess removes the need for that new field altogether. instead, I guess we would make it so that in the same way where users can pick SafeTensor or Pickle, they can now select GGUF and they can select QuantSize or whatever. So you maybe go look at the account settings to see how that bit works to make sure that's going to function for us.

@ai: **This is a key decision!** Dropping `primaryFileId` entirely. Instead:
1. Existing user preferences (`filePreferences.format`, `filePreferences.size`, `filePreferences.fp`) auto-select the best file
2. Extend preferences to add `quantType` for GGUF users (Q4_K_M, Q8_0, etc.)
3. Download button shows the user's preferred match; dropdown shows all variants

I checked the account settings - preferences are in `SettingsCard.tsx`:
- Format: SafeTensor, PickleTensor, GGUF, Diffusers, Core ML, ONNX
- Size: Full, Pruned
- Precision: fp16, fp8, nf4, fp32, bf16

**To implement:** Add a "Preferred Quant" option for when format is GGUF.

### Q10: Quant Type Preference ✅ RESOLVED
@ai: Should we add "Preferred Quant Type" to user settings for GGUF users? Options like Q4_K_M (smallest), Q8_0 (best quality), etc.?

@dev: Yes

@ai: Will add `quantType` to user `filePreferences` - shown conditionally when format is GGUF.

### Q11: Component-Only Models ✅ RESOLVED
@ai: For models that are ONLY components (no single download, just UNet + TextEncoder), should we:
- A) Hide the main download button entirely, show only Required Components ← **CHOSEN**
- B) Show a disabled download button with a message
- C) Something else?

@dev: A

@ai: Will update sidebar mockup to show this case - no download button, just Required Components section.

### Q12: Schema Changes ✅ RESOLVED
@ai: If we drop `primaryFileId`, do we need ANY schema changes for Phase 1?

@dev: I don't think we need to change anything except schemas for metadata.

@ai: Confirmed - **no database migrations needed**. Changes are:
- Extend `ModelFile.metadata` JSON to include `quantType`, `componentType`
- Extend `User.filePreferences` JSON to include `quantType`
- All UI changes

### Q13: Component Precision/Format ✅ RESOLVED
@dev: Are the required components potentially quantizable? I mean, if units can go, there aren't there quantized versions of unets and text encoders and stuff like that? I wonder if we need to have format, and precision for those components as well.

@ai: **Yes, absolutely!** Components can have precision variants:
- **Text Encoder**: T5 XXL fp16 (9.5 GB) vs T5 XXL fp8 (4.9 GB) - we see this in Wan example
- **UNet**: Can have fp16, fp8, and even GGUF quants
- **VAE**: Usually just one precision, but could have fp16/fp32 variants

**Question:** When a component has multiple precision variants, should we:
- **A)** Let user upload/link multiple variants of the same component (like model files) ← **CHOSEN**
- **B)** Just pick one variant per component type

@dev: A

@ai: Components work like model files - creators can add multiple precision variants of the same component type. For example:
- Text Encoder (fp16) - 9.5 GB
- Text Encoder (fp8) - 4.9 GB

User preferences will auto-select the best match, just like model files. The Required Components section in the sidebar will group variants together.

**Mockup updates needed:**
1. ✅ File upload: Added Precision/Quant/Format dropdowns to components - see [v4-components-with-precision.html](./model-ui-overhaul-mockups/file-upload.html)
2. ✅ Sidebar: Component variants grouped - see [v9-components-grouped.html](./model-ui-overhaul-mockups/model-sidebar.html)

---

## Appendix: Current Constants Reference

### ModelType Enum
```typescript
Checkpoint, TextualInversion, Hypernetwork, AestheticGradient,
LORA, LoCon, DoRA, Controlnet, Upscaler, MotionModule, VAE,
Poses, Wildcards, Workflows, Detection, Other
```

### ModelFileFormat
```typescript
'SafeTensor', 'PickleTensor', 'GGUF', 'Diffusers', 'Core ML', 'ONNX', 'Other'
```

### ModelFileFp (Current Quantization)
```typescript
'fp32', 'fp16', 'bf16', 'fp8', 'nf4'
```

### File Preference Scoring
Current algorithm in `src/server/utils/model-helpers.ts`:
```typescript
const preferenceWeight = {
  format: 100,  // Match format preference
  size: 10,     // Match size preference
  fp: 1         // Match precision preference
};
```

---

## Data-Driven Recommendations

Based on the database analysis, here's what the data suggests:

### 1. The Problem is Real but Focused
- **84% of models** have 1 version (no version misuse)
- **~1,100 models** have 20+ versions (heavy misuse or collection pattern)
- **261 models** have GGUF files (quant concern is concentrated)

**Recommendation:** Start with targeted solutions for Checkpoints and high-version-count models rather than platform-wide changes.

### 2. Infrastructure Exists but Isn't Used
- `fp` metadata field: exists but only 7% populated
- `vaeId` linking: exists but only 0.5% used
- ModelFile types (VAE, Text Encoder): exist but barely used (238 text encoders total)

**Recommendation:** Before building new infrastructure, improve the upload UI to encourage use of existing fields. This is lower effort and teaches us what creators actually need.

### 3. Collection Pattern is Legitimate
High version counts (100+) are often intentional collections:
- Character collections (Pokemon, Genshin, etc.)
- Style packs
- Subject libraries (US Senators, Bond Girls)

**Recommendation:** Consider adding explicit "Collection" model type or grouping rather than forcing these into the version paradigm.

### 4. GGUF is Small but Growing
Only 1,027 GGUF files today, but Flux/Wan Video adoption is accelerating.

**Recommendation:** Solve this now before GGUF becomes 10% of files. The file variant UI is a quick win.

### 5. Component Problem is Narrow
Only ~900 component-type files exist (Config, Text Encoder). Most components are uploaded as separate Models.

**Recommendation:** Start by improving cross-model linking (surface `vaeId` better, expand to other component types) rather than adding component infrastructure within models.

---

## Summary: Chosen Path

We're proceeding with **Proposal A (Minimal Schema Change)** focused on UI improvements. Key simplification: **no database migrations required**.

### Phase 1: UI + Metadata Changes

#### Mockups (Complete)
1. ✅ **Model detail sidebar** - [v9-components-grouped.html](./model-ui-overhaul-mockups/model-sidebar.html)
   - File variants in dropdown (grouped by format)
   - **Component variants grouped** - Text Encoder shows fp16/fp8 variants, UNet shows SafeTensor/GGUF variants
   - Single-variant components (VAE) show without dropdown
   - "Best match" auto-selected based on user preferences
   - "Download All Components" downloads preferred variants
   - Optional Files accordion
   - All existing version details preserved

2. ✅ **File upload UI** - [v4-components-with-precision.html](./model-ui-overhaul-mockups/file-upload.html)
   - Three sections: Model Files, Required Components, Optional Files
   - Component Type selector (VAE, Text Encoder, UNet, CLIP Vision, etc.)
   - **Components have same dropdowns as model files:**
     - SafeTensor: Type + Precision
     - GGUF: Type + Quant
     - ZIP: Type + Format + Precision
   - Multiple variants per component (e.g., Text Encoder fp16 + fp8)
   - Upload OR link components with type-first modal flow
   - No primary toggle (user preferences auto-select)

#### Data Changes (No Migrations)
3. ⏳ Extend `ModelFile.metadata` JSON:
   - Add `quantType` for GGUF files (Q8_0, Q4_K_M, etc.)
   - Add `componentType` for required components (VAE, TextEncoder, UNet, etc.)

4. ⏳ Extend `User.filePreferences` JSON:
   - Add `quantType` preference for GGUF users

5. ⏳ Expand component linking beyond `vaeId` (TextEncoder, UNet, etc.)

#### What We Dropped
- ~~`primaryFileId`~~ - User preferences auto-select the best file
- ~~Database migrations~~ - All changes are to JSON metadata fields

### Future Considerations
- Schema evolution (ModelRelease + ModelComponent) only if Phase 1 proves insufficient
- Collection model type for high-version-count models
- Automatic quantization generation (confirmed coming later)

---

## Codebase Discovery

This section documents existing components, patterns, and infrastructure we can reuse.

### File Upload System

**Key Components:**
| Component | Path | Purpose |
|-----------|------|---------|
| `Files.tsx` | `src/components/Resource/Files.tsx` | Main upload UI with dropzone, file cards, metadata editing |
| `FilesProvider.tsx` | `src/components/Resource/FilesProvider.tsx` | State management, validation, S3 upload integration |
| `FilesEditModal.tsx` | `src/components/Resource/FilesEditModal.tsx` | Modal wrapper for editing existing version files |
| `ModelVersionWizard.tsx` | `src/components/Resource/Wizard/ModelVersionWizard.tsx` | Multi-step wizard (Step 2 = file upload) |

**Current File Type Categories** (in `constants.ts`):
- Model, Text Encoder, Pruned Model, Negative, Training Data, VAE, Config, Archive

**Current Metadata Fields:**
- `format`: SafeTensor, PickleTensor, GGUF, Diffusers, Core ML, ONNX
- `size`: full, pruned
- `fp`: fp16, fp8, nf4, fp32, bf16

**Validation Logic** (in `FilesProvider.tsx`):
- For Checkpoints: `size` and `fp` are required for Model files
- Conflict checking prevents duplicate `[size, type, fp, format]` combinations

**To Extend:**
- Add `quantType` field for GGUF files (Q8_0, Q4_K_M, etc.)
- Add `componentType` field to distinguish VAE, TextEncoder, UNet
- Add new validation for Required Components section
- Update `FileEditForm` in `Files.tsx` to show new dropdowns

---

### Model Detail Sidebar

**Key Components:**
| Component | Path | Purpose |
|-----------|------|---------|
| `ModelVersionDetails.tsx` | `src/components/Model/ModelVersions/ModelVersionDetails.tsx` | **Main sidebar** - all download/generate UI |
| `DownloadButton.tsx` | `src/components/Model/ModelVersions/DownloadButton.tsx` | Download button with dropdown support |
| `GenerateButton.tsx` | `src/components/RunStrategy/GenerateButton.tsx` | Generate button component |

**Current Download Display** (lines 598-658 in ModelVersionDetails):
- Single file: Icon-only download button
- Multiple files: Menu dropdown with file list
- Files shown with name + size, no variant grouping

**Current File Accordion** (lines 1293-1330):
- Shows all visible files in expandable accordion
- "Manage Files" link for owners

**To Modify:**
- Lines 598-658: Add variant grouping logic (group by format, show precision/quant)
- Lines 808-940: Update download button area to show grouped variants
- Add new "Required Components" accordion section with yellow warning styling
- Add "Download All Components" button
- Handle component-only models (hide download button, show only components)

---

### User File Preferences

**Key Files:**
| File | Purpose |
|------|---------|
| `SettingsCard.tsx` | `src/components/Account/SettingsCard.tsx` - UI for setting preferences |
| `model-helpers.ts` | `src/server/utils/model-helpers.ts` - Scoring algorithm |
| `global.d.ts` | `src/types/global.d.ts` - Type definitions |
| `constants.ts` | `src/server/common/constants.ts` - Available options |

**Current Preferences Structure:**
```typescript
{
  format: 'SafeTensor' | 'PickleTensor' | 'GGUF' | ...,
  size: 'full' | 'pruned',
  fp: 'fp16' | 'fp8' | 'nf4' | 'fp32' | 'bf16',
  imageFormat: 'optimized' | 'metadata'
}
```

**Scoring Algorithm** (`getPrimaryFile` in model-helpers.ts):
```typescript
const preferenceWeight = {
  format: 100,  // Highest priority
  size: 10,     // Medium priority
  fp: 1         // Lowest priority
};
// Files are scored by matching preferences, highest score wins
```

**To Extend:**
1. Add `quantType` to `UserFilePreferences` type in `global.d.ts`
2. Add `modelFileQuantTypes` array to `constants.ts`
3. Add `quantType: 0.5` to `preferenceWeight` in `model-helpers.ts`
4. Add fourth `Select` in `SettingsCard.tsx` (conditionally shown for GGUF users)
5. Update `file.service.ts` to include `quantType` in file selection

---

### VAE Linking Pattern (Existing)

**Current Implementation:**
- `ModelVersion.vaeId` → Foreign key to another ModelVersion
- UI: `InputSelect` in `ModelVersionUpsertForm.tsx` (lines 899-909)
- Query: `trpc.modelVersion.getModelVersionsByModelType({ type: 'VAE' })`
- Display: VAE files merged into version.files array via `getVaeFiles()`

**To Expand for Other Components:**
Two options considered:
1. **Add more foreign keys**: `textEncoderId`, `unetId` (simple but rigid)
2. **Use JSON metadata** on ModelFile (flexible, chosen approach)

We're using **Option 2** - extend `ModelFile.metadata` with `componentType` field rather than adding schema fields.

---

### Model Search/Select Components (Reusable)

**Key Components:**
| Component | Path | Purpose |
|-----------|------|---------|
| `QuickSearchDropdown.tsx` | `src/components/Search/QuickSearchDropdown.tsx` | **Primary search component** - reuse for link modal |
| `AssociateModels.tsx` | `src/components/AssociatedModels/AssociateModels.tsx` | Association pattern with drag-drop |
| `AssociateModelsModal.tsx` | `src/components/Modals/AssociateModelsModal.tsx` | Modal wrapper pattern |
| `ResourceSelectModal2.tsx` | `src/components/ImageGeneration/GenerationForm/ResourceSelectModal2.tsx` | Advanced modal with filters |

**QuickSearchDropdown Features:**
- Integrates with Meilisearch
- Supports filtering by index, query, custom filters
- Returns `SearchIndexDataMap['models']` structure with versions array

**For Link Component Modal:**
```typescript
// Reuse QuickSearchDropdown with type-first filtering
<QuickSearchDropdown
  supportedIndexes={['models']}
  onItemSelected={(item, data) => setSelectedModel(data)}
  filters={`type=${selectedComponentType}`}  // Filter to VAE, TextEncoder, etc.
/>

// Then show version selector
<Select
  data={selectedModel.versions.map(v => ({ label: v.name, value: v.id }))}
  onChange={setSelectedVersion}
/>
```

**Dialog System:**
- Use `dialogStore.trigger()` from `src/components/Dialog/dialogStore.ts`
- Pattern: `createDialogTrigger(YourModal)` returns opener function

---

## Detailed Implementation Plan

### Phase 1: Type & Constant Updates (Foundation)

**Task 1.1: Update Type Definitions**
- File: `src/types/global.d.ts`
- Changes:
  - Add `type ModelFileQuantType = 'Q8_0' | 'Q6_K' | 'Q5_K_M' | 'Q4_K_M' | 'Q4_K_S' | 'Q3_K_M' | 'Q2_K' | ...`
  - Add `quantType?: ModelFileQuantType` to `BasicFileMetadata`
  - Add `componentType?: 'VAE' | 'TextEncoder' | 'UNet' | 'CLIPVision' | 'ControlNet' | 'Config'` to `BasicFileMetadata`
  - Add `quantType?: ModelFileQuantType` to `UserFilePreferences`

**Task 1.2: Update Constants**
- File: `src/server/common/constants.ts`
- Changes:
  - Add `modelFileQuantTypes: ['Q8_0', 'Q6_K', 'Q5_K_M', 'Q4_K_M', 'Q4_K_S', 'Q3_K_M', 'Q2_K']`
  - Add `modelFileComponentTypes: ['VAE', 'TextEncoder', 'UNet', 'CLIPVision', 'ControlNet', 'Config', 'Other']`

**Task 1.3: Update File Preference Scoring**
- File: `src/server/utils/model-helpers.ts`
- Changes:
  - Add `quantType: 0.5` to `preferenceWeight`
  - Update `FileMetaKey` type to include `quantType`
  - Update `defaultFilePreferences` to include sensible quantType default

---

### Phase 2: User Settings Extension

**Task 2.1: Update Settings UI**
- File: `src/components/Account/SettingsCard.tsx`
- Changes:
  - Add "Preferred Quant Type" `Select` (conditionally shown when format is GGUF)
  - Wire up to `user.filePreferences.quantType`
  - Add tooltip explaining quant types (Q8 = quality, Q4 = smaller)

**Task 2.2: Update File Service**
- File: `src/server/services/file.service.ts`
- Changes:
  - Add `quantType` to query parameter handling
  - Include in metadata merge for file selection

**Task 2.3: Update Download API**
- File: `src/pages/api/download/models/[modelVersionId].ts`
- Changes:
  - Add `quantType` to validation schema
  - Pass through to file selection

---

### Phase 3: File Upload UI Updates

**Task 3.1: Add Quant Type Selector**
- File: `src/components/Resource/Files.tsx` (FileEditForm, ~line 513)
- Changes:
  - Add `Select` for quantType (shown when format is GGUF)
  - Options from `constants.modelFileQuantTypes`
  - Update validation to require quantType for GGUF files

**Task 3.2: Add Component Type Selector**
- File: `src/components/Resource/Files.tsx`
- Changes:
  - Add `Select` for componentType
  - Options from `constants.modelFileComponentTypes`
  - Shown for non-Model file types (VAE, Text Encoder, Config, Archive)

**Task 3.3: Add Upload Sections**
- File: `src/components/Resource/Files.tsx`
- Changes:
  - Restructure UI into three sections:
    1. **Model Files** - Main model weights
    2. **Required Components** - Yellow warning styling, VAE/TextEncoder/UNet
    3. **Optional Files** - Workflows, configs, examples
  - Add section headers with icons
  - Files auto-categorize based on type

**Task 3.4: Create Link Component Modal**
- New File: `src/components/Resource/LinkComponentModal.tsx`
- Features:
  - Component type selector (VAE, TextEncoder, UNet, etc.)
  - QuickSearchDropdown filtered by component type
  - Version selector
  - File selector (for multi-file versions)
  - Save creates reference in metadata

**Task 3.5: Update FilesProvider Validation**
- File: `src/components/Resource/FilesProvider.tsx`
- Changes:
  - Extend `metadataSchema` for quantType validation
  - Add validation: component-only models need at least 2 required components
  - Update conflict checking to include quantType

---

### Phase 4: Model Sidebar Updates

**Task 4.1: Add File Variant Grouping**
- File: `src/components/Model/ModelVersions/ModelVersionDetails.tsx`
- Changes:
  - Create `groupFilesByVariant()` utility function
  - Group files by: format (SafeTensor vs GGUF), then by type (Model vs Component)
  - Within each group, sort by precision/quant

**Task 4.2: Update Download Button Area**
- File: `src/components/Model/ModelVersions/ModelVersionDetails.tsx` (~lines 808-940)
- Changes:
  - Replace flat file list with grouped dropdown
  - Show "Best match" badge on user's preferred file
  - Group sections: SafeTensor variants, GGUF variants

**Task 4.3: Add Required Components Section**
- File: `src/components/Model/ModelVersions/ModelVersionDetails.tsx`
- Changes:
  - Add new accordion section "Required Components"
  - Yellow warning styling to indicate these are required
  - Group component variants (e.g., Text Encoder fp16 / fp8)
  - "Download All Components" button

**Task 4.4: Handle Component-Only Models**
- File: `src/components/Model/ModelVersions/ModelVersionDetails.tsx`
- Changes:
  - Detect when no "Model" type files exist
  - Hide download button, show message: "This is a modular model"
  - Make "Download All Components" the primary action
  - Update Generate button positioning

**Task 4.5: Update File Info Display**
- File: `src/components/FileInfo/FileInfo.tsx`
- Changes:
  - Show quantType for GGUF files
  - Show componentType for component files

---

### Phase 5: Testing & Polish

**Task 5.1: Manual Testing Scenarios**
- Test file upload with new fields (quantType, componentType)
- Test user preference selection for GGUF files
- Test download auto-selection with new scoring
- Test sidebar display with grouped variants
- Test component-only model display
- Test link component modal flow

**Task 5.2: Update Storybook/Tests**
- Add stories for new upload sections
- Add stories for variant grouping
- Test preference scoring with quantType

**Task 5.3: Documentation**
- Update API docs for new metadata fields
- Document new upload flow for creators
- Create help content for component types

---

## File Change Summary

| File | Changes |
|------|---------|
| `src/types/global.d.ts` | Add quantType, componentType types |
| `src/server/common/constants.ts` | Add quantTypes, componentTypes arrays |
| `src/server/utils/model-helpers.ts` | Add quantType to scoring |
| `src/components/Account/SettingsCard.tsx` | Add quant preference UI |
| `src/server/services/file.service.ts` | Add quantType to selection |
| `src/pages/api/download/models/[modelVersionId].ts` | Add quantType param |
| `src/components/Resource/Files.tsx` | Add sections, new dropdowns |
| `src/components/Resource/FilesProvider.tsx` | Update validation |
| `src/components/Resource/LinkComponentModal.tsx` | **New file** |
| `src/components/Model/ModelVersions/ModelVersionDetails.tsx` | Variant grouping, components section |
| `src/components/FileInfo/FileInfo.tsx` | Show new metadata |

---

## Dependencies & Risks

**No External Dependencies** - All changes use existing libraries (Mantine, tRPC, Zustand)

**Risk: Backwards Compatibility**
- Mitigation: All new metadata fields are optional, existing files continue to work

**Risk: Performance with Many Variants**
- Mitigation: Grouping reduces visual complexity; scoring algorithm is O(n) with small n

**Risk: User Confusion with New UI**
- Mitigation: Phased rollout, clear section labels, tooltips explaining purpose
