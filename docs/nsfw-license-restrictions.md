# NSFW License Restrictions Implementation

## Overview

This document outlines the implementation of license-based NSFW content restrictions for the Civitai platform. The solution filters out images with R, X, or XXX NSFW levels that are linked to models using base models with specific license restrictions, ensuring compliance with licenses that prohibit NSFW content.

## Restricted Licenses

The following licenses restrict NSFW content:

1. **SDXL Turbo** (`'sdxl turbo'`)
2. **Stable Video Diffusion** (`'svd'`)
3. **Stability AI Non-Commercial Research Community License** (`'SAI NC RC'`)
4. **Stability AI Community License Agreement** (`'SAI CLA'`)

## Affected Base Models

Based on the license mappings in `constants.ts`, the following base models are automatically restricted for NSFW content:

### SDXL Turbo License:

- `'SDXL Turbo'`

### SVD License:

- `'SVD'`
- `'SVD XT'`

### SAI NC RC License:

- `'Stable Cascade'`

### SAI CLA License:

- `'SD 3'`
- `'SD 3.5'`
- `'SD 3.5 Medium'`
- `'SD 3.5 Large'`
- `'SD 3.5 Large Turbo'`

## Implementation Details

### 1. Constants and Configuration

The system maintains a centralized list of restricted licenses and automatically maps them to affected base models in `src/server/common/constants.ts`:

```typescript
// Licenses that restrict NSFW content
const nsfwRestrictedLicenses = ['sdxl turbo', 'svd', 'SAI NC RC', 'SAI CLA'];

// Base models using restricted licenses (automatically determined)
export const nsfwRestrictedBaseModels = Object.entries(baseModelLicenses)
  .filter(([, license]) => license && nsfwRestrictedLicenses.includes(license.name))
  .map(([baseModel]) => baseModel);
```

## How It Works

The system implements multi-layered protection against license violations:

### 1. Backend Filtering

- **Database Queries**: All image and model queries automatically filter out content that violates license restrictions
- **Search Results**: Meilisearch-based queries apply the same filtering logic
- **API Endpoints**: All public-facing endpoints respect these restrictions

### 2. Validation During Operations

- **Model Creation**: Prevents creating NSFW models with restricted base models
- **Model Publishing**: Blocks publishing attempts that would violate licenses
- **Image Upload**: Shows warnings when users upload X/XXX content using restricted models

### 3. Frontend Alerts

- **User Education**: Shows clear warnings in the post editor when license violations are detected
- **Guidance**: Provides specific information about which models are causing violations
- **Non-blocking**: Allows users to proceed while being informed of potential issues

## Technical Implementation

### NSFW Level Values

- **R (Restricted)**: Value 4 - Contains mature/restricted content
- **X (Mature)**: Value 8 - Contains suggestive or mature content
- **XXX (Adult)**: Value 16 - Contains explicit adult content
- **Combined check**: `(nsfwLevel & 28) != 0` filters R, X and XXX levels using bitwise operations

### Filtering Logic

The system excludes content when BOTH conditions are true:

1. Image has R, X, or XXX NSFW level
2. Image is linked to a model using a restricted base model

### Affected Components

#### Backend Services

- **Image Service** (`image.service.ts`): All image query functions filter restricted content
- **Model Service** (`model.service.ts`): Model queries exclude NSFW models with restricted base models
- **Post Service**: Post-related image queries apply the same restrictions

#### Frontend Components

- **AddedImage Component**: Shows license violation alerts when uploading images
- **Post Editor**: Provides real-time feedback about license compliance

#### Search and Discovery

- **Meilisearch Integration**: Search results exclude violating content
- **Cover Images**: Entity cover image selection respects restrictions
- **Feed Generation**: All content feeds apply filtering

## Benefits

1. **Automatic Compliance**: Ensures license terms are respected without manual intervention
2. **Comprehensive Coverage**: Applies restrictions across all platform features
3. **User Education**: Alerts help users understand license limitations
4. **Performance Optimized**: Database-level filtering using efficient SQL queries
5. **Maintainable**: Easy to update restrictions by modifying constants
6. **Granular Control**: Image-level filtering provides precise restriction enforcement

## Error Messages

When validation fails during model operations, users see clear guidance:

```
Cannot mark model as NSFW due to license restrictions. The license for this base model (SDXL Turbo) does not permit NSFW content.
```

## Future Considerations

- **Granular Permissions**: Allow license holders to bypass restrictions
- **Audit Logging**: Track restriction triggers for compliance reporting
- **License Migration**: Handle changes to base model licenses
- **Performance Monitoring**: Ensure filtering doesn't impact query performance

## Testing Strategy

The implementation can be verified through these key test scenarios:

### Model Filtering Verification

```typescript
// Ensure NSFW models with restricted base models are excluded
const models = await getModelsRaw({});
const violatingModels = models.filter(
  (m) => m.nsfw && nsfwRestrictedBaseModels.includes(m.baseModel)
);
expect(violatingModels).toHaveLength(0);
```

### Image Filtering Verification

```typescript
// Ensure R/X/XXX images linked to restricted models are excluded
const images = await getAllImages({});
const violatingImages = images.filter((image) => {
  const hasRestrictedNsfwLevel = (image.nsfwLevel & 28) !== 0; // R, X, or XXX
  const usesRestrictedBaseModel = /* check if linked to restricted model */;
  return hasRestrictedNsfwLevel && usesRestrictedBaseModel;
});
expect(violatingImages).toHaveLength(0);
```

### Validation Testing

```typescript
// Verify creation/publishing prevention
await expect(publishModelById({ id: modelId, nsfw: true })).rejects.toThrow(/license restrictions/);
```
