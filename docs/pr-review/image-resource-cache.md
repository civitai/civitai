# Image Resource Cache Migration - Frontend Testing Checklist

This document lists the pages and components that should be tested after migrating from the `ImageResourceHelper` Prisma view to the `imageResourcesCache` Redis cache with the new `ImageResourceSlim` type.

## Summary of Changes

- **Data Source**: Image resources are now fetched from Redis cache (`imageResourcesCache`) instead of the `ImageResourceHelper` Prisma view
- **Type Change**: `ImageResourceHelper` ’ `ImageResourceSlim`
- **Field Renames**:
  - `name` ’ `modelVersionName`
  - `versionName` ’ `modelVersionName`
  - `baseModel` ’ `modelVersionBaseModel`
  - `modelVersionBaseModel` stays the same

## Pages & Components to Test

### 1. Post Edit Page
**Route**: `/posts/{postId}/edit`

**What to check**:
- [ ] Resources display correctly on each image card
- [ ] Resource names show properly (model name, version name)
- [ ] Base model badge displays correctly
- [ ] Adding a new resource to an image works
- [ ] Removing a resource from an image works
- [ ] License violation warnings appear when applicable

**Components affected**:
- `src/components/Post/EditV2/PostImageCards/AddedImage.tsx`
- `src/components/Post/EditV2/PostEditSidebar.tsx`
- `src/components/Post/EditV2/EditPostReviews.tsx`

---

### 2. Image Detail Page (V2)
**Route**: `/images/{imageId}`

**What to check**:
- [ ] Image resources/models used section displays correctly
- [ ] Resource refresh button works (`RefreshImageResources` component)
- [ ] After refresh, updated resources display properly

**Components affected**:
- `src/components/Image/DetailV2/ImageResources.tsx`
- `src/components/Image/RefreshImageResources/RefreshImageResources.tsx`

---

### 3. Image Generation Data
**Route**: Any image detail or modal that shows generation data

**What to check**:
- [ ] Generation data displays correctly (model, version, base model)
- [ ] Resources list shows proper model/version names

**Components affected**:
- `src/components/ImageMeta/ImageMeta.tsx`
- Any component using `trpc.image.getGenerationData`

---

### 4. License Violation Checking
**Route**: `/posts/{postId}/edit` (sidebar warnings)

**What to check**:
- [ ] License violation warnings appear when NSFW level conflicts with resource licenses
- [ ] Warning shows correct model names and restricted levels
- [ ] Warning appears for images using restricted base models with incompatible content levels

**Components affected**:
- `src/components/Post/EditV2/PostEditSidebar.tsx`
- `src/utils/image-utils.ts` (`hasImageLicenseViolation` function)

---

### 5. Post Resource Reviews
**Route**: `/posts/{postId}/edit` (reviews section)

**What to check**:
- [ ] Resource reviews load correctly
- [ ] Resource names display properly in review UI

**Components affected**:
- `src/components/Post/EditV2/EditPostReviews.tsx`

---

## Data Fields Mapping

| Old Field (ImageResourceHelper) | New Field (ImageResourceSlim) |
|--------------------------------|------------------------------|
| `name` | `modelVersionName` |
| `modelVersionName` | `modelVersionName` |
| `modelVersionBaseModel` | `modelVersionBaseModel` |
| `modelId` | `modelId` |
| `modelName` | `modelName` |
| `modelType` | `modelType` |
| `modelVersionId` | `modelVersionId` |
| `detected` | `detected` |
| N/A | `strength` |

**Fields removed** (no longer available in slim type):
- `reviewId`, `reviewRating`, `reviewDetails`, `reviewCreatedAt`
- `modelDownloadCount`, `modelCommentCount`
- `modelThumbsUpCount`, `modelThumbsDownCount`
- `modelVersionCreatedAt`
- `image` (relation)

---

## Quick Smoke Test Steps

1. **Create a new post** with images that have detected resources
2. **Edit an existing post** - verify resources show on image cards
3. **Click refresh resources** button on an image in detail view
4. **Check license warnings** - upload an image with a restricted base model and set incompatible NSFW level
5. **View image generation data** - verify model/version info displays

---

## Backend Services Changed

- `src/server/services/post.service.ts` - `combinePostEditImageData`, `addResourceToPostImage`
- `src/server/services/image.service.ts` - `refreshImageResources`, `getImageDetail`, `getImageGenerationData`
- `src/server/redis/caches.ts` - `imageResourcesCache` query updated

## Type Location

The `ImageResourceSlim` type is defined in:
```
src/shared/types/image.types.ts
```
