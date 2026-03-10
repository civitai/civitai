# Product Badge Management - Implementation Plan

## Problem
Every month, the team manually creates `Cosmetic` badge records tied to subscription products, sets their `data.url`, `data.animated`, `availableStart`/`availableEnd`, and links them via `productId`. This is tedious and error-prone.

## Solution
A new moderator page at `/moderator/cosmetic-store/badges` that:
- Lists all active subscription products with their vendor/provider and tier
- Shows the current (latest) badge cosmetic per product
- Lets mods upload a new badge, mark it animated/static, set availability dates, and assign it to one or more products in one action

## Architecture

The existing delivery job (`deliver-purchased-cosmetics.ts`) already handles distributing cosmetics to users based on `Cosmetic.productId` + `availableStart`/`availableEnd`. We just need a clean UI to create those `Cosmetic` records.

## Files to Create

### 1. `src/server/schema/product-badge.schema.ts`
Zod schemas:
- `getProductsWithBadgesInput` - optional filters (provider, search)
- `upsertProductBadgeInput` - badge URL, animated boolean, product IDs, availability dates, optional cosmetic ID for updates, name

### 2. `src/server/services/product-badge.service.ts`
Service functions:
- `getProductsWithBadges()` - queries `Product` table joined with latest `Cosmetic` (type=Badge) per product. Returns product id, name, provider, tier, and current badge data (url, animated, availableStart/End)
- `upsertProductBadge()` - creates or updates a `Cosmetic` record with type=Badge, source=Membership, permanentUnlock=false, the given productId(s), data={url, animated}, and availability dates. When assigning to multiple products, creates one cosmetic per product (since `productId` is a single field on the Cosmetic model)

### 3. `src/server/routers/product-badge.router.ts`
tRPC router with moderator-only procedures:
- `getProductsWithBadges` - query
- `upsertProductBadge` - mutation

### 4. `src/pages/moderator/cosmetic-store/badges/index.tsx`
Main page with two sections:

**Section A: Product Badge Overview (table)**
- Columns: Product Name, Provider, Tier, Current Badge (image preview), Badge Period, Actions (edit)
- Filters: search by product name, filter by provider
- Each row shows the product's most recent badge cosmetic

**Section B: Create/Edit Badge Form (below or as modal)**
- Image upload dropzone (using `useCFImageUpload` + `SimpleImageUpload` pattern)
- Animated toggle (Switch)
- Name field (defaults to "Month Year Tier Badge" format)
- Available Start / Available End date pickers
- Product multi-select showing: product name, provider, and tier for easy identification
- Preview of uploaded badge
- Save button

## Files to Modify

### 1. `src/server/routers/index.ts`
Register the new `productBadge` router.

### 2. `src/pages/moderator/cosmetic-store/index.tsx`
Add a "Manage Badges" button linking to `/moderator/cosmetic-store/badges`.

## Key Design Decisions

1. **One cosmetic per product** - Since `Cosmetic.productId` is a single string, we create separate cosmetic records when assigning to multiple products. They share the same badge URL and settings.

2. **No schema changes** - We use existing Prisma models as-is. The `Cosmetic` table already has all needed fields (`productId`, `type`, `source`, `data` JSON, `availableStart`, `availableEnd`, `permanentUnlock`).

3. **No changes to delivery logic** - The existing `deliver-purchased-cosmetics` job already matches cosmetics to products by `productId` and checks availability windows. New badges created through this UI will be picked up automatically.

4. **Product metadata updates** - We also update `Product.metadata.badge` and `Product.metadata.badgeType` when setting a badge, so the badge image shows correctly in plan details pages.
