# Base Model Constants Management

## Overview

This document outlines a plan to migrate base model constants from hardcoded TypeScript files to database-managed records, enabling runtime configuration via an admin interface without requiring deployments.

---

## Current State

### Completed: New Constants File

A new constants file has been created at **`src/shared/constants/basemodel.constants.ts`** with a database-like structure using numeric IDs. This file consolidates all base model configuration and will serve as the seed data for database migration.

**Records Created:**
- **Licenses**: 24 records (IDs 1-24)
- **Families**: 12 records (IDs 1-12)
- **Groups**: 49 records (IDs 1-49)
- **Base Models**: 66 records (IDs 1-66)
- **Generation Support**: ~300+ records with auto-incrementing IDs

**Exports:**
- `licenses`, `licenseById` - License definitions
- `baseModelFamilies`, `familyById` - Family groupings
- `baseModelGroups`, `groupById`, `groupByKey` - Group configurations with settings
- `baseModels`, `baseModelById`, `baseModelByName` - Base model definitions
- `generationSupport`, `generationSupportById` - Generation compatibility matrix

**Helper Functions:**
- `getBaseModelsByGroupId(groupId: number)`
- `getGenerationSupportForGroup(groupId: number, modelType?: ModelType)`
- `getCompatibleBaseModels(groupId: number, modelType: ModelType)`
- `getBaseModelLicense(baseModelId: number)`
- `getGroupFamily(groupId: number)`
- `getGroupsByFamilyId(familyId: number)`
- `getGenerationBaseModels()` - Base models available for generation
- `getAuctionBaseModels()` - Base models available for auction
- `getDeprecatedBaseModels()` - Deprecated base models

### Legacy Files (To Be Deprecated)

1. **`src/shared/constants/base-model.constants.ts`** (old file)
   - `baseModelFamilyConfig` - Family groupings with display names and descriptions
   - `baseModelGroupConfig` - Group display names, descriptions, and family references
   - `baseModelConfig` - Core base model definitions (name, type, group, hidden, ecosystem, engine)
   - `baseModelGenerationConfig` - Generation compatibility matrix (which model types work with which base models)

2. **`src/server/common/constants.ts`**
   - `baseLicenses` - License definitions with URLs, names, notices, and NSFW restrictions
   - `baseModelLicenses` - Mapping of base models to their licenses
   - `generationConfig` - Generation settings per base model group (aspect ratios, default checkpoints)

---

## Data Model

### Entity Relationships

```
BaseModelFamily (e.g., "Flux", "StableDiffusion")
    │
    └── BaseModelGroup (e.g., "Flux1", "SDXL")
            │
            ├── BaseModel (e.g., "Flux.1 D", "SDXL 1.0")
            │
            └── BaseModelGenerationSupport (matrix of modelType × baseModel × supportLevel)
```

**Key Points:**
- Base models belong to a group (required)
- Groups optionally belong to a family
- Base models do not have a direct family relationship
- **Base model names must be unique** and serve as the unique identifier (no separate key field)
- Groups have a `key` field for programmatic access, while base models use `name` as both display name and unique identifier

### Database Schema

```prisma
model License {
  id                    Int         @id @default(autoincrement())
  name                  String               // "Apache 2.0", "CreativeML Open RAIL-M"
  url                   String?
  notice                String?              // Required attribution text
  poweredBy             String?              // "Powered by X" text
  disableMature         Boolean     @default(false)  // Restrict NSFW content

  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  baseModels  BaseModel[]
}

model BaseModelFamily {
  id          Int      @id @default(autoincrement())
  name        String             // Display name: "Flux", "Stable Diffusion"
  description String?
  sortOrder   Int      @default(0)

  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  groups      BaseModelGroup[]
  baseModels  BaseModel[]
}

model BaseModelGroup {
  id          Int      @id @default(autoincrement())
  key         String   @unique  // "SD1", "SDXL", "Flux1"
  name        String             // Display name: "Stable Diffusion 1.x"
  description String?
  sortOrder   Int      @default(0)

  // Generation settings
  settings              Json?    // { aspectRatios: [{ label, width, height }], ... }
  modelVersionId   Int?     // ModelVersion ID for default generation

  familyId    Int?
  family      BaseModelFamily? @relation(fields: [familyId], references: [id])

  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  baseModels          BaseModel[]
  generationSupport   BaseModelGenerationSupport[]
}

model BaseModel {
  id          Int       @id @default(autoincrement())
  name        String    @unique  // Display name (e.g., "SD 1.5", "SDXL 1.0", "Flux.1 D")
  type        MediaType           // image, video

  // Visibility & status flags (optional, only set when true)
  hidden      Boolean   @default(false)  // Hide from dropdowns
  deprecated  Boolean   @default(false)  // Mark as deprecated

  // Capability flags (optional, only set when true)
  canGenerate Boolean   @default(false)  // Available for generation
  canTrain    Boolean   @default(false)  // Available for training
  canAuction  Boolean   @default(false)  // Available for auction

  // Technical metadata
  ecosystem   String?             // "sdxl", "flux", "auraflow" - for resource filtering
  engine      String?             // "wan", "hunyuan", "lightricks" - for orchestration

  groupId     Int
  group       BaseModelGroup @relation(fields: [groupId], references: [id])

  licenseId   Int?
  license     License? @relation(fields: [licenseId], references: [id])

  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  generationSupport BaseModelGenerationSupport[]
}

// Generation compatibility matrix
// Each record represents one cell: (group, modelType, baseModel) → supportLevel
model BaseModelGenerationSupport {
  id          Int      @id @default(autoincrement())

  groupId     Int
  group       BaseModelGroup @relation(fields: [groupId], references: [id])

  modelType   ModelType  // Checkpoint, LORA, TextualInversion, DoRA, LoCon, VAE

  baseModelId Int
  baseModel   BaseModel @relation(fields: [baseModelId], references: [id])

  support     SupportLevel  // full, partial

  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@unique([groupId, modelType, baseModelId])
}

enum SupportLevel {
  full
  partial
}
```

### TypeScript Types (Current Implementation)

The constants file uses these corresponding TypeScript types:

```typescript
type LicenseRecord = {
  id: number;
  name: string;
  url?: string;
  notice?: string;
  poweredBy?: string;
  disableMature?: boolean;
};

type BaseModelFamilyRecord = {
  id: number;
  name: string;
  description: string;
  sortOrder: number;
};

type BaseModelGroupRecord = {
  id: number;
  key: string;
  name: string;
  description: string;
  familyId?: number;
  sortOrder: number;
  settings?: Record<string, any>;
  modelVersionId?: number;
};

type BaseModelRecord = {
  id: number;
  name: string;  // Must be unique - serves as both display name and unique identifier
  type: MediaType;
  hidden?: boolean;
  deprecated?: boolean;
  canGenerate?: boolean;
  canTrain?: boolean;
  canAuction?: boolean;
  ecosystem?: string;
  engine?: string;
  groupId: number;
  licenseId?: number;
};

type BaseModelGenerationSupportRecord = {
  id: number;
  groupId: number;
  modelType: ModelType;
  baseModelId: number;
  support: SupportLevel;
};
```

### Generation Support Matrix

The `BaseModelGenerationSupport` table creates a matrix for each group:

**Example: SD1 Generation Config**

| Model Type | SD 1.4 | SD 1.5 | SD 1.5 LCM | SD 1.5 Hyper |
|:-----------|:-------|:-------|:-----------|:-------------|
| Checkpoint | full | full | full | full |
| TextualInversion | full | full | full | full |
| LORA | full | full | full | full |
| DoRA | full | full | full | full |
| LoCon | full | full | full | full |
| VAE | full | full | full | full |

**Example: SDXL Generation Config (with cross-group partial support)**

| Model Type | SDXL 0.9 | SDXL 1.0 | SDXL 1.0 LCM | SDXL Lightning | SD 1.5 | Pony |
|:-----------|:---------|:---------|:-------------|:---------------|:-------|:-----|
| Checkpoint | full | full | full | full | - | - |
| TextualInversion | full | full | full | full | partial | partial |
| LORA | full | full | full | full | - | partial |
| VAE | full | full | full | full | - | partial |

Database records for this matrix (using numeric IDs):

```
| id  | groupId | modelType        | baseModelId | support |
|-----|---------|------------------|-------------|---------|
| 25  | 9       | Checkpoint       | 44          | full    |  // SDXL group, SDXL 0.9
| 26  | 9       | Checkpoint       | 45          | full    |  // SDXL group, SDXL 1.0
| 31  | 9       | TextualInversion | 45          | full    |  // SDXL group, SDXL 1.0
| 67  | 9       | TextualInversion | 31          | partial |  // SDXL group, SD 1.5
| 37  | 9       | LORA             | 45          | full    |  // SDXL group, SDXL 1.0
| 71  | 9       | LORA             | 26          | partial |  // SDXL group, Pony
| ... | ...     | ...              | ...         | ...     |
```

**ID Reference:**
- Group 9 = SDXL
- Base Model 44 = SDXL 0.9, 45 = SDXL 1.0, 31 = SD 1.5, 26 = Pony

---

## Client-Side Data Access

### Recommended Approach: Script Injection + Background Refresh

1. **Server** caches config in Redis/memory (1-5 min TTL)
2. **SSR** injects config into page via script tag
3. **Client** reads from `window.__BASE_MODEL_CONFIG__` synchronously
4. **Background refresh** for long-lived sessions

```typescript
// Server: inject into HTML during SSR
function getConfigScript() {
  const config = getCachedBaseModelConfig(); // From Redis/memory
  return `<script>window.__BASE_MODEL_CONFIG__=${JSON.stringify(config)};</script>`;
}

// Shared access (works server + client)
export function getBaseModelConfig(): BaseModelConfigData {
  if (typeof window !== 'undefined' && window.__BASE_MODEL_CONFIG__) {
    return window.__BASE_MODEL_CONFIG__;
  }
  return getServerConfig(); // Server-side fallback
}
```

### Benefits
- **Synchronous access** - No loading states, works in any context
- **Type-safe** - TypeScript types from Zod schema
- **Fresh data** - Background refresh for long sessions
- **Resilient** - Falls back gracefully if fetch fails

---

## Admin UI

### Base Model Management Checklist

When adding a new base model, the admin UI guides through these steps:

```
□ 1. Create/Select Base Model Family
     - Key, name, description

□ 2. Create/Select Base Model Group
     - Key, name, description
     - Assign aspect ratios
     - Set feature flags (generation, auction)

□ 3. Create Base Model Entry
     - Name (e.g., "Flux.1 D") - used as unique identifier
     - Media type (image/video)
     - Assign to group (family is inherited from group)
     - Set ecosystem, engine (if applicable)

□ 4. Configure License
     - Select existing or create new license
     - License URL, name, notice
     - NSFW restrictions

□ 5. Configure Generation Support Matrix
     - For each model type, set support level (full/partial/none)
     - Configure cross-group partial support

□ 6. Link Default Checkpoint
     - Select model version for default generation
     - Verify model is published and accessible

□ 7. Verify & Publish
     - Preview how it appears in UI
     - Test generation with new base model
     - Enable (unhide) when ready
```

### Admin UI: Matrix Editor

For generation support, a matrix editor UI:

```
┌─────────────────────────────────────────────────────────────────────┐
│ SDXL Generation Support                                    [Save]   │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│ Group Members:  SDXL 0.9, SDXL 1.0, SDXL 1.0 LCM, Lightning, Hyper │
│ Cross-Group:    SD 1.5, Pony, Illustrious, NoobAI                  │
│                                                                     │
│ ┌──────────────┬────────┬────────┬──────────┬─────────┬──────────┐ │
│ │              │ SDXL   │ SDXL   │ SD 1.5   │ Pony    │ Illust.  │ │
│ │              │ 1.0    │ Light  │          │         │          │ │
│ ├──────────────┼────────┼────────┼──────────┼─────────┼──────────┤ │
│ │ Checkpoint   │ ● Full │ ● Full │ ○ None   │ ○ None  │ ○ None   │ │
│ │ LORA         │ ● Full │ ● Full │ ○ None   │ ◐ Part  │ ◐ Part   │ │
│ │ TextualInv   │ ● Full │ ● Full │ ◐ Part   │ ◐ Part  │ ◐ Part   │ │
│ │ VAE          │ ● Full │ ● Full │ ○ None   │ ◐ Part  │ ◐ Part   │ │
│ └──────────────┴────────┴────────┴──────────┴─────────┴──────────┘ │
│                                                                     │
│ ● Full = full support, ◐ Part = partial, ○ None = not compatible  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Implementation Plan

### Phase 0: Constants Restructuring ✅ COMPLETED

1. ✅ Create new constants file with database-like structure
2. ✅ Define TypeScript types matching planned Prisma schema
3. ✅ Consolidate all base model data (families, groups, base models, licenses)
4. ✅ Implement generation support matrix with numeric IDs
5. ✅ Add helper functions for common queries
6. ✅ Use numeric auto-incrementing IDs (matching database pattern)

**File created:** `src/shared/constants/basemodel.constants.ts`

### Phase 1: Database Schema & Migration

1. Create Prisma schema for new tables (use schema from this doc)
2. Write migration to create tables
3. Write seed script to populate from `basemodel.constants.ts`
4. Verify data integrity against constants

### Phase 2: Service Layer

1. Create `BaseModelService` with caching
2. Implement queries:
   - `getBaseModelConfig()` - All config data
   - `getBaseModelsByGroup(group)` - Base models in a group
   - `getGenerationSupport(group, modelType)` - Compatible base models
   - `getBaseModelLicense(baseModel)` - License info
3. Add cache invalidation on updates

### Phase 3: API Endpoints

1. Create tRPC router for base model management
2. Admin endpoints: CRUD for families, groups, base models, licenses
3. Public endpoints: Read-only config data
4. Add proper authorization (admin-only for mutations)

### Phase 4: Client Integration

1. Implement script injection in `_document.tsx`
2. Create `useBaseModelConfig()` hook
3. Migrate components from constants to service/hook
4. Add background refresh for long sessions

### Phase 5: Admin UI

1. Build family/group/base model list views
2. Build create/edit forms
3. Build generation support matrix editor
4. Add validation and preview

### Phase 6: Deprecate Constants

1. Remove usage of old constants
2. Keep constants as fallback during transition
3. Remove constants files once fully migrated

---

## Queries

### Get compatible base models for generation

```typescript
async function getCompatibleBaseModels(
  targetBaseModel: string,
  modelType: ModelType
): Promise<{ full: BaseModel[]; partial: BaseModel[] }> {
  // Get the group of the target base model
  const target = await prisma.baseModel.findUnique({
    where: { key: targetBaseModel },
    include: { group: true },
  });

  // Get all base models with full or partial support for this group + modelType
  const compatible = await prisma.baseModelGenerationSupport.findMany({
    where: {
      groupId: target.groupId,
      modelType: modelType,
    },
    include: { baseModel: true },
  });

  return {
    full: compatible.filter(c => c.support === 'full').map(c => c.baseModel),
    partial: compatible.filter(c => c.support === 'partial').map(c => c.baseModel),
  };
}
```

### Get generation matrix for a group

```typescript
async function getGenerationMatrix(groupKey: string) {
  const records = await prisma.baseModelGenerationSupport.findMany({
    where: { group: { key: groupKey } },
    include: { baseModel: true },
    orderBy: [{ modelType: 'asc' }, { baseModel: { sortOrder: 'asc' } }],
  });

  // Pivot into matrix form
  const matrix: Record<ModelType, Record<string, SupportLevel>> = {};

  for (const record of records) {
    if (!matrix[record.modelType]) {
      matrix[record.modelType] = {};
    }
    matrix[record.modelType][record.baseModel.key] = record.support;
  }

  return matrix;
}
```

### Get all config for client

```typescript
async function getBaseModelConfigForClient() {
  const [families, groups, baseModels, generationSupport] = await Promise.all([
    prisma.baseModelFamily.findMany({ orderBy: { sortOrder: 'asc' } }),
    prisma.baseModelGroup.findMany({
      orderBy: { sortOrder: 'asc' },
      include: { baseModels: { select: { key: true } } },
    }),
    prisma.baseModel.findMany({
      where: { hidden: false },
      orderBy: { sortOrder: 'asc' },
      include: { license: true },
    }),
    prisma.baseModelGenerationSupport.findMany(),
  ]);

  return { families, groups, baseModels, generationSupport };
}
```

---

## Open Questions

1. How long should the cache TTL be? (Suggested: 5 minutes)
2. Should we version the configuration for rollback capabilities? - @dev - yes
3. Should changes require approval workflow or take effect immediately? - @dev - the ui we will end up designing will allow the user making the changes to request review.
4. How do we handle in-flight generations when config changes? - @dev - it will happen in phases. First, we'll update the base model constants to more closely align with the db models we have planned.

---

## Resolved Items

@dev - each base model group also needs to have a modelVersionId associated with it. This modelVersionId will be the default model version associated with that base model.
@ai: ✅ Done - Added `modelVersionId` to `BaseModelGroupRecord` type and populated for groups that have default checkpoints.

@dev - Before we make any changes to the prisma schema or anything else, I'd like to have all the constants that we're working with be put into a new constants file. The constants need to have the same structure that we're planning for the db. Where the data requires ids, create ids for those records. the file can be /shared/constants/basemodel.constants.ts
@ai: ✅ Done - Created `src/shared/constants/basemodel.constants.ts` with:
- 24 licenses (IDs 1-24)
- 12 families (IDs 1-12)
- 49 groups (IDs 1-49) with settings and modelVersionId
- 66 base models (IDs 1-66) with canGenerate/canTrain/canAuction/deprecated flags
- ~300+ generation support records with auto-incrementing IDs
- Helper functions for common queries
- Map-based lookups by ID and key
