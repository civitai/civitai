# Auction Service Documentation

## Overview
The Auction Service is a bidding system that allows users to compete for featured placement spots on Civitai. Users place bids using Buzz (internal currency) to have their model versions prominently displayed in various sections of the platform. The system supports both one-time and recurring bids, with daily/weekly auction cycles.

Currently used for models, but ability to auction other types of content is possible (images).

## Architecture

### Database Schema

The auction system uses four main tables:

#### AuctionBase
Core auction configuration that defines auction types and settings:
```
AuctionBase {
  id           Int           -- Primary key
  type         AuctionType   -- Type of content being auctioned (Model, Image, etc.)
  ecosystem    String?       -- Model ecosystem (e.g., "Pony", "SDXL", "Misc")
  name         String        -- Display name
  slug         String        -- URL-friendly identifier
  quantity     Int           -- Number of winner slots available
  minPrice     Int           -- Minimum bid amount in Buzz
  active       Boolean       -- Whether auction is currently active
  runForDays   Int           -- How many days auction runs (default 1)
  validForDays Int           -- How long winning bid is featured (default 1)
  description  String?       -- Optional description
}
```

#### Auction
Individual auction instances created from AuctionBase:
```
Auction {
  id            Int           -- Primary key
  auctionBaseId Int           -- Reference to AuctionBase
  startAt       DateTime      -- When bidding starts
  endAt         DateTime      -- When bidding ends
  quantity      Int           -- Number of winner slots (inherited from base)
  minPrice      Int           -- Minimum bid (inherited from base)
  validFrom     DateTime      -- When winners are featured from
  validTo       DateTime      -- When winners are featured until
  finalized     Boolean       -- Whether auction has been processed
}
```

#### Bid
Individual user bids on auctions:
```
Bid {
  id             Int          -- Primary key
  auctionId      Int          -- Reference to Auction
  userId         Int          -- User placing the bid
  entityId       Int          -- Model version or content being bid on
  amount         Int          -- Bid amount in Buzz
  createdAt      DateTime     -- When bid was placed
  deleted        Boolean      -- Soft delete flag
  transactionIds String[]     -- Related Buzz transaction IDs
  isRefunded     Boolean      -- Whether bid was refunded
  fromRecurring  Boolean      -- Whether created from recurring bid
}
```

#### BidRecurring
Recurring bid configurations:
```
BidRecurring {
  id            Int          -- Primary key
  auctionBaseId Int          -- Reference to AuctionBase
  userId        Int          -- User with recurring bid
  entityId      Int          -- Content being bid on
  amount        Int          -- Daily bid amount
  createdAt     DateTime     -- When created
  startAt       DateTime     -- When to start bidding
  endAt         DateTime?    -- When to stop (null = forever)
  isPaused      Boolean      -- Whether temporarily paused
}
```

### Backend Services

#### Service Layer (`src/server/services/auction.service.ts`)

**Key Functions:**

- `getAllAuctions()`: Returns all active auctions with minimum bid requirements
  - Fetches current auctions (where now is between startAt and endAt)
  - Calculates winning positions and minimum bid needed
  - Sorts by ecosystem with "Misc" auctions last

- `getAuctionBySlug()`: Retrieves detailed auction data by slug
  - Includes all bids and current rankings
  - Enhances with model version metadata and images
  - Supports date offset for viewing past/future auctions

- `prepareBids()`: Aggregates and ranks bids
  - Combines multiple bids from same user on same entity
  - Sorts by total amount (tiebreaker: bid count)
  - Returns positions and winning status

- `createBid()`: Places a new bid or increases existing
  - Validates sufficient Buzz balance
  - Validates model version eligibility (published, correct type/ecosystem)
  - Creates Buzz transaction
  - Optionally creates recurring bid
  - Sends real-time updates via SignalR

- `deleteBid()`: Soft deletes and refunds a bid
  - Only allowed during active auction period
  - Refunds Buzz to user account
  - Updates auction positions in real-time

- `getMyBids()`: Returns all user's active bids
  - Shows position, winning status, additional amount needed
  - Groups by auction with entity metadata

- `getMyRecurringBids()`: Returns user's recurring bid configurations

- `togglePauseRecurringBid()`: Pauses/resumes recurring bid

#### Router Layer (`src/server/routers/auction.router.ts`)

TRPC endpoints protected by feature flag:
- `getAll`: Public - returns all active auctions
- `getBySlug`: Public - returns specific auction details
- `getMyBids`: Protected - user's current bids
- `getMyRecurringBids`: Protected - user's recurring configurations
- `createBid`: Protected - place or increase bid
- `deleteBid`: Protected - cancel and refund bid
- `deleteRecurringBid`: Protected - remove recurring configuration
- `togglePauseRecurringBid`: Protected - pause/resume recurring

### Job Processing

#### Daily Auction Handler (`src/server/jobs/handle-auctions.ts`)

Runs at midnight UTC daily with four sequential steps:

1. **Clean Old Collection Items**
   - Removes expired featured model versions
   - Clears search index entries
   - Busts caches

2. **Handle Previous Auctions**
   - Finalizes ended auctions
   - Determines winners based on bid totals
   - Creates featured model version records
   - Sends winner/loser notifications
   - Updates search indices
   - Refunds non-winning bids

3. **Create Recurring Bids**
   - Processes all active recurring bid configurations
   - Creates new bid entries for the day
   - Handles insufficient funds scenarios
   - Sends failure notifications if needed

4. **Create New Auctions**
   - Generates daily auction instances (next day) from active AuctionBase records
   - Sets appropriate start/end times
   - Configures featured period dates

### Frontend Components

#### Provider (`src/components/Auction/AuctionProvider.tsx`)

Context provider managing auction UI state:
- Selected auction and model
- Bid submission feedback
- Drawer state for mobile navigation
- Viewing state tracking

#### Main Page (`src/pages/auctions/[[...slug]].tsx`)

Dynamic routing supporting:
- `/auctions` - Shows first available auction
- `/auctions/[slug]` - Shows specific auction
- `/auctions/my-bids` - Shows user's bid dashboard

Features:
- Server-side rendering with data prefetching
- Mobile-responsive drawer navigation
- Real-time bid updates via SignalR
- Tour integration for onboarding

#### Key UI Components

- **AuctionInfo**: Displays auction details and bidding interface
- **AuctionMyBids**: User's bid management dashboard
- **AuctionPlacementCard**: Shows current auction rankings
- **BidModelButton**: Bidding action component
- **AuctionFiltersDropdown**: Filter controls for browsing

## Data Flow

### Bidding Flow
1. User selects model version to bid on
2. System validates:
   - User has sufficient Buzz balance
   - Model meets auction requirements (type, ecosystem, published status)
   - Auction is currently active
3. Buzz transaction created and balance deducted
4. Bid record created or updated
5. Real-time update broadcast to all viewers
6. Optional: Recurring bid configuration saved

### Daily Processing Flow
1. **Midnight UTC**: Job triggered
2. **Finalization**: Previous day's auctions processed
3. **Winners**: Top N bidders (based on quantity) marked as winners
4. **Featured**: Winner's content scheduled for featuring
5. **Refunds**: Non-winning bids refunded
6. **Recurring**: New bids created from recurring configurations
7. **New Auctions**: Next day's auctions created

## Key Features

### Bid Aggregation
- Multiple bids from same user on same item are combined
- Total amount determines ranking
- Bid count used as tiebreaker

### Ecosystem Filtering
Auctions can be limited to specific model ecosystems:
- **Null**: Checkpoint models only
- **"Misc"**: Various model types (LoRA, Embedding, etc.)
- **Specific** (e.g., "SDXL", "Pony"): Models compatible with that base

### Recurring Bids
- Automatically place bids daily
- Can run indefinitely or until specified date
- Pauseable without deletion
- Failure notifications on insufficient funds

### Real-time Updates
- SignalR broadcasting for live bid changes
- Instant position updates for all viewers
- No page refresh required

### Model Validation
Prevents bidding on:
- Private or unpublished models
- Models marked with `cannotPromote` flag
- Person of Interest (POI) flagged content
- Models outside allowed type/ecosystem

## Notifications

System sends notifications for:
- **Won Auction**: Confirmation of winning bid with feature period
- **Dropped Out**: Alert when outbid and no longer winning
- **Failed Recurring**: Recurring bid failed due to insufficient funds
- **Canceled Bid**: Bid canceled with refund reason

## Performance Optimizations

- Cursor-based pagination for bid lists
- Redis caching for model version data
- Batch processing in daily jobs
- Search index updates for featured content
- Cache busting on state changes

## Security & Validation

- Feature flag protection (`auctions`) for all operations
- User authentication required for bidding
- Balance checks before bid placement
- Transaction rollback on failures
- Soft deletes for audit trail
- Refund mechanisms for errors

## Error Handling

- Insufficient funds errors with clear messaging
- Model validation errors with specific reasons
- Transaction failures trigger automatic refunds
- Job failures tracked in Axiom logging
- Retry logic for critical operations

## Usage Examples

### Auction Position Calculation
```typescript
// If auction has 3 slots and minimum bid of 50:
// Bid totals: [150, 120, 80, 60, 40]
// Winners: positions 1-3 (≥50 Buzz)
// Minimum to win: 81 Buzz (beat position 3)
```

## Deployment Considerations

1. **Daily Job Timing**: Runs at UTC midnight - consider timezone impacts
2. **Buzz Balance**: Ensure sufficient liquidity for refunds
3. **Cache Management**: Featured content caches need coordinated busting
4. **Search Index**: Updates required for featured model discovery
5. **Signal Broadcasting**: WebSocket infrastructure for real-time updates
6. **Feature Flags**: `auctions` flag controls entire system availability
