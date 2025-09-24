# Bounties Feature Documentation

## Overview
The Bounties feature allows users to create rewards for specific tasks or content creation. Bounties can be funded with BUZZ (platform currency) and have various states throughout their lifecycle.

## Architecture

### Database Schema

#### Core Tables
- **Bounty**: Main bounty entity containing all bounty details
- **BountyEntry**: Submissions to bounties
- **BountyBenefactor**: Users who contribute funding to bounties
- **ImageConnection**: Links images to bounties (and other entities)

#### Key Fields in Bounty Table
- `id`: Primary key
- `userId`: Creator of the bounty
- `name`: Bounty title (locked after creation)
- `description`: Detailed description
- `startsAt` / `expiresAt`: Date range for bounty (UTC dates)
- `mode`: `BountyMode` (Individual/Split)
- `entryMode`: `BountyEntryMode` (Open/BenefactorsOnly)
- `complete`: Boolean indicating if bounty is completed
- `refunded`: Boolean indicating if bounty has been refunded
- `availability`: `Availability` enum (Public/Private/Unsearchable/EarlyAccess)
- `nsfw` / `nsfwLevel`: Content rating flags

## Visibility and Publication Logic

### When is a Bounty Visible in the Feed?

A bounty must meet several criteria to appear in the public feed:

1. **Must have at least one image**
   - Bounties without images are filtered out (`bounty.controller.ts:114`)
   - Images must be properly connected via the `ImageConnection` table

2. **Must have an associated user**
   - The bounty creator account must exist

3. **Image must be properly scanned** (for non-owners)
   - Regular users can only see images with:
     - `ingestion: ImageIngestionStatus.Scanned`
     - `needsReview: null`
   - Moderators can see all images regardless of status
   - Users always see their own images

4. **Status-based visibility** (optional filters):
   - **Open**: `complete: false`, `refunded: false`, `expiresAt > current date`
   - **Awarded**: `complete: true`, has entries, `refunded: false`
   - **Expired**: Various expired states

### Important Note on Availability Field
The `availability` field exists in the schema but is **NOT currently filtered** in the main query (`getAllBounties`). This means bounties with any availability status could potentially be returned, though they're filtered by other criteria.

## Image Connection Architecture

### How Images Connect to Bounties

Images use a polymorphic association pattern through the `ImageConnection` table:

```typescript
ImageConnection {
  imageId: Int        // Reference to Image table
  entityId: Int       // Bounty ID (or other entity)
  entityType: String  // "Bounty" for bounties
}
```

### Image Creation Flow

1. When creating a bounty with images:
   ```typescript
   await createEntityImages({
     images,
     tx,
     userId,
     entityId: bounty.id,
     entityType: 'Bounty'
   });
   ```

2. This creates:
   - Image records in the `Image` table
   - ImageConnection records linking images to the bounty

3. Images start with `ingestion: ImageIngestionStatus.Pending`

### Image Retrieval

When fetching bounties:
1. Query `ImageConnection` where `entityType = 'Bounty'`
2. Join with `Image` table for details
3. Apply visibility filters based on user role and image status

## Creation and Lifecycle

### Bounty Creation Process

1. **Validation**
   - Check user has sufficient BUZZ balance (if BUZZ currency)
   - Convert dates to UTC

2. **Database Transaction**
   - Create Bounty record
   - Create BountyBenefactor record (initial funding)
   - Create ImageConnection records (if images provided)
   - Create File records (if files provided)
   - Create BUZZ transaction (if applicable)

3. **Post-Creation**
   - Bust user content cache
   - Return bounty with formatted details

### Immediate Visibility After Creation

**Bounties are NOT immediately visible to everyone after creation.** They require:

1. **Image Processing**: Images must be scanned before the bounty appears to other users
   - Images start as `ImageIngestionStatus.Pending`
   - Must reach `ImageIngestionStatus.Scanned` status
   - This happens asynchronously via image ingestion pipeline

2. **Start Date**: Must be on or after the `startsAt` date

3. **Not Expired**: Must be before the `expiresAt` date

**Exception**: Bounty creators and moderators can see their bounties immediately, regardless of image scanning status.

## API Endpoints

### Router Configuration
- `getInfinite`: Public endpoint for feed/listing
- `getById`: Public endpoint for single bounty
- `create`: Protected endpoint requiring authentication
- `update`: Protected, owner or moderator only
- `delete`: Protected, owner or moderator only
- `addBenefactorUnitAmount`: Add funding to existing bounty
- `refund`: Moderator-only refund action

## Status Types

### BountyStatus Enum
- **Open**: Active and accepting entries
- **Expired**: Past expiration date
- **Awarded**: Completed with winner(s)

### Filtering Logic
- Open bounties: Not complete, not refunded, future expiry
- Awarded bounties: Complete with entries, not refunded
- Expired bounties: Past expiry date (various states)

## Key Services

### bounty.service.ts
- `getAllBounties`: Main query with filtering and sorting
- `createBounty`: Creation with transaction handling
- `updateBountyById`: Update existing bounties
- `getBountyImages`: Fetch images for a bounty
- `getImagesForBounties`: Batch image fetching
- `refundBounty`: Process refunds

### bounty.controller.ts
- `getInfiniteBountiesHandler`: Feed endpoint handler
- `getBountyHandler`: Single bounty handler
- Filters out bounties without images
- Applies NSFW level transformations

## Performance Considerations

1. **Image Batching**: Images are fetched in batches for multiple bounties
2. **Cursor Pagination**: Uses cursor-based pagination for infinite scroll
3. **Caching**: User content overview cache is busted on changes
4. **Transaction Limits**: 30-second timeout for creation transactions

## Security

1. **User Blocking**: Blocked users cannot see each other's bounties
2. **Image Visibility**: Strict controls based on scanning status
3. **Owner Permissions**: Only owners/moderators can edit/delete
4. **Fund Validation**: Balance checks before BUZZ transactions