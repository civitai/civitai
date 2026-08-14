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
| `packages/civitai-db-schema/prisma/schema.full.prisma` | `ImageResourceNew` model definition |
| `src/server/services/image.service.ts` | `getImageResourcesFromImageId()`, `createImageResources()` |
| `src/server/redis/caches.ts` | `imageResourcesCache`, `ImageResourceCacheItem` |
| `packages/civitai-db-schema/prisma/programmability/get_image_resources.sql` | Detection function |

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

`fetch()` takes an array and returns a `Record` keyed by image id, and the resources are nested
one level down — so it's always a two-step unwrap:

```typescript
import { imageResourcesCache } from '~/server/redis/caches';

const byImage = await imageResourcesCache.fetch([imageId]);
const resources = byImage[imageId]?.resources ?? [];
```

Each entry is an `ImageResourceCacheItem` (see `caches.ts` for the authoritative shape). It carries
more than the three columns of the underlying table — `modelId`, `modelName`, `modelType`,
`versionName`, `baseModel`, `poi` and `minor` are already denormalized in, so needing any of those
is **not** a reason to hit the database again.

### Validating Resource Usage

```typescript
const byImage = await imageResourcesCache.fetch([imageId]);
const usedModelVersionIds = (byImage[imageId]?.resources ?? []).map((r) => r.modelVersionId);

const allowedResources = [123, 456, 789]; // model version IDs
const isValid = usedModelVersionIds.every((id) => allowedResources.includes(id));
```

Note that the shipped challenge/contest validation does **not** go through the cache — it joins
`ImageResourceNew` directly (`challenge.service.ts`). Use the cache for display paths; check the
existing call site before adding a new validation path.

### Reads are flag-routed away from the replica

`imageResourcesCache`'s lookup consults the `IMAGE_RESOURCE_USE_WRITE` Flipt flag and otherwise
routes through `getDbWithoutLagBatch`, because the DataPacket replica is missing the
`ImageResourceNew` backfill. The same routing is open-coded at the other `ImageResourceNew` call
sites. **A new query written against the plain read replica will silently return no rows there** —
copy the routing from an existing call site rather than reaching for `dbRead`.

## Detection

The `detected` flag records *how the resource was associated with the image*, not who did it:

- **`detected: true`** — extracted from the image's generation metadata. Four of the five branches
  in `get_image_resources.sql` produce this.
- **`detected: false`** — inherited from the post's linked model version (`Post.modelVersionId`),
  via the one remaining branch.

`createImageResources()` is not the only writer, and `detected: false` does **not** imply the post
link. `addResourceToPostImage()` (`post.service.ts`, exposed as a tRPC mutation) lets an image's
owner credit a resource by hand and writes `detected: false` explicitly; it refuses on-site
generations, so hand-crediting only ever applies to uploaded/external images. Treat `detected: false`
as "asserted by the uploader" — through the post link or the credit mutation — and `detected: true`
as "read out of the image's own metadata". Anything gating on provenance wants `detected: true`.

Nothing deletes a `detected: false` row on its own: `refreshImageResources()` deletes
`WHERE ... AND detected` only, so a row survives its post being re-linked. About half of recent
manual rows no longer match their image's current `Post.modelVersionId`.

Note `strength` is stored as `round(weight * 100)` — a weight of `1.0` is `100`, not `1`.

A second TypeScript reimplementation of the detection logic now lives in
`generation.service.ts`, whose comments state it mirrors the SQL's stages. If you change the
detection rules, change both.
