# AI Toolkit Training Implementation Plan

## Overview
This document outlines the plan to implement AI Toolkit training as a new training engine option in Civitai. Similar to how Rapid Training works for Flux models, AI Toolkit training will be a toggleable option that supports all training model types (SD1.5, SDXL, Flux.1, SD3, Wan, Hunyuan, Chroma).

## 🎯 Key Implementation Details

### Ecosystem and Model Variant Requirements
**Both `ecosystem` and `modelVariant` ARE required** (with specific rules per ecosystem):

| Ecosystem | Model Variant | Required? |
|-----------|---------------|-----------|
| `sd1` | N/A | No variant |
| `sdxl` | N/A | No variant |
| `sd3` | `"large"` (or `"medium"`) | **Required** |
| `flux1` | `"dev"` or `"schnell"` | **Required** |
| `wan` | `"2.1"` or `"2.2"` | **Required** |

### Excluded Parameters
The following parameters from Kohya training are **NOT** used in AI Toolkit and will be excluded:
- ❌ `numRepeats` - Not used by AI Toolkit
- ❌ `trainBatchSize` - Not used by AI Toolkit

These parameters are still present in the frontend state (for consistency with Kohya), but are **not sent** to the AI Toolkit API.

## Key Findings

### ✅ Client Types Available
The `@civitai/client` beta 12 package **already includes** all required types:
- `TrainingStep` / `TrainingStepTemplate` (with `$type: 'training'`)
- `TrainingInput` type with all required fields
- These types match the HTTP API examples exactly!

### 🔑 Critical Decision: Use New API Format
The civitai client exposes **two different training API formats**:

1. **Legacy Format** (`$type: 'imageResourceTraining'`):
   - Currently used for Kohya, Rapid, and Musubi engines
   - Uses `ImageResourceTrainingInput` type
   - Parameters: `maxTrainEpochs`, `unetLR`, `shuffleCaption`

2. **NEW Format** (`$type: 'training'`)  ← **We're using this for AI Toolkit**
   - Uses `TrainingStep` + `TrainingInput` types
   - Parameters: `epochs`, `lr`, `shuffleTokens` (different from Kohya)
   - Includes: `ecosystem` and `modelVariant` fields
   - Excludes: `numRepeats` and `trainBatchSize` (not used by AI Toolkit)

This means AI Toolkit will use a different step type and input format than the existing engines.

## Background

### Current Training System
- **Engines**: `kohya` (standard), `flux-dev-fast` (rapid), `musubi` (video)
- **Rapid Training**: Flux-only toggle that switches engine from `kohya` to `flux-dev-fast`
- **Location**: Toggle in `TrainingSubmitAdvancedSettings.tsx`

### New AI Toolkit Engine
The civitai client beta 12 exposes a new `TrainingInput` type that uses the `ai-toolkit` engine with support for:
- **SD1.5** (ecosystem: "sd1")
- **SDXL** (ecosystem: "sdxl")
- **Flux.1** (ecosystem: "flux1", modelVariant: "dev")
- **SD3** (ecosystem: "sd3", modelVariant: "large")
- **Wan** (ecosystem: "wan", modelVariant: "2.1")

## Implementation Plan

---

## Phase 1: Backend - Type Definitions & Schema Updates

### 1.1 Update Enums
**File**: `src/server/common/enums.ts`

**Changes**:
```typescript
export enum OrchEngineTypes {
  Kohya = 'kohya',
  Rapid = 'flux-dev-fast',
  Musubi = 'musubi',
  AiToolkit = 'ai-toolkit',  // NEW
}
```

**File**: `src/utils/training.ts`

**Changes**:
```typescript
export const engineTypes = ['kohya', 'rapid', 'musubi', 'ai-toolkit'] as const;
export type EngineTypes = (typeof engineTypes)[number];
```

### 1.2 Define AI Toolkit Parameter Schema
**File**: `src/server/schema/orchestrator/training.schema.ts`

**New Schema**:
```typescript
// AI Toolkit specific parameters - uses discriminated union for proper modelVariant validation
const aiToolkitBaseParams = z.object({
  engine: z.literal('ai-toolkit'),
  epochs: z.number(),
  resolution: z.number().nullable(),
  lr: z.number(),
  textEncoderLr: z.number().nullable(),
  trainTextEncoder: z.boolean(),
  lrScheduler: z.enum(['constant', 'constant_with_warmup', 'cosine', 'linear', 'step']),
  optimizerType: z.enum([
    'adam',
    'adamw',
    'adamw8bit',
    'adam8bit',
    'lion',
    'lion8bit',
    'adafactor',
    'adagrad',
    'prodigy',
    'prodigy8bit',
  ]),
  networkDim: z.number().nullable(),
  networkAlpha: z.number().nullable(),
  noiseOffset: z.number().nullable(),
  minSnrGamma: z.number().nullable(),
  flipAugmentation: z.boolean(),
  shuffleTokens: z.boolean(),
  keepTokens: z.number(),
});

// Use discriminated union to enforce modelVariant requirements per ecosystem
const aiToolkitTrainingParams = z.discriminatedUnion('ecosystem', [
  // SD1 and SDXL don't need modelVariant
  aiToolkitBaseParams.extend({
    ecosystem: z.literal('sd1'),
    modelVariant: z.undefined().optional(),
  }),
  aiToolkitBaseParams.extend({
    ecosystem: z.literal('sdxl'),
    modelVariant: z.undefined().optional(),
  }),
  // SD3, Flux1, and Wan require modelVariant
  aiToolkitBaseParams.extend({
    ecosystem: z.literal('sd3'),
    modelVariant: z.enum(['large', 'medium']),
  }),
  aiToolkitBaseParams.extend({
    ecosystem: z.literal('flux1'),
    modelVariant: z.enum(['dev', 'schnell']),
  }),
  aiToolkitBaseParams.extend({
    ecosystem: z.literal('wan'),
    modelVariant: z.enum(['2.1', '2.2']),
  }),
]);

export type AiToolkitTrainingParams = z.infer<typeof aiToolkitTrainingParams>;
```

**Update Union Type**:
```typescript
const imageTrainingStepSchema = imageTrainingBaseSchema.extend({
  // ... existing fields ...
  params: z.union([
    kohyaParams,
    fluxDevFastParams,
    musubiParams,
    aiToolkitTrainingParams,  // NEW
  ]),
});
```

**Important Notes**:
- AI Toolkit **excludes** `numRepeats` and `trainBatchSize` (not used)
- `ecosystem` is **required** for all AI Toolkit training
- `modelVariant` is **conditionally required**:
  - Not needed for `sd1`, `sdxl`
  - Required for `sd3`, `flux1`, `wan`
- Different parameter names than Kohya:
  - `epochs` instead of `maxTrainEpochs`
  - `lr` instead of `unetLR`
  - `textEncoderLr` instead of `textEncoderLR`
  - `shuffleTokens` instead of `shuffleCaption`

### 1.3 Update Civitai Client Import
**File**: `src/server/services/orchestrator/training/training.orch.ts`

**Add Import**:
```typescript
import {
  FluxDevFastImageResourceTrainingInput,
  ImageResourceTrainingStep,
  ImageResourceTrainingStepTemplate,
  KohyaImageResourceTrainingInput,
  MusubiImageResourceTrainingInput,
  TrainingStep,              // NEW - for ai-toolkit
  TrainingStepTemplate,      // NEW - for ai-toolkit
  TrainingInput,             // NEW - for ai-toolkit
} from '@civitai/client';
```

**IMPORTANT DISCOVERY**: The civitai client beta 12 has TWO training API formats:

1. **Legacy Format** (currently used):
   - Step type: `ImageResourceTrainingStep` with `$type: 'imageResourceTraining'`
   - Input type: `ImageResourceTrainingInput` (+ variants like KohyaImageResourceTrainingInput)
   - Uses: `maxTrainEpochs`, no `ecosystem`/`modelVariant`

2. **NEW Format** (for AI Toolkit):
   - Step type: `TrainingStep` with `$type: 'training'`
   - Input type: `TrainingInput`
   - Uses: `epochs`, `ecosystem`, `modelVariant`
   - **This matches your HTTP examples exactly!**

**Decision**: We will use the NEW format (`TrainingStep` + `TrainingInput`) for AI Toolkit training.

### 1.4 Add AI Toolkit Training Step Creator
**File**: `src/server/services/orchestrator/training/training.orch.ts`

**Add New Function** (similar to existing `createTrainingStep_Run` but for the new format):

```typescript
// NEW: Create training step using the new TrainingStep format (for ai-toolkit)
const createTrainingStep_AiToolkit = (
  input: ImageTrainingStepSchema
): TrainingStepTemplate => {
  const {
    model,
    priority,
    loraName,
    trainingData,
    trainingDataImagesCount,
    samplePrompts,
    negativePrompt,
    modelFileId,
    params,
  } = input;

  const aiToolkitParams = params as AiToolkitTrainingParams;

  const trainingInput: TrainingInput = {
    engine: 'ai-toolkit',
    ecosystem: aiToolkitParams.ecosystem,
    model,
    ...(aiToolkitParams.modelVariant && { modelVariant: aiToolkitParams.modelVariant }),
    trainingData: {
      type: 'zip',
      sourceUrl: trainingData,
      count: trainingDataImagesCount,
    },
    samples: {
      prompts: samplePrompts,
    },
    epochs: aiToolkitParams.epochs,
    // NOTE: numRepeats and trainBatchSize are NOT included (not used by AI Toolkit)
    resolution: aiToolkitParams.resolution,
    lr: aiToolkitParams.lr,
    textEncoderLr: aiToolkitParams.textEncoderLr,
    trainTextEncoder: aiToolkitParams.trainTextEncoder,
    lrScheduler: aiToolkitParams.lrScheduler,
    optimizerType: aiToolkitParams.optimizerType,
    networkDim: aiToolkitParams.networkDim,
    networkAlpha: aiToolkitParams.networkAlpha,
    noiseOffset: aiToolkitParams.noiseOffset,
    minSnrGamma: aiToolkitParams.minSnrGamma,
    flipAugmentation: aiToolkitParams.flipAugmentation,
    shuffleTokens: aiToolkitParams.shuffleTokens,
    keepTokens: aiToolkitParams.keepTokens,
  };

  return {
    $type: 'training',
    metadata: { modelFileId },
    priority,
    retries: constants.maxTrainingRetries,
    input: trainingInput,
  };
};
```

**Update `createTrainingStep` dispatcher** to route to the correct function:

```typescript
const createTrainingStep = (
  input: ImageTrainingStepSchema
): ImageResourceTrainingStepTemplate | TrainingStepTemplate => {
  const { engine } = input;

  if (engine === 'ai-toolkit') {
    return createTrainingStep_AiToolkit(input);
  } else {
    return createTrainingStep_Run(input);  // Existing function for kohya, rapid, musubi
  }
};
```

### 1.5 Ecosystem Mapping for AI Toolkit
**File**: `src/utils/training.ts` (or backend helper)

**Add Ecosystem Mapping Function**:
```typescript
import { getBaseModelEcosystem } from '~/shared/constants/base-model.constants';

/**
 * Map civitai ecosystem (from getBaseModelEcosystem) to AI Toolkit ecosystem format
 */
export function getAiToolkitEcosystem(baseModel: string): string | null {
  const civitaiEcosystem = getBaseModelEcosystem(baseModel);

  // Ecosystem mapping for AI Toolkit API
  const ecosystemMap: Record<string, string> = {
    // SD 1.x variants
    'sd1': 'sd1',

    // SDXL variants (including Pony, Illustrious, NoobAI which have ecosystem: 'sdxl')
    'sdxl': 'sdxl',
    'pony': 'sdxl',
    'illustrious': 'sdxl',
    'noobai': 'sdxl',

    // Flux variants
    'flux1': 'flux1',

    // SD3 variants
    'sd3': 'sd3',
    'sd3_5m': 'sd3',  // SD 3.5 Medium has ecosystem: 'sd3'

    // Video models - all Wan/Hunyuan variants map to 'wan'
    'wanvideo': 'wan',
    'wanvideo14b_t2v': 'wan',
    'wanvideo14b_i2v_480p': 'wan',
    'wanvideo14b_i2v_720p': 'wan',
    'wanvideo-22-t2v-a14b': 'wan',
    'wanvideo-22-i2v-a14b': 'wan',
    'wanvideo-22-ti2v-5b': 'wan',
    'wanvideo-25-t2v': 'wan',
    'wanvideo-25-i2v': 'wan',
    'hyv1': 'wan',  // Hunyuan maps to wan ecosystem
  };

  const mapped = ecosystemMap[civitaiEcosystem.toLowerCase()];
  if (!mapped) {
    console.warn(`Unknown ecosystem for AI Toolkit: ${civitaiEcosystem}`);
    return null;
  }

  return mapped;
}

/**
 * Get model variant for AI Toolkit based on base model
 */
export function getAiToolkitModelVariant(
  baseModel: TrainingDetailsBaseModel
): string | undefined {
  // Model variant mapping based on specific models
  const variantMap: Partial<Record<TrainingDetailsBaseModelList, string>> = {
    // Flux variants
    'flux_dev': 'dev',
    // 'flux_schnell': 'schnell',  // if/when added

    // SD3 variants
    // 'sd3_medium': 'medium',  // if/when enabled
    // 'sd3_large': 'large',    // if/when enabled

    // Wan variants - determine from model name
    'wan_2_1_t2v_14b': '2.1',
    'wan_2_1_i2v_14b_720p': '2.1',
    // Wan 2.2 models would be '2.2'
  };

  // If it's a custom model (civitai:xxx@yyy or AIR format), try to infer from URN
  if (typeof baseModel === 'string' && baseModel.includes('civitai:')) {
    return undefined;
  }

  return variantMap[baseModel as TrainingDetailsBaseModelList];
}
```

**Model URN Handling**:
The model URN (AIR format) is still passed in the `model` field. Example URNs:
- SD1.5: `urn:air:sd1:checkpoint:civitai:4384@128713`
- SDXL: `urn:air:sdxl:checkpoint:civitai:101055@128078`
- Flux: `urn:air:flux1:checkpoint:civitai:1330309@2164239`
- SD3: `urn:air:sd3:checkpoint:civitai:139562@782002`
- Wan: `urn:air:wanvideo:checkpoint:civitai:1329096@1501344`

---

## Phase 2: Backend - Feature Flag Implementation

### 2.1 Add Feature Flag
**File**: `src/server/services/feature-flags.service.ts`

**Add Flag** (around line 85):
```typescript
const featureFlags = {
  // ... existing flags ...
  aiToolkitTraining: {
    displayName: 'AI Toolkit Training',
    description: 'Enable AI Toolkit as a training engine option',
    availability: ['mod'],  // Start with mods only for testing
    toggleable: true,
    default: false,
  },
  // ... rest of flags ...
};
```

**Rollout Strategy**:
1. **Phase 1**: `['mod']` - Moderators only for testing
2. **Phase 2**: `['bronze', 'silver', 'gold']` - Paid tiers
3. **Phase 3**: `['user']` - All authenticated users

### 2.2 Environment Variable Override
Add support for `FEATURE_FLAG_AI_TOOLKIT_TRAINING=true` in environment variables for testing.

---

## Phase 3: Frontend - UI Components

### 3.1 Add AI Toolkit Toggle
**File**: `src/components/Training/Form/TrainingSubmitAdvancedSettings.tsx`

**Add After Rapid Training Toggle** (around line 222):

```tsx
{/* AI Toolkit Training Toggle */}
{hasFeature('aiToolkitTraining') && isAiToolkitSupported(selectedRun.baseType) && (
  <Group mt="md">
    <Switch
      label={
        <Group gap={4} wrap="nowrap">
          <InfoPopover type="hover" size="xs" iconProps={{ size: 16 }}>
            <Text>
              Train using the AI Toolkit engine, offering improved quality and flexibility.
              {selectedRun.baseType === 'flux' && selectedRun.params.engine === 'rapid' && (
                <> Note: Enabling AI Toolkit will disable Rapid Training.</>
              )}
            </Text>
          </InfoPopover>
          <Text>AI Toolkit Training</Text>
          <Badge color="blue" size="xs">Beta</Badge>
        </Group>
      }
      labelPosition="left"
      checked={selectedRun.params.engine === 'ai-toolkit'}
      // Disable if Rapid Training is enabled (mutually exclusive)
      disabled={selectedRun.params.engine === 'rapid'}
      onChange={(event) => {
        const newEngine = event.currentTarget.checked ? 'ai-toolkit' : getDefaultEngine(selectedRun.baseType);

        updateRun(modelId, mediaType, selectedRun.id, {
          params: { ...selectedRun.params, engine: newEngine },
        });
      }}
    />
  </Group>
)}
```

**Important**: Also update the Rapid Training toggle to be disabled when AI Toolkit is enabled:

```tsx
{selectedRun.baseType === 'flux' && (
  <Group mt="md">
    <Switch
      label={...}
      labelPosition="left"
      checked={selectedRun.params.engine === 'rapid'}
      // Disable if AI Toolkit is enabled (mutually exclusive)
      disabled={selectedRun.params.engine === 'ai-toolkit'}
      onChange={(event) =>
        updateRun(modelId, mediaType, selectedRun.id, {
          params: { engine: event.currentTarget.checked ? 'rapid' : 'kohya' },
        })
      }
    />
  </Group>
)}
```

### 3.2 Add Helper Functions
**File**: `src/utils/training.ts`

**New Functions**:
```typescript
import { getBaseModelEcosystem } from '~/shared/constants/base-model.constants';

// Check if base model supports AI Toolkit
export const isAiToolkitSupported = (baseType: TrainingBaseModelType): boolean => {
  // AI Toolkit supports all base model types
  const supportedTypes: TrainingBaseModelType[] = ['sd15', 'sdxl', 'flux', 'sd35', 'video', 'hunyuan', 'wan', 'chroma'];
  return supportedTypes.includes(baseType);
};

// Get ecosystem string for AI Toolkit (mirrors backend function)
export const getAiToolkitEcosystem = (baseModel: string): string | null => {
  const civitaiEcosystem = getBaseModelEcosystem(baseModel);

  const ecosystemMap: Record<string, string> = {
    'sd1': 'sd1',
    'sdxl': 'sdxl',
    'pony': 'sdxl',
    'illustrious': 'sdxl',
    'noobai': 'sdxl',
    'flux1': 'flux1',
    'sd3': 'sd3',
    'sd3_5m': 'sd3',
    'wanvideo': 'wan',
    'wanvideo14b_t2v': 'wan',
    'wanvideo14b_i2v_480p': 'wan',
    'wanvideo14b_i2v_720p': 'wan',
    'wanvideo-22-t2v-a14b': 'wan',
    'wanvideo-22-i2v-a14b': 'wan',
    'wanvideo-22-ti2v-5b': 'wan',
    'wanvideo-25-t2v': 'wan',
    'wanvideo-25-i2v': 'wan',
    'hyv1': 'wan',
  };

  return ecosystemMap[civitaiEcosystem.toLowerCase()] || null;
};

// Get model variant for AI Toolkit
export const getAiToolkitModelVariant = (
  baseModel: TrainingDetailsBaseModel
): string | undefined => {
  const variantMap: Partial<Record<TrainingDetailsBaseModelList, string>> = {
    'flux_dev': 'dev',
    'wan_2_1_t2v_14b': '2.1',
    'wan_2_1_i2v_14b_720p': '2.1',
  };

  if (typeof baseModel === 'string' && baseModel.includes('civitai:')) {
    return undefined;
  }

  return variantMap[baseModel as TrainingDetailsBaseModelList];
};

// Get default engine for base type
export const getDefaultEngine = (baseType: TrainingBaseModelType): EngineTypes => {
  if (baseType === 'video') return 'musubi';
  return 'kohya';
};

// Check if AI Toolkit is valid for the model
export const isValidAiToolkit = (
  baseModel: TrainingBaseModelType,
  engine: EngineTypes
): boolean => {
  return isAiToolkitSupported(baseModel) && engine === 'ai-toolkit';
};

// Check if AI Toolkit is invalid for the model
export const isInvalidAiToolkit = (
  baseModel: TrainingBaseModelType,
  engine: EngineTypes
): boolean => {
  return !isAiToolkitSupported(baseModel) && engine === 'ai-toolkit';
};
```

### 3.3 Update Parameter Defaults
**File**: `src/components/Training/Form/TrainingParams.tsx`

**Add AI Toolkit Parameter Overrides**:

```typescript
export const trainingSettings = {
  // ... existing settings ...

  // AI Toolkit specific settings
  aiToolkit: {
    sd15: {
      resolution: [512],
      epochs: { min: 5, max: 20, default: 5 },
      trainBatchSize: { min: 1, max: 4, default: 2 },
      lr: 0.0001,
      textEncoderLr: 0.00005,
      trainTextEncoder: true,
      networkDim: { min: 16, max: 64, default: 32 },
      networkAlpha: { min: 16, max: 64, default: 32 },
    },
    sdxl: {
      resolution: [1024],
      epochs: { min: 5, max: 20, default: 5 },
      trainBatchSize: { min: 1, max: 2, default: 2 },
      lr: 0.0001,
      textEncoderLr: 0.00005,
      trainTextEncoder: true,
      networkDim: { min: 16, max: 64, default: 32 },
      networkAlpha: { min: 16, max: 64, default: 32 },
    },
    flux1: {
      resolution: [1024],
      epochs: { min: 5, max: 20, default: 5 },
      trainBatchSize: { min: 1, max: 1, default: 1 },
      lr: 0.0001,
      textEncoderLr: null,
      trainTextEncoder: false,
      networkDim: { min: 8, max: 32, default: 16 },
      networkAlpha: { min: 8, max: 32, default: 16 },
    },
    sd3: {
      resolution: [1024],
      epochs: { min: 5, max: 20, default: 5 },
      trainBatchSize: { min: 1, max: 1, default: 1 },
      lr: 0.0001,
      textEncoderLr: null,
      trainTextEncoder: false,
      networkDim: { min: 8, max: 32, default: 16 },
      networkAlpha: { min: 8, max: 32, default: 16 },
    },
    wan: {
      resolution: [512],
      epochs: { min: 2, max: 10, default: 2 },
      trainBatchSize: { min: 1, max: 1, default: 1 },
      lr: 0.0002,
      textEncoderLr: null,
      trainTextEncoder: false,
      networkDim: { min: 16, max: 64, default: 32 },
      networkAlpha: { min: 16, max: 64, default: 32 },
    },
  },
};
```

### 3.4 Update Parameter Visibility
**File**: `src/components/Training/Form/TrainingParams.tsx` (or wherever params are rendered)

**Hide AI Toolkit-incompatible parameters**:

```tsx
{/* Only show numRepeats for non-AI-Toolkit engines */}
{selectedRun.params.engine !== 'ai-toolkit' && (
  <NumberInput
    label="Num Repeats"
    value={selectedRun.params.numRepeats}
    onChange={(value) => updateRun(...)}
  />
)}

{/* Only show trainBatchSize for non-AI-Toolkit engines */}
{selectedRun.params.engine !== 'ai-toolkit' && (
  <NumberInput
    label="Train Batch Size"
    value={selectedRun.params.trainBatchSize}
    onChange={(value) => updateRun(...)}
  />
)}

{/* All other parameters are shown for both engines */}
<NumberInput
  label="Epochs"
  value={selectedRun.params.maxTrainEpochs}
  onChange={(value) => updateRun(...)}
/>
{/* ... other shared parameters ... */}
```

### 3.5 Update Form Validation
**File**: `src/components/Training/Form/TrainingSubmit.tsx`

**Add Validation** in `handleSubmit()` (around line 280):

```typescript
// Check if ai-toolkit is invalid for base model
if (isInvalidAiToolkit(run.baseType, run.params.engine)) {
  showErrorNotification({
    title: 'Invalid Training Configuration',
    error: new Error(
      `AI Toolkit training is not supported for ${run.baseType} models. Please disable AI Toolkit or select a different model.`
    ),
  });
  return;
}
```

### 3.6 Add AI Toolkit Info Badge
**File**: `src/components/Training/Form/TrainingSubmit.tsx`

**Add Visual Indicator** near the cost/ETA section:

```tsx
{selectedRun.params.engine === 'ai-toolkit' && (
  <Alert color="blue" variant="light" icon={<IconSparkles size={16} />}>
    <Text size="sm">
      Training with AI Toolkit engine for improved quality and flexibility.
    </Text>
  </Alert>
)}
```

---

## Phase 4: Frontend - Parameter Mapping

### 4.1 Update Training Store
**File**: `src/store/training.store.ts`

**Add Getter for AI Toolkit Params**:
```typescript
// Helper to transform params for AI Toolkit API submission
getAiToolkitParams: (runId: number) => {
  const run = get().runs.find(r => r.id === runId);
  if (!run || run.params.engine !== 'ai-toolkit') return null;

  // Get ecosystem and model variant
  const ecosystem = getAiToolkitEcosystem(run.base);
  const modelVariant = getAiToolkitModelVariant(run.base);

  if (!ecosystem) {
    console.error('Failed to determine ecosystem for AI Toolkit training');
    return null;
  }

  // Transform parameter names from internal Kohya-style to AI Toolkit API format
  return {
    engine: 'ai-toolkit',
    ecosystem,
    modelVariant,
    epochs: run.params.maxTrainEpochs,
    // NOTE: numRepeats and trainBatchSize are NOT included (not used by AI Toolkit)
    resolution: run.params.resolution,
    lr: run.params.unetLR,
    textEncoderLr: run.params.textEncoderLR || null,
    trainTextEncoder: !!run.params.textEncoderLR,
    lrScheduler: run.params.lrScheduler,
    optimizerType: run.params.optimizerType,
    networkDim: run.params.networkDim,
    networkAlpha: run.params.networkAlpha,
    noiseOffset: run.params.noiseOffset || null,
    minSnrGamma: run.params.minSnrGamma || null,
    flipAugmentation: run.params.flipAugmentation || false,
    shuffleTokens: run.params.shuffleCaption,
    keepTokens: run.params.keepTokens,
  };
},
```

**Note**: The internal state still uses Kohya-style names (`maxTrainEpochs`, `unetLR`, `shuffleCaption`) for consistency. Only at submission time do we:
1. Transform to AI Toolkit names (`epochs`, `lr`, `shuffleTokens`)
2. Add `ecosystem` and `modelVariant` fields
3. Exclude `numRepeats` and `trainBatchSize`

### 4.2 Update Submission Handler
**File**: `src/components/Training/Form/TrainingSubmit.tsx`

**Update `handleConfirm()`** (around line 400):

```typescript
runs.forEach(async (run, idx) => {
  // ... existing code ...

  let params: any = { ...run.params };

  // Transform params for AI Toolkit
  if (run.params.engine === 'ai-toolkit') {
    const aiToolkitParams = getAiToolkitParams(run.id);
    if (!aiToolkitParams) {
      console.error('Failed to get AI Toolkit params');
      return;
    }
    params = aiToolkitParams;
  }

  // Check if engine is invalid for base model
  if (isInvalidAiToolkit(run.baseType, run.params.engine)) {
    showErrorNotification({
      title: 'Invalid Training Configuration',
      error: new Error('AI Toolkit training is not supported for this model'),
    });
    return;
  }

  // ... rest of submission logic ...
});
```

---
## Phase 5: Rollout & Documentation

### 5.1 Feature Flag Rollout Plan

#### Week 1-2: Internal Testing
- Enable for moderators only: `['mod']`
- Test all supported ecosystems
- Gather feedback and fix issues

#### Week 3-4: Paid Tier Beta
- Expand to paid tiers: `['bronze', 'silver', 'gold']`
- Monitor training success rates
- Optimize parameter defaults if needed

#### Week 5+: Public Release
- Enable for all users: `['user']`
- Monitor system load and costs
- Gather user feedback

### 5.2 Documentation Updates

#### User Documentation
- [ ] Create guide: "Training with AI Toolkit"
- [ ] Document parameter differences vs. Kohya
- [ ] Add FAQ section
- [ ] Create comparison table

#### Developer Documentation
- [ ] Update API documentation
- [ ] Document new training input schema
- [ ] Add troubleshooting guide
- [ ] Update architecture diagrams

---

## Phase 6: Monitoring & Optimization

### 6.1 Metrics to Track
- Training success rate by engine type
- Average training duration (AI Toolkit vs. Kohya)
- Cost per training (AI Toolkit vs. Kohya)
- User adoption rate
- Error rates and common failure modes

### 6.2 Performance Optimization
- Monitor queue times for AI Toolkit jobs
- Optimize default parameters based on success rates
- A/B test parameter configurations

---

## Open Questions & Decisions Needed

### Critical Questions
1. ✅ **Client Type Availability**: CONFIRMED - `@civitai/client` beta 12 exposes `TrainingInput`, `TrainingStep`, and `TrainingStepTemplate` types that match the HTTP API examples exactly.

2. ✅ **Parameter Mapping**: CONFIRMED - The `TrainingInput` type uses the correct parameter names (`epochs`, `lr`, `textEncoderLr`, `shuffleTokens`, etc.) that match the HTTP examples.

3. ✅ **Parameter Mapping**: CONFIRMED - The parameter name mappings are:
   - `unetLR` → `lr` ✓
   - `textEncoderLR` → `textEncoderLr` ✓
   - `maxTrainEpochs` → `epochs` ✓
   - `shuffleCaption` → `shuffleTokens` ✓

4. ✅ **Ecosystem Mapping**: CONFIRMED using `getBaseModelEcosystem()` with mapping to AI Toolkit format:
   - SD1.5 → `"sd1"` (no variant)
   - SDXL (including Pony, Illustrious, NoobAI) → `"sdxl"` (no variant)
   - Flux → `"flux1"` (variant: `"dev"` or `"schnell"`)
   - SD3 (including SD 3.5 Medium) → `"sd3"` (variant: `"large"` or `"medium"`)
   - Wan Video/Hunyuan → `"wan"` (variant: `"2.1"` or `"2.2"`)

5. ✅ **Excluded Parameters**: `numRepeats` and `trainBatchSize` are NOT used by AI Toolkit

### Design Decisions (Confirmed)
6. ✅ **Cost Structure**: Cost will be provided by the orchestrator just like Kohya. A whatif request will be made to get pricing.

7. ✅ **UI/UX - Mutually Exclusive**: AI Toolkit and Rapid Training should be **mutually exclusive toggles** (only one can be enabled at a time).
   - When AI Toolkit is enabled, Rapid Training must be disabled
   - When Rapid Training is enabled, AI Toolkit must be disabled

8. ✅ **Default Engine**: AI Toolkit will be **opt-in initially** (not the default engine)

9. ✅ **Parameter Visibility**: **Yes, only show parameters relevant to AI Toolkit** when it's enabled:
   - Hide: `numRepeats`, `trainBatchSize` (not used by AI Toolkit)
   - Show: All other standard training parameters

10. ✅ **Error Handling**: Initially, just error out if AI Toolkit is selected but backend doesn't support it

---

## File Change Summary

### Backend Files to Modify
1. `src/server/common/enums.ts` - Add `AiToolkit` to `OrchEngineTypes`
2. `src/utils/training.ts` - Add 'ai-toolkit' to `engineTypes`
3. `src/server/schema/orchestrator/training.schema.ts` - Add AI Toolkit params schema
4. `src/server/services/orchestrator/training/training.orch.ts` - Add transformation logic
5. `src/server/services/feature-flags.service.ts` - Add feature flag

### Frontend Files to Modify
1. `src/components/Training/Form/TrainingSubmitAdvancedSettings.tsx` - Add toggle
2. `src/utils/training.ts` - Add helper functions
3. `src/components/Training/Form/TrainingParams.tsx` - Add parameter defaults
4. `src/components/Training/Form/TrainingSubmit.tsx` - Add validation & submission logic
5. `src/store/training.store.ts` - Add AI Toolkit param getter

### New Files to Create
None required - all changes are modifications to existing files.

---

## Timeline Estimate

- **Phase 1 (Backend Types)**: 1-1.5 days
- **Phase 2 (Feature Flag)**: 0.5 day
- **Phase 3 (Frontend UI)**: 2-3 days
  - Including mutually exclusive toggles
  - Parameter visibility logic
- **Phase 4 (Parameter Mapping)**: 1-1.5 days
- **Phase 5 (Rollout & Documentation)**: 1-2 days
- **Phase 6 (Monitoring)**: Ongoing

**Total Estimated Time**: 6-9 days (1-2 weeks)**

---

## Risk Assessment

### High Risk
- **Backend Support**: AI Toolkit backend must be ready and tested before frontend can be fully enabled

### Medium Risk
- **Ecosystem Mapping Errors**: Incorrect ecosystem or variant mapping could cause training failures
- **Parameter Mapping Errors**: Incorrect parameter name transformations could cause training failures (mitigated by testing)
- **Cost Estimation**: If pricing differs, whatif queries need to handle AI Toolkit engine

### Low Risk
- ✅ **Civitai Client Compatibility**: CONFIRMED - Beta 12 has all required types
- **UI/UX Changes**: Toggle implementation is straightforward based on Rapid Training pattern
- **Feature Flag**: Well-established pattern in the codebase

---

## Success Criteria

### Launch Criteria
- [ ] AI Toolkit toggle works for all supported models
- [ ] AI Toolkit and Rapid Training are mutually exclusive
- [ ] Parameters `numRepeats` and `trainBatchSize` are hidden when AI Toolkit is enabled
- [ ] Parameter transformation is correct (ecosystem, modelVariant, parameter names)
- [ ] Cost estimation works with AI Toolkit engine (whatif query)
- [ ] Training submission succeeds for all supported ecosystems
- [ ] Feature flag controls access correctly

### Post-Launch Metrics
- [ ] 90%+ training success rate with AI Toolkit
- [ ] Positive user feedback
- [ ] No significant increase in support tickets
- [ ] Adoption rate of 20%+ within first month

---

## Notes
- Implementation should follow the existing Rapid Training pattern for consistency
- Keep AI Toolkit as an opt-in feature initially
- Monitor backend capacity before expanding access
- Consider adding telemetry to track parameter usage patterns

## Summary of Key Technical Decisions

### 1. Two API Formats in Civitai Client
The implementation needs to handle two different training API formats:
- **Legacy**: `ImageResourceTrainingStep` (`$type: 'imageResourceTraining'`)
- **New**: `TrainingStep` (`$type: 'training'`) ← **Using this for AI Toolkit**

### 2. Ecosystem and Model Variant Mapping
**Required Fields**: Both `ecosystem` and `modelVariant` are included in the AI Toolkit input.

**Ecosystem Mapping** (using `getBaseModelEcosystem()`):
- Civitai uses detailed ecosystem names: `sd1`, `sdxl`, `flux1`, `sd3`, `hyv1`, `wanvideo14b_t2v`, etc.
- AI Toolkit expects simplified names: `sd1`, `sdxl`, `flux1`, `sd3`, `wan`
- All Wan/Hunyuan variants map to `wan`

**Model Variant Rules**:
- `sd1`, `sdxl`: No variant needed
- `sd3`: Requires variant (`"large"` or `"medium"`)
- `flux1`: Requires variant (`"dev"` or `"schnell"`)
- `wan`: Requires variant (`"2.1"` or `"2.2"`)

### 3. Supported Models (Based on Current Training System)
All current training models will support AI Toolkit:
- **SD 1.5**: 4 variants (sd_1_5, anime, semi, realistic)
- **SDXL**: 3 variants (sdxl, pony, illustrious)
- **Flux**: 1 variant (flux_dev)
- **Wan Video**: 2 variants (wan_2_1_t2v_14b, wan_2_1_i2v_14b_720p)
- **Hunyuan**: 1 variant (hy_720_fp8)
- **Chroma**: 1 variant (chroma)
- **SD3**: 0 variants (currently commented out, but ready for future)

### 4. Parameter Handling
**Name Transformations** - Frontend state uses Kohya-style naming, AI Toolkit API needs:
- `maxTrainEpochs` → `epochs`
- `unetLR` → `lr`
- `textEncoderLR` → `textEncoderLr`
- `shuffleCaption` → `shuffleTokens`

**Excluded Parameters** - These are NOT sent to AI Toolkit:
- ❌ `numRepeats` - Not used by AI Toolkit
- ❌ `trainBatchSize` - Not used by AI Toolkit

**Added Parameters** - These are computed and added:
- ✅ `ecosystem` - Derived from base model using `getAiToolkitEcosystem()`
- ✅ `modelVariant` - Derived from base model using `getAiToolkitModelVariant()` (conditional)

Transformation happens in the submission handler.
