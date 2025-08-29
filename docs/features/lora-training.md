# LoRA Training System

This document explains how LoRA training works in Civitai, from user image upload through orchestrator processing to final model delivery.

## Architecture Overview

LoRA training uses a distributed orchestration system:
1. User uploads training images and configures parameters
2. System packages data and submits to orchestrator
3. Orchestrator manages GPU resources and runs training
4. Results are delivered back as a downloadable LoRA model

## Training Engines

### Available Engines
```typescript
enum OrchEngineTypes {
  Kohya = 'kohya',        // Traditional SD 1.5/SDXL training
  Rapid = 'flux-dev-fast', // Rapid Flux training, FAL
  Musubi = 'musubi',      // Alternative training engine primarily for video
}
```

## Training Workflow

### 1. Image Preparation

Users upload training images/videos.

### 2. Auto-Labeling Services

Optional AI-powered image labeling. Users can label media themselves or through the service.

- "Label" is the generic term
- "Caption" is the term for sentence-like descriptions
- "Tag" is for token-based descriptions

### 3. Training Parameters

Users select the model they want to train on (defined list or custom models), the training engine (specific models), and can tune the training parameters (advanced).
They can also set custom prompts for the sample images.
Prices are returned from the orchestrator.

### 4. Submission to Orchestrator

Training job is created and sent to the orchestrator. Users will receive real-time updates through a callback webhook (resource-training-v2).
Various statuses are handled here (errors, progress, completed). Jobs can be paused/denied for age verification.

### Asset Migration
Once complete, users will select the epoch they want. This requires a moveAsset/copyAsset job to complete to forward the data to a public bucket.

```typescript
const moveAsset = async ({ url, modelVersionId }) => {
  // Extract from orchestrator temp storage
  const { jobId, assetName } = parseOrchestratorUrl(url);
  
  // Copy to permanent storage
  const destination = `modelVersion/${modelVersionId}/${assetName}`;
  
  await orchestrator.copyAsset({
    jobId,
    assetName,
    destinationUri: s3Url,
  });
};
```

## Status & Monitoring

### Training Service Status
```typescript
interface TrainingServiceStatus {
  available: boolean;
  message?: string;
  blockedModels?: string[];  // Temporarily disabled models
  maxImages?: number;
  maxRetries?: number;
}
```

Stored in Redis: `REDIS_SYS_KEYS.TRAINING.STATUS`

### Training States
```typescript
enum TrainingStatus {
  Pending = 'Pending',
  Submitted = 'Submitted',
  Processing = 'Processing',
  InReview = 'InReview',
  Approved = 'Approved',
  Published = 'Published',
  Failed = 'Failed',
}
```

## Webhooks & Callbacks

### Workflow Events
```typescript
const callbacks = [{
  url: `${WEBHOOK_URL}/resource-training-v2/${modelVersionId}`,
  type: [
    'workflow:started',
    'workflow:completed', 
    'workflow:failed',
    'step:*',
  ],
}];
```

### Common Failures
- **Invalid Images**: Format/size validation
- **OOM**: Reduce batch size or resolution

## Adding New Training Models

Adding support for a new base model requires coordination across multiple systems, and depends on if it's a brand-new ecosystem or not:

### 1. Model Configuration (`src/utils/training.ts`)

Add the model to `trainingModelInfo`:
```typescript
export const trainingModelInfo = {
  new_model: {
    label: 'Display Name',
    pretty: 'Short Name',
    type: 'sdxl',              // Base type: sd15, sdxl, flux, etc.
    description: 'Model description for users',
    air: 'urn:air:...',        // AIR identifier for model
    baseModel: 'SDXL 1.0',     // Base model category
    isNew: true,               // Show "NEW" badge
    disabled: false,           // Enable/disable in UI
  }
};
```

### 2. Training Parameters (`src/components/Training/Form/TrainingParams.tsx`)

Configure default settings and overrides in `trainingSettings`:
```
{
  name: 'maxTrainEpochs',
  // ... base config
  overrides: {
    new_model: {
      all: { default: 10, min: 1, max: 100 },
      kohya: { default: 8 },      // Engine-specific
      rapid: { disabled: true },  // Disable for specific engines
    }
  }
}
```

### 3. Orchestrator/Worker Integration

Work with ops to have this handled on the orch/worker side, as well as pricing if necessary.

### 5. Validation & Testing

#### Pre-launch Checklist
- [ ] Model loads correctly
- [ ] Default parameters produce quality results
- [ ] Cost calculations are accurate
- [ ] Queue position and ETA estimates work
- [ ] Sample generation during training functions
