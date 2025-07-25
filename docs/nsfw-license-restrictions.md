# NSFW License Restrictions

## Overview

Implements license-based NSFW content restrictions for Civitai. Filters out R/X/XXX images linked to models with restrictive licenses, ensuring compliance with license terms that prohibit NSFW content.

## Affected Base Models

The following base models currently restrict X and XXX content:

- **SDXL Turbo**, **SVD/SVD XT**, **Stable Cascade**, **SD 3.x** models

New licenses can be configured with different restriction patterns (e.g., only XXX content).

## Implementation

### License Configuration

Each license defines restricted NSFW levels in `constants.ts`:

```typescript
type LicenseDetails = {
  restrictedNsfwLevels?: NsfwLevel[]; // Define which NSFW levels are restricted
};

'sdxl turbo': {
  name: 'Stability AI Non-Commercial Research Community License',
  restrictedNsfwLevels: [NsfwLevel.X, NsfwLevel.XXX], // Restricts X and XXX content
},
```

### NSFW Level Values

- **R (Restricted)**: Value 4
- **X (Mature)**: Value 8
- **XXX (Adult)**: Value 16
- **Combined check**: `(nsfwLevel & 28) != 0` filters R, X and XXX levels

### Filtering Logic

Content is excluded when:

1. Image has an NSFW level that is restricted by the license
2. Image is linked to a model using a base model with license restrictions for that NSFW level

### Backend Implementation

**Model Service**: Filters NSFW models with restricted base models using `getNsfwRestrictedBaseModelSqlFilter()`:

```sql
NOT (m."nsfw" = true AND EXISTS (
  SELECT 1 FROM "ModelVersion" mv
  WHERE mv."modelId" = m."id"
    AND mv."baseModel" IN (restricted_base_models)
))
```

- Validates during model creation/publishing to prevent NSFW models with restricted base models

**Model Version Service**: Validates during version creation and publishing:

- `upsertModelVersion()`: Checks if creating/updating a version with restricted base model for NSFW model
- `publishModelVersionById()`: Validates before publishing individual versions
- `publishModelVersionsWithEarlyAccess()`: Validates before publishing versions with early access

**Image Service**: Filters images in `getAllImages()` using similar SQL logic to exclude R/X/XXX images linked to restricted models.

### Frontend Implementation

**AddedImage Component**: Shows license violation alerts using `hasImageLicenseViolation()` utility:

- Detects violations in real-time during image upload
- Displays specific model and base model information
- Non-blocking alerts that educate users

**Post Editor**: Prevents publishing posts with violations and shows detailed tooltips with violation information.

### Helper Functions

- `getRestrictedNsfwLevelsForBaseModel(baseModel)`: Returns restricted levels for a base model
- `isNsfwLevelRestrictedForBaseModel(baseModel, nsfwLevel)`: Checks if a specific level is restricted
- `hasImageLicenseViolation(image)`: Utility for detecting violations in frontend components

## Key Features

- **Automatic Compliance**: License terms respected without manual intervention
- **User Education**: Clear alerts help users understand restrictions
- **Comprehensive Coverage**: Applies across search, feeds, and all platform features
- **Granular Control**: Image-level filtering with precise restriction enforcement
