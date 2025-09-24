# Models Feature Documentation

## Overview

Models are the core content type in Civitai, representing AI models that users can create, share, and download. Each model can have multiple versions, and each version can contain multiple files.

## Model Status Lifecycle

### Status Types

Models and ModelVersions use the `ModelStatus` enum to track their publication state:

- **Draft**: Saved but incomplete
- **Training**: Actively training (for custom models)
- **Published**: Live and accessible to users
- **Scheduled**: Scheduled for future publication
- **Unpublished**: Voluntarily hidden by the user
- **UnpublishedViolation**: Hidden due to policy violation
- **Deleted**: Soft deleted by user/system
- **GatherInterest**: Legacy/unused status

### Publishing State Transitions

#### Publishing
- `Draft` → `Published`
- `Unpublished` → `Published`
- `UnpublishedViolation` → `Published`
- `Training` → `Published`
- `Scheduled` → `Published`

#### Unpublishing
- `Published` → `Unpublished` (voluntary)
- `Published` → `UnpublishedViolation` (policy violation)
- `Published` → `Deleted`

## Database Schema

### Key Tables
- **Model**: Main model record
- **ModelVersion**: Individual versions of a model
- **ModelFile**: Files associated with each version
- **Post**: Showcase posts for model versions

### Important Fields

#### Model Table
- `status`: Current publication state
- `publishedAt`: Initial publication timestamp (persists through unpublishing)
- `meta`: JSON field containing additional metadata including unpublish details
- `userId`: Creator/owner of the model

#### ModelVersion Table
- `status`: Version-specific publication state
- `publishedAt`: Version publication timestamp
- `meta`: JSON metadata including unpublish details
- `modelId`: Parent model reference

## Unpublishing Behavior

### What Happens During Unpublishing

When a model or model version is unpublished, the following changes occur:

#### Database Changes

1. **Model/ModelVersion Records**:
   - `status` changes to `Unpublished` or `UnpublishedViolation`
   - `publishedAt` remains unchanged (preserves original publish date)
   - `meta` field updated with:
     - `unpublishedAt`: Timestamp of unpublishing
     - `unpublishedBy`: User ID who unpublished
     - `unpublishedReason`: Reason (if violation)
     - `customMessage`: Optional custom message

2. **Related Post Records**:
   - `publishedAt` set to NULL
   - `metadata` updated with unpublishing info
   - Previous `publishedAt` stored as `prevPublishedAt` in metadata

3. **When Unpublishing a Model**:
   - All associated model versions also get unpublished
   - All version statuses updated to `Unpublished`

#### Side Effects
- Removed from search indexes (models, images, collections)
- User content overview cache invalidated
- Model's last version timestamp updated
- Related images removed from search index

### Unpublishing Restrictions
- Cannot unpublish models with early access purchases (unless moderator)
- Moderators can force unpublish regardless of early access status

### Unpublishing Triggers
- Manual user action
- User account banning (automatically unpublishes all user's models)
- File scan failures
- Moderation actions for policy violations
- DMCA/legal requests

## Service Functions

### Key Functions

#### Model Service (`src/server/services/model.service.ts`)
- `unpublishModelById` (line 1876): Unpublishes a model and all its versions
- `publishModelById`: Publishes or republishes a model
- `createModel`: Creates a new model in draft status
- `updateModel`: Updates model details

#### Model Version Service (`src/server/services/model-version.service.ts`)
- `unpublishModelVersionById` (line 856): Unpublishes a specific version
- `publishModelVersionById`: Publishes a model version
- `createModelVersion`: Creates a new version

## Monitoring Publication State Changes

To track when models/versions change publication state:

1. **Monitor the `status` field** - This is the authoritative source for publication state
2. **Don't rely on `publishedAt`** - This timestamp persists through unpublish/republish cycles
3. **Check `meta` field** - Contains unpublishing metadata when applicable
4. **Track `status` transitions** in audit logs or database triggers

### Example: Finding Currently Published Models
```sql
SELECT * FROM "Model" WHERE status = 'Published';
SELECT * FROM "ModelVersion" WHERE status = 'Published';
```

### Example: Finding Unpublished Due to Violations
```sql
SELECT * FROM "Model"
WHERE status = 'UnpublishedViolation'
AND meta->>'unpublishedReason' IS NOT NULL;
```

## Related Features

### Early Access
- Models with early access purchases have special unpublishing restrictions
- Tracked via `meta.hadEarlyAccessPurchase` on model versions

### File Scanning
- Automatic unpublishing can occur if files fail malware/content scans
- Scan results stored in separate scan result tables

### Moderation
- Moderation queue for reviewing reported models
- Special moderator privileges for force unpublishing
- Violation tracking in meta fields

## API Endpoints

### tRPC Routers
- `model.router.ts`: Model CRUD operations
- `model-version.router.ts`: Version-specific operations

### Key Mutations
- `model.publish`: Publish a model
- `model.unpublish`: Unpublish a model
- `modelVersion.publish`: Publish a version
- `modelVersion.unpublish`: Unpublish a version

## Best Practices

1. Always check `status` field for current publication state
2. Preserve `publishedAt` for historical tracking
3. Log unpublishing reasons in `meta` field
4. Handle early access purchase checks before unpublishing
5. Update search indexes after status changes
6. Clear relevant caches after unpublishing