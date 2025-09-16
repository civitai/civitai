# Adding New Base Models to Generation System

This document outlines the complete process for creating and adding support for new base models in the Civitai generation system. This includes both creating the base model definition and enabling it for generation.

## Overview

Adding a new base model to the generation system is a two-step process:
1. **Create the Base Model** - Define the base model in the system constants and UI
2. **Enable for Generation** - Configure generation-specific settings and behaviors

This guide walks through each step of the complete process.

## Part 1: Creating a New Base Model

Before a base model can be used for generation, it must first be defined in the system. This section covers the foundational steps to create a base model definition.

### 1. Define Base Model in Constants

#### Add to Base Model Configuration
**File**: `src/shared/constants/base-model.constants.ts`

Add a new entry to the `baseModelConfig` array. The structure determines the base model's basic properties:

```typescript
const baseModelConfig = [
  // ... existing entries
  { 
    name: 'YourBaseModel', 
    type: 'image', // or 'video' for video models
    group: 'YourBaseModel',
    ecosystem: 'optional-ecosystem', // e.g., 'sdxl', 'qwen' - if part of a broader ecosystem
    hidden: false, // optional - set to true to hide from UI
    engine: 'optional-engine' // e.g., 'hunyuan', 'lightricks' - for specific engines
  },
  // ... other entries
];
```

**Configuration Options:**
- `name`: The exact base model name as it appears in the system
- `type`: Media type - 'image' for image generation, 'video' for video generation
- `group`: Logical grouping for the base model (usually same as name for standalone models)
- `ecosystem` (optional): If the model belongs to a broader ecosystem (e.g., SDXL variants)
- `hidden` (optional): Set to true to hide from public UI
- `engine` (optional): Specific generation engine if applicable

### 2. Add License Information

#### Update License Mapping
**File**: `src/server/common/constants.ts`

Add a license entry to the `baseModelLicenses` object:

```typescript
export const baseModelLicenses: Record<BaseModel, LicenseDetails | undefined> = {
  // ... existing entries
  YourBaseModel: baseLicenses['apache 2.0'], // or appropriate license
  // ... other entries
};
```

**Common License Types:**
- `baseLicenses['apache 2.0']` - Apache 2.0 License
- `baseLicenses['openrail++']` - CreativeML Open RAIL++ License
- `baseLicenses['mit']` - MIT License
- `undefined` - No specific license restrictions

### 3. Add UI Badge Support

#### Add Badge Indicator
**File**: `src/components/Model/ModelTypeBadge/ModelTypeBadge.tsx`

Add a short identifier for the base model badge:

```typescript
const BaseModelIndicator: Partial<Record<BaseModel, React.ReactNode | string>> = {
  // ... existing entries
  YourBaseModel: 'YBM', // Short 2-4 character identifier
  // ... other entries
};
```

**Badge Guidelines:**
- Use 2-4 character abbreviations
- Can be a string or React component (e.g., custom icons)
- Should be easily recognizable and unique

## Part 2: Enabling Base Model for Generation

Once the base model is defined in the system, you can enable it for generation with specific behaviors and configurations.

### 4. Define Base Model Generation Support

#### Add to Base Model Generation Configuration
**File**: `src/shared/constants/base-model.constants.ts`

Add a new configuration entry to the `baseModelGenerationConfig` array:

```typescript
{
  group: 'YourBaseModel',
  support: [
    {
      modelTypes: [
        ModelType.Checkpoint,
        ModelType.TextualInversion,
        ModelType.LORA,
        ModelType.DoRA,
        ModelType.LoCon,
        ModelType.VAE,
      ],
      baseModels: ['YourBaseModel'],
    },
  ],
},
```

### 5. Add Generation Helper Functions

#### Update Generation Constants
**File**: `src/shared/constants/generation.constants.ts`

Add a detection function for your base model:

```typescript
export function getIsYourBaseModel(baseModel?: string) {
  const baseModelSetType = getBaseModelSetType(baseModel);
  return baseModelSetType === 'YourBaseModel';
}
```

Add the base model to the `getBaseModelFromResources` function's logic:

```typescript
else if (resourceBaseModels.some((baseModel) => baseModel === 'YourBaseModel')) return 'YourBaseModel';
```

### 6. Configure Server-Side Generation

#### Add Server Constants
**File**: `src/server/common/constants.ts`

Add a new entry to the `generationConfig` object:

```typescript
YourBaseModel: {
  aspectRatios: commonAspectRatios, // or define custom ratios
  checkpoint: {
    id: YOUR_CHECKPOINT_ID,
    name: 'Model Name',
    trainedWords: [],
    baseModel: 'YourBaseModel',
    strength: 1,
    minStrength: -1,
    maxStrength: 2,
    canGenerate: true,
    hasAccess: true,
    model: {
      id: YOUR_MODEL_ID,
      name: 'Your Model Name',
      type: 'Checkpoint',
    },
  } as GenerationResource,
},
```

#### Update Orchestrator Logic
**File**: `src/server/services/orchestrator/common.ts`

1. Import your detection function:
```typescript
import { getIsYourBaseModel } from '~/shared/constants/generation.constants';
```

2. Add base model-specific parameter handling in `parseGenerateImageInput`:
```typescript
const isYourBaseModel = getIsYourBaseModel(originalParams.baseModel);
if (isYourBaseModel) {
  originalParams.sampler = 'undefined';
  originalParams.draft = false;
  // Add any other base model-specific parameter overrides
}
```

### 7. Update UI Components

#### Modify Generation Form
**File**: `src/components/ImageGeneration/GenerationForm/GenerationForm2.tsx`

1. Import the detection function:
```typescript
import { getIsYourBaseModel } from '~/shared/constants/generation.constants';
```

2. Add the detection variable:
```typescript
const isYourBaseModel = getIsYourBaseModel(baseModel);
```

3. Update all conditional logic to include your base model where appropriate:
   - Disable draft mode: `!isFlux && !isSD3 && !isQwen && !isYourBaseModel`
   - Disable workflow selection: `isFlux || isSD3 || isQwen || isYourBaseModel`
   - Disable various features as needed (sampler, clip skip, VAE, etc.)
   - Update step and CFG scale ranges
   - Disable image input if not supported
   - Remove preset values for CFG scale and steps if using custom ranges

Example updates:
```typescript
// Disable draft
const disableDraft = !features.draft || /* other conditions */ || isYourBaseModel;

// Disable sampler
const disableSampler = isFlux || isQwen || isSD3 || isYourBaseModel;

// Adjust steps range
if (isFlux || isSD3 || isQwen || isYourBaseModel) {
  stepsMin = isDraft ? 4 : 20;
  stepsMax = isDraft ? 4 : 50;
}
```

### 8. Database Setup

Run the following SQL commands to enable the base model for generation:

```sql
-- Replace 'YourBaseModelType' with your actual base model name
-- Replace mainCheckpointId with your checkpoint's ID from the generationConfig

INSERT INTO "EcosystemCheckpoints" VALUES (mainCheckpointId, 'YourBaseModelType');
INSERT INTO "GenerationBaseModel" VALUES ('YourBaseModelType');
```

## Key Considerations

### Feature Compatibility

When adding a new base model, consider which features should be:

- **Disabled**: Draft mode, specific samplers, clip skip, VAE selection
- **Modified**: Step ranges, CFG scale ranges, aspect ratios
- **Maintained**: Image input, workflow selection, safety settings

### Parameter Overrides

Common parameter overrides for specialized base models:
- Set `sampler` to `'undefined'` for models with fixed sampling
- Disable `draft` mode for models that don't support it
- Adjust step and CFG scale ranges for optimal generation

### UI Updates

The generation form has extensive conditional logic that controls:
- Which form fields are visible/disabled
- Parameter ranges and presets
- Feature availability
- Warning messages and help text

Ensure all relevant conditionals include your new base model.

## Testing

After implementation:

1. Verify the base model appears in generation options
2. Test that disabled features are properly hidden/disabled
3. Confirm parameter ranges work correctly
4. Test actual generation functionality
5. Check that all UI states handle the new base model appropriately

## Example: Chroma Implementation

The Chroma base model implementation (commit `7332d648`) demonstrates:
- Disabling draft, sampler, clip skip, VAE, and workflow selection
- Setting custom step ranges (20-50 for non-draft)
- Setting custom CFG scale ranges (2-20)
- Disabling image input
- Removing preset values for parameters
- Proper database configuration

This serves as a reference for implementing similar specialized base models.

## Complete Implementation Timeline

The Chroma base model implementation demonstrates both parts of this process across two separate commits:

### Commit 1: Base Model Creation (`f594561`)
**"Add Chroma as a base model"**

This commit implemented Part 1 of the process:
- Added `Chroma` to the `baseModelConfig` array
- Added Apache 2.0 license mapping for Chroma  
- Added 'CHR' badge indicator for the UI

**Files Changed:**
- `src/shared/constants/base-model.constants.ts` - Added base model definition
- `src/server/common/constants.ts` - Added license mapping
- `src/components/Model/ModelTypeBadge/ModelTypeBadge.tsx` - Added badge

### Commit 2: Generation Enablement (`7332d64`)
**"add support for chroma base model in generator"**

This commit implemented Part 2 of the process:
- Added generation configuration and helper functions
- Added server-side parameter handling
- Updated UI components with conditional logic
- Configured generation-specific behaviors

**Files Changed:**
- `src/shared/constants/base-model.constants.ts` - Added generation config
- `src/shared/constants/generation.constants.ts` - Added helper functions
- `src/server/common/constants.ts` - Added generation resource config
- `src/server/services/orchestrator/common.ts` - Added parameter handling
- `src/components/ImageGeneration/GenerationForm/GenerationForm2.tsx` - Added UI logic

## Best Practices

### Staging Implementation
1. **Create the base model first** - Establish the foundational definition
2. **Test base model recognition** - Ensure it appears correctly in UI badges and model listings
3. **Enable generation gradually** - Add generation support with careful testing
4. **Validate all features** - Test all conditional logic and parameter handling

### Version Control
- Keep base model creation and generation enablement as separate commits when possible
- This allows for easier rollbacks and clearer change tracking
- Makes it easier to enable/disable generation without affecting the base model definition

### Testing Checklist
- [ ] Base model appears in model type badges
- [ ] License information displays correctly
- [ ] Generation form shows/hides appropriate controls
- [ ] Parameter ranges work as expected
- [ ] Database queries include the new base model
- [ ] All conditional UI logic handles the new model
- [ ] Generation requests process correctly with the new model