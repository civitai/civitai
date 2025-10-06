# NSFW License Restrictions

## Overview

Implements license-based NSFW content restrictions for Civitai. Filters out R/X/XXX images linked to models with restrictive licenses, ensuring compliance with license terms that prohibit NSFW content.

## Affected Base Models

The following base models currently restrict NSFW content:

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

**Dual Configuration System**: The system uses both database and code-based configuration for maximum flexibility:

- **Database Table**: `RestrictedBaseModels` table stores the actual restricted base models for efficient querying
- **Constants Array**: `nsfwRestrictedBaseModels` array in `constants.ts` dynamically derives restricted models from license definitions

**Materialized View for Performance**: The `RestrictedImagesByBaseModel` materialized view efficiently identifies images linked to restricted base models by joining image resources with model versions and the restricted base models table.

**Automated Refresh Triggers**: The materialized view is automatically refreshed using optimized PostgreSQL triggers that monitor changes to relevant tables:

- **ImageResourceNew Changes**: Triggers on INSERT/DELETE operations, only refreshing when changes involve restricted base models
- **ModelVersion Changes**: Triggers on INSERT/UPDATE OF "baseModel"/DELETE operations when `baseModel` field changes to/from restricted values
- **RestrictedBaseModels Changes**: Triggers on INSERT/UPDATE/DELETE operations to immediately refresh when the restricted models list changes

**Model Service**: Filters NSFW models with restricted base models using validation during model creation and publishing to prevent NSFW models with restricted base models.

**Model Version Service**: Validates during version creation and publishing through `upsertModelVersion()`, `publishModelVersionById()`, and `publishModelVersionsWithEarlyAccess()` functions.

**Image Service**: Uses the materialized view for high-performance filtering in `getAllImages()` and related queries with LEFT JOIN + IS NULL pattern for optimal performance.

**Image Scan Processing**: The `auditImageScanResults` function uses the materialized view to efficiently check for restricted base models and blocks NSFW images with restricted base models.

The materialized view approach provides significant performance improvements over complex subqueries, reducing query execution time for image filtering operations.

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

## Technical Architecture

### Centralized Configuration Management

- **Dual Configuration**: Both database table (`RestrictedBaseModels`) and constants array (`nsfwRestrictedBaseModels`) work together
- **License-Driven**: The constants array automatically derives restricted models from license definitions in code
- **Database Efficiency**: The `RestrictedBaseModels` table enables fast querying and materialized view joins
- **Single Source of Truth**: License definitions in `constants.ts` remain the authoritative configuration
- **Easy Maintenance**: Adding/removing restrictions only requires updating license definitions

### Performance Optimization

- **Pre-computed Results**: Materialized view eliminates expensive JOIN operations during query execution
- **Selective Refresh**: Trigger logic ensures materialized view only refreshes when relevant data changes
- **Indexed Access**: Materialized view includes proper indexing for optimal query performance
- **Concurrent Operations**: Non-blocking refresh strategy maintains system availability

### Intelligent Trigger System

- **Conditional Logic**: Triggers only fire when changes involve restricted base models
- **Multi-Table Monitoring**: Automatically handles changes to images, model versions, and restriction configuration
