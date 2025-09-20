# Civitai Generator System - Adding Base Models and Engines

@dev: This document focuses on workflows for adding or modifying supported base models and engines. It provides step-by-step instructions for agents to add them with minimal additional direction.

## System Architecture Overview

The generator system uses a modular architecture where generation engines (image/video) integrate through an orchestrator pattern. Each engine supports specific base models with their own configurations and form fields.

### Key Components
- **Base Model Registry**: `src/shared/constants/base-model.constants.ts` - Central registry of all base models
- **Generation Constants**: `src/shared/constants/generation.constants.ts` - Generation-specific configurations
- **Generation Form**: `src/components/ImageGeneration/GenerationForm/GenerationForm2.tsx` - Conditional UI logic
- **Orchestrator Services**: Handle engine-specific generation requests
- **Database Tables**: `EcosystemCheckpoints`, `GenerationBaseModel` - Track model availability

## Workflow 1: Adding a New Image Base Model

### Step 1: Register the Base Model
File: `src/shared/constants/base-model.constants.ts`

Add to `baseModelConfig` array:
```typescript
{
  name: 'ModelName',        // Display name
  type: 'image',            // 'image' or 'video'
  group: 'ModelGroup',      // Unique group identifier
  ecosystem?: 'sdxl',       // Optional: inherit capabilities from ecosystem
  engine?: 'engine-name',   // Optional: specific engine mapping
  hidden?: false            // Optional: hide from UI
}
```
@dev: instead of using the term "ModelName", please use the term "baseModel". Instead of the term "ModelGroup", use "baseModelGroup"

### Step 2: Define Model Support
File: `src/shared/constants/base-model.constants.ts`

Add to `baseModelGenerationConfig`:
```typescript
{
  group: 'ModelGroup',
  support: [{
    modelTypes: [ModelType.Checkpoint, ModelType.LORA, ModelType.VAE],
    baseModels: ['ModelName']
  }],
  partialSupport: [/* optional cross-compatible models */]
}
```

@dev: Currently only Checkpoint, LORA/LoCon/DoRA, VAE, and TextualInversion are supported for user uploads. This is defined here in the support configuration.

### Step 3: Add Default Checkpoint
Database: `EcosystemCheckpoints` table

Add entry with:
- `id`: modelVersionId of default checkpoint
- `name`: Display name for the checkpoint
@dev: typically, the database updates come at the end. This is due to the fact that we directly modify the prod database, and we don't want to do it before the codebase is ready.

### Step 4: Enable Generation Support
Database: `GenerationBaseModel` table

Add entry:
- `baseModel`: 'ModelName' (must match base-model.constants.ts)

### Step 5: Configure Generation Settings
File: `src/server/common/constants.ts`

Add to `generationConfig`:
```typescript
ModelGroup: {
  aspectRatios: [/* aspect ratio options */],
  checkpoint: {
    id: modelVersionId,
    name: 'checkpoint name',
    baseModel: 'ModelName',
    // ... other resource properties
  }
}
```

### Step 6: Add UI Conditional Logic
File: `src/components/ImageGeneration/GenerationForm/GenerationForm2.tsx`

1. Add detection function in `src/shared/constants/generation.constants.ts`:
```typescript
export function getIsModelGroup(baseModel?: string) {
  const baseModelSetType = getBaseModelSetType(baseModel);
  return baseModelSetType === 'ModelGroup';
}
```


2. Use in GenerationForm2.tsx:
```typescript
const isModelGroup = getIsModelGroup(baseModel);

// Add conditional logic for form fields
const disableNegativePrompt = isFlux || isModelGroup || /* others */;
const disableAdvanced = isModelGroup || /* others */;
// etc.
```
@dev: instead of having to check what baseModelGroup it is like this, I'd like to be able to have baseModelGroup/engine config files that determine what form fields to display and smart defaults for those fields.

### Step 7: Update Schedulers/Samplers (if needed)
File: `src/shared/constants/generation.constants.ts`

Map samplers if different from defaults:
- Update `samplersToSchedulers` mapping
- Update `samplersToComfySamplers` mapping
@dev: the sampler mapping doesn't usually update.

## Workflow 2: Adding a New Video Base Model

### Step 1-4: Same as Image Model
Follow steps 1-4 from Image workflow, but use `type: 'video'`

### Step 5: Create Engine Implementation
File: `src/server/orchestrator/[engine-name].ts`

Create engine file with schema and configuration:
```typescript
export const engineSchema = z.object({
  // Define engine-specific parameters
});

export const engineConfig = {
  engine: 'engine-name',
  baseModel: 'ModelName',
  defaultValues: {/* defaults */},
  // other configuration
};
```

### Step 6: Register in Video Config
File: `src/server/orchestrator/generation/generation.config.ts`

Add to configuration:
```typescript
import { engineConfig } from '../[engine-name]';

// Add to the configs array
configs.push(engineConfig);
```

@dev: Each video engine takes a schema with different defaults. These schemas ensure the default form values use the best defaults for the selected model.

### Step 7: Create Form Component (if needed)
File: `src/components/Generation/Video/[EngineName]Form.tsx`

Create engine-specific form if special UI needed

@dev: A new engine would get its own form/config files. Consider making this part of the main generation form for better configuration management.

## Workflow 3: Adding an External Image Generation Engine

### Step 1: Create Engine Configuration
File: `src/shared/orchestrator/ImageGen/[engine-name].ts`

```typescript
export const engineConfig = {
  engine: 'engine-name',
  models: [/* supported model IDs */],
  schema: z.object({/* parameters */}),
  defaultValues: {/* defaults */}
};
```

### Step 2: Register in ImageGen Config
File: `src/shared/orchestrator/ImageGen/imageGen.config.ts`

```typescript
import { engineConfig } from './[engine-name]';

// Add to imageGenModelVersionMap
imageGenModelVersionMap.set(modelVersionId, 'engine-name');
```

@dev: Note that for each imageGen config, there is an associated engine, and each engine will work with one or more specific models.

### Step 3: Update GenerationForm2 Logic
File: `src/components/ImageGeneration/GenerationForm/GenerationForm2.tsx`

Add detection and conditional logic:
```typescript
const isEngineName = getIsEngineName(model.id); // Add helper function
// Apply conditional field visibility/defaults
```

@dev: We don't update ResourceSelect components. Instead, we add conditional logic to GenerationForm2.tsx to specify what form fields to use for each baseModel/engine.

## Workflow 4: Enabling Training Model Preview

Training models can be generated before publication through epoch selection:

### Training Integration Points
- Training service creates model versions with epoch metadata
- `epochDetails` in generation service contains: `jobId`, `fileName`, `epochNumber`
- Resources with `epochNumber` parameter use training outputs directly

@dev: Once training models are published, they're treated the same as user-uploaded models (Method 1). Before publication, they reference orchestrator storage via epochDetails.

## Critical Database Operations

### When Adding New Base Models

1. **EcosystemCheckpoints** - Add default checkpoint:
```sql
INSERT INTO "EcosystemCheckpoints" (id, name)
VALUES (modelVersionId, 'Display Name');
```

2. **GenerationBaseModel** - Enable generation:
```sql
INSERT INTO "GenerationBaseModel" (baseModel)
VALUES ('ModelName');
```

@dev: When we add a new baseModel, we typically add a default checkpoint to EcosystemCheckpoints with the modelVersionId and name. To enable generation for loras/doras/etc, we update the GenerationBaseModel table.

## Search Index Updates

For models added via external engines (not user uploads):

### Manual Index Update Required
Models added through external engines need manual Meilisearch indexing since they bypass the normal publication flow.

@dev: Method 1 (user uploads) is covered by the model publishing system. External engine models need manual search index updates.

## Cost Management

### Cost Calculation Flow
1. Generation request includes model and parameters
2. Orchestrator API receives "whatIf" request
3. Returns cost based on model/engine/parameters
4. Cost displayed to user before generation

@dev: Cost calculation comes from the orchestrator API as a "whatIf" request, not from local calculations.

## NSFW Content Handling

### NSFW Level Management
- Request NSFW level limited based on model/engine
- Generated content NSFW level detected automatically
- Display filtered based on user preferences and content level

@dev: Focus on how we limit NSFW level of requests and handle the resulting NSFW level of images for show/hide based on user preferences.

## Testing Checklist

When adding a new base model or engine:

1. ✓ Model appears in generation form
2. ✓ Correct form fields show/hide
3. ✓ Default values apply correctly
4. ✓ Generation request succeeds
5. ✓ Cost calculation works
6. ✓ Generated content displays properly
7. ✓ Resources (LORA, etc.) compatible if applicable
8. ✓ Search indexing works (for external engines)

## Common Issues and Solutions

### Model Not Appearing
- Check `baseModelConfig` registration
- Verify `hidden: false` or omitted
- Check `GenerationBaseModel` entry exists

### Generation Failing
- Verify orchestrator engine implementation
- Check schema validation
- Confirm default checkpoint in `EcosystemCheckpoints`

### Resources Not Compatible
- Update `baseModelGenerationConfig` support arrays
- Check ecosystem inheritance settings
- Verify ModelType support configuration

@ai: This documentation has been updated based on all developer feedback. It now focuses specifically on workflows for adding base models and engines, with clear step-by-step instructions that agents can follow. The document includes file paths, database operations, and critical configuration points while keeping implementation details high-level as requested.

**Continue**
```
cc -r 189ef699-3003-4b01-b9da-2601525e9e11
```
