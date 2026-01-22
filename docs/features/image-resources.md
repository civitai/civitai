# Image Resource Tracking

Track which models, LoRAs, and other resources were used to generate images.

## Overview

The image resource system detects and stores information about which AI models and resources were used to create each image. This enables features like:
- Model attribution on images
- Filtering images by model used
- Validating resource usage for contests/competitions

## Key Files

| File | Purpose |
|------|---------|
| `prisma/schema.full.prisma` | `ImageResourceNew` model definition (lines 1565-1575) |
| `src/server/services/image.service.ts` | `getImageResources()`, `getImageResourcesFromImageId()` |
| `src/server/redis/caches.ts` | `imageResourcesCache` (lines 976-1018) |
| `prisma/programmability/get_image_resources.sql` | Detection function |

## Schema

```prisma
model ImageResourceNew {
  imageId        Int
  modelVersionId Int
  strength       Int?
  detected       Boolean @default(false)
  @@id([imageId, modelVersionId])
}
```

## Usage

### Fetching Resources for an Image

```typescript
import { imageResourcesCache } from '~/server/redis/caches';

// Get all resources used in an image (cached)
const resources = await imageResourcesCache.fetch(imageId);

// Resources include:
// - modelVersionId: The model version used
// - strength: Weight/strength if applicable (for LoRAs)
// - detected: Whether this was auto-detected vs user-specified
```

### Validating Resource Usage

```typescript
const resources = await imageResourcesCache.fetch(imageId);
const usedModelVersionIds = resources.map(r => r.modelVersionId);

// Check if image only used allowed resources
const allowedResources = [123, 456, 789]; // model version IDs
const isValid = usedModelVersionIds.every(id => allowedResources.includes(id));
```

## Detection

Resources can be:
- **Auto-detected**: Extracted from image metadata (generation parameters)
- **User-specified**: Manually tagged by the uploader

The `detected` field distinguishes between these cases.
