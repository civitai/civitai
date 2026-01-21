# Image Edit Training

This document describes the Image Edit training feature, which allows users to train image editing models using paired datasets.

## Overview

Image Edit training is a specialized training mode for training image-to-image transformation models. Unlike standard LoRA training which uses a single dataset, Image Edit training requires multiple paired datasets:
- **Target Dataset**: The final results you want the model to learn (e.g., logo already on shirt, background removed)
- **Control Datasets**: Input images that you want the model to modify or use as references (e.g., shirts, logos)

### Key Features
- Support for up to 4 datasets (1 target + 3 controls)
- Minimum 2 datasets required (1 target + 1 control)
- Image count validation across datasets (must match)
- Filename-based pairing (01.png in Target pairs with 01.png in Control)
- Restricted to specific models (Flux2, Qwen)

## Requirements

### Dataset Requirements

1. **Minimum 2 datasets**: 1 target dataset + at least 1 control dataset
2. **Maximum 4 datasets**: 1 target + up to 3 control datasets
3. **Image count must match**: All datasets must have the same number of images
4. **Filename matching**: Images are paired by filename across datasets
   - Example: `01.png` in Target pairs with `01.png` in Control 1 and `01.png` in Control 2
   - The order and naming must match for proper pairing

### Supported Models

Image Edit training is currently restricted to:
- **Flux2 Klein 4B/9B**
- **Flux 2 Dev** (when available)
- **Qwen Image Edit** (all versions)
- **Flux Kontext** (future)
- **Z Image Omni/Edit** (future)

```typescript
// src/components/Training/Form/TrainingBasicInfo.tsx
'Image Edit': {
  restrictedModels: ['flux2', 'qwen'],
}
```

### Labeling

Labeling (captions/tags) may not be required for Image Edit training. A general prompt like "put the logo on the shirt" may work without per-image labels. The UI has been simplified to remove labeling features - they can be added back if testing determines they're needed.

## Architecture

### Training Types

Image Edit is a training model type alongside existing types:

```typescript
// src/server/common/constants.ts
trainingModelTypes: ['Character', 'Style', 'Concept', 'Effect', 'Image Edit']
```

### Dataset Structure

```typescript
// src/store/training.store.ts
export type DatasetType = {
  id: number;                    // Dataset index (0 = Target, 1+ = Control)
  label: string;                 // User-defined or default label
  imageList: ImageDataType[];    // Images in this dataset
  initialImageList: ImageDataType[];
  triggerWord: string;           // Optional trigger word
  labelType: LabelTypes;         // 'tag' or 'caption' (for future use)
};
```

### Default Initialization

Datasets are initialized with Target + Control 1 by default:

```typescript
datasets: [
  createDefaultDataset(0),  // Target
  createDefaultDataset(1),  // Control 1
]
```

## UI Components

### TrainingDatasetsView

Located in `src/components/Training/Form/TrainingDatasets.tsx`:

Features:
- Tab-based dataset navigation
- Target badge on first dataset
- "Add Control Dataset" button (up to 4 total)
- Target dataset cannot be removed
- Control datasets can be removed (minimum 1 required)
- Image count mismatch warning alert
- Instructions explaining Target vs Control concepts

### Dataset Display

Each dataset shows:
- Dataset type badge (Target/Control)
- Description of what the dataset should contain
- Custom label input
- Image upload area with import options
- Image grid showing filenames (for pairing reference)

### Validation Alerts

The UI displays warnings when:
- Image counts don't match across datasets (orange alert)
- Instructions are shown explaining filename pairing requirements (blue info box)

## File Reference

| File | Purpose |
|------|---------|
| `src/server/common/constants.ts` | Training model types array |
| `src/store/training.store.ts` | Zustand store with dataset state |
| `src/components/Training/Form/TrainingDatasets.tsx` | Multi-dataset UI with Target/Control terminology |
| `src/components/Training/Form/TrainingImages.tsx` | Main training images component |
| `src/components/Training/Form/TrainingBasicInfo.tsx` | Training type selection with model restrictions |
| `src/server/schema/model-version.schema.ts` | Schema definitions for training details |

## Usage Flow

1. **Select Training Type**: User selects "Image Edit" on the training type page
2. **Model Selection**: Only Flux2 and Qwen models are available
3. **Dataset Management**:
   - Start with Target + Control 1 by default
   - Add more control datasets if needed (up to 3)
   - Cannot remove Target dataset
   - Must have at least 1 control dataset
4. **Image Upload**:
   - Upload images to each dataset
   - Ensure same number of images in all datasets
   - Ensure filenames match across datasets for proper pairing
5. **Submission**: Training job is submitted with all dataset information

## Examples

### Logo on Shirt Training

| Dataset | Purpose | Example Images |
|---------|---------|----------------|
| Target | Final results (logo on shirt) | `01.png` (shirt with logo), `02.png` (shirt with logo)... |
| Control 1 | T-shirts | `01.png` (plain shirt), `02.png` (plain shirt)... |
| Control 2 | Logos | `01.png` (logo), `02.png` (logo)... |

### Background Removal Training

| Dataset | Purpose | Example Images |
|---------|---------|----------------|
| Target | Results (background removed) | `01.png` (subject only), `02.png` (subject only)... |
| Control 1 | Original images | `01.png` (with background), `02.png` (with background)... |

## Future Enhancements

1. **Labeling support**: May be added back if testing determines it's needed
2. **Additional models**: Flux Kontext, Z Image Omni/Edit
3. **Orchestrator integration**: Full multi-file submission when API supports it
4. **Auto-pairing validation**: Verify filenames match across datasets before submission
