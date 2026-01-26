All right, so I've been thinking about kind of a fun new feature that we can add because it's been so long since we've added a good community feature to the platform. The thing that's been on my mind is this thing called crucibles. The thought there actually stems from a bigger set of features that we were planning called factions, but the factions thing is going to be a much bigger thing to take on, and I want to build something that can be done today. And so I think we can take just the crucible portion of my whole factions plan and implement it. So I'm going to give you a link to kind of all of the factions planning stuff, and you can dig through that to kind of get the documentation you need about Crucible. But the general idea is this. Crucible works like this. A user can set up a Crucible. They basically define the challenge in a way. You know, set up the theme, set up the resources that you can use, et cetera. And define the parameters for, you know, having your entry accepted. And then, they can use the theme to create a new type of theme. that can define how many entries each user can have, and they set up an entry price, and then users submit entries to the Crucible. And each entry has a price to enter, and then the images are, or content, because it could also be videos, are put head-to-head. So users are presented two things at once, and they vote A or B. And we use an ELO score to help kind of rank the images. and then prizes are awarded as defined during the Crucible setup. And essentially what they are is they get a stake of the prize pool, and the prize pool comes from the entry fees. The idea is that these would be really fast The majority of Crucibles would be you know 24 hours or less and maybe the default would be like something like 8 hours and if they want to go longer than be able to do that for the first time So the person creating the crucible has to pay essentially a setup fee or something And then we would have a new section on the site where people could see all of the crucibles and they be ordered by either prize value or creation time and they be searchable People would be able to sort by you know the name of the crucible or the base models that were being used and we would limit what could be submitted based on the models that the user selected when setting up the Crucible. And I think, yeah, let's start with that. I also like the idea of maybe making it so that the generation happens inside of the Crucible interface, so like to make your entries you have to create them there, but we can always verify that the content has the parameters that the Crucible creator specified. You can look at the data schema here. we have the ability to see what resources were used for creating an image. For videos, it's a little bit more complicated. The metadata typically doesn't include that, so we would have to, you know, just trust users that they're doing it correctly. And then I think we'll also want to have the ability to set, you know, which NSFW levels are allowed in a Crucible, and then make it so that when users are reviewing content inside of that Crucible, we also apply their browsing preferences. So you're going to want to go discover kind of all of these systems, and rather than having to rediscover these things over and over again, if you could add them to the docs, that would be great so that future agents could go look there and then add something to the Claude.md to say, hey, you know, here's how these features work and then point to the feature documents so that in the future agents can go look directly at those documents rather than having to dig into the systems themselves. So go ahead and get that setup done, do some discovery, and then once we've done some discovery, ask some questions, I'll answer those questions and we'll prepare an implementation plan.

upon further review, it looks like maybe the info about factions is on the main branch or something of the Justin origin. I don't know, can you look for branches there and find the factions docs?
for safety, let's do that discovery and stuff inside of a work tree so that we don't dirty this main repo.

---

## Tracking

**ClickUp Task:** https://app.clickup.com/t/868h3x3f7
**GitHub PR:** https://github.com/civitai/civitai/pull/1959

### Agent Instructions

When working on this feature, post progress updates to the ClickUp task:

```bash
# Post a comment when starting a phase
node .claude/skills/clickup/query.mjs comment 868h3x3f7 "Starting Phase 1: Database & Foundation"

# Post a comment when completing a phase
node .claude/skills/clickup/query.mjs comment 868h3x3f7 "Completed Phase 1: Schema, service, and router created"

# Post a comment if blocked or need input
node .claude/skills/clickup/query.mjs comment 868h3x3f7 "Blocked: Need clarification on prize distribution edge case"
```

Keep comments concise - just phase progress and any blockers.

---

## Discovery Complete

@ai:* I found and reviewed the factions documentation on `justin/feature/factions` branch. I've documented the key systems in `docs/features/crucible-dependencies.md` and updated `CLAUDE.md` with references.

### What I Found

**Factions Documentation Location:** `C:/Dev/Repos/work/model-share-crucible-discovery/docs/features/factions/`
- `initial.md` - Full factions system overview
- `clarifying-questions.md` - Detailed Q&A with Justin
- `scope/database.md` - Complete Prisma schema
- `scope/backend.md` - Services and tRPC routes
- `scope/ui.md` - Frontend components and pages

### Crucible System Summary (from Factions Docs)

**What is a Crucible:**
- Head-to-head content competitions within factions
- Users submit entries (images or posts)
- Judges vote A vs B on pairs of entries
- Prizes awarded based on final position
- Entry fees create prize pool

**Database Schema (from factions docs):**
```prisma
model Crucible {
  id            Int
  factionId     Int       // Links to faction
  userId        Int?      // User who hosted (null = faction-hosted)
  name          String
  description   String?
  imageId       Int?      // Cover image
  nsfwLevel     Int       // Bitwise flag
  configuration Json      // entryLimit, prizes, requirements, entryFee
  status        CrucibleStatus  // pending/active/judging/finalizing/completed/cancelled
  startAt       DateTime
  endAt         DateTime
}

model CrucibleEntry {
  id          Int
  crucibleId  Int
  userId      Int
  entityType  CrucibleEntityType  // image, post
  entityId    Int
  nsfwLevel   Int
  score       Int       // Vote count or ELO rating
  position    Int?      // Final position when completed
}
```

**ClickHouse Table (for vote tracking):**
```sql
CREATE TABLE crucible_entry_rating (
  crucible_id UInt32,
  winner_entry_id UInt32,
  loser_entry_id UInt32,
  user_id UInt32,
  created_at DateTime
)
```

**Crucible Types (via tokens in full factions system):**
- Skirmish: 1 day, 1-10 entries/user, fixed prizes
- Battle: 3 days, 1-30 entries/user, bigger prizes
- Tournament: 7 days, 1-100 entries/user, % of entry fees

### Existing Systems Discovered

I documented these in `docs/features/crucible-dependencies.md`:

| System | Purpose | Integration |
|--------|---------|-------------|
| Image Resources | Verify models used | `ImageResourceNew` table |
| NSFW Filtering | Content filtering | `Flags` class + `NsfwLevel` enum |
| Buzz Accounts | Entry fees + prizes | Central bank pattern (account 0) |
| Notifications | Results alerts | `createNotification()` |
| Metrics | Analytics | ClickHouse `entityMetricEvents` |
| Knights of New | Vote weighting reference | Level-based weights |

---

## Clarifying Questions

@ai:* Before preparing an implementation plan, I need to clarify some differences between the standalone Crucible you described vs. the faction-integrated version in the docs:

### 1. Faction Dependency
The factions docs show Crucible tightly coupled to factions (`factionId` required). You mentioned wanting standalone crucibles today.

**Question:** Should we:
- **A)** Build faction-independent crucibles now (any user can create/join)
- **B)** Build the faction infrastructure first, then crucibles
- **C)** Build crucibles with optional `factionId` (works standalone or within faction)

@justin: A - We can always add faction ID later if needed, once we have factions.

### 2. Crucible Creation
In factions, crucibles are created by using "Crucible Tokens" earned through the faction system. You mentioned a "setup fee" for creating crucibles.

**Question:** How should users create crucibles in the standalone version?
- **A)** Pay Buzz directly (flat fee, e.g., 1000 Yellow Buzz)
- **B)** Free to create with entry fees funding prizes
- **C)** Tiered pricing based on duration/entry limits
- **D)** Something else?

@justin: B, with premium options available (C - longer durations, higher entry limits, higher entry fee)

### 3. Scoring System
You mentioned ELO scoring. The factions Q&A shows Justin leaning toward simple vote count initially.

**Question:** Which scoring approach?
- **A)** Simple vote count (easier to implement, easier to understand)
- **B)** ELO from day one (fairer for tournaments with many entries)
- **C)** Start with vote count, design for easy ELO swap later

@justin: B - simple vote won't be fair for later entries...

### 4. Prize Distribution
The factions docs describe prizes as gif boxes, buzz, items, etc. For standalone:

**Question:** What can prizes be?
- **A)** Buzz only (Yellow/Green)
- **B)** Buzz + percentage of entry fee pool
- **C)** Buzz + cosmetics
- **D)** Full item system (requires more infrastructure)

@justin: B - but just percentage of entry fee pool - (this prize positions and percentages should be configurable when setting up the crucible as a premium option)

### 5. Entry Types
The factions docs support images and posts. You mentioned images and videos.

**Question:** What content types should entries support?
- **A)** Images only (simplest, metadata for resource verification)
- **B)** Images + Posts (post = carousel of images)
- **C)** Images + Videos (video metadata doesn't include resources)
- **D)** All of the above

@justin: C - they're all technically just Image in the database, we just won't verify video metadata...

### 6. Resource Restrictions
You mentioned limiting entries to specific base models. We can verify this via `ImageResourceNew`.

**Question:** How strict should resource validation be?
- **A)** Required - entries rejected if wrong resources
- **B)** Validated but manual review if mismatch
- **C)** Honor system with visible resource display
- **D)** No validation (any content allowed)

@justin: A/D (an option for the crucible creator when making the crucible)

### 7. Discovery/Browse Page
You mentioned a section to see all crucibles, sortable/searchable.

**Question:** Where should this live?
- **A)** New top-level nav item "Crucibles"
- **B)** Under existing "Events" or "Challenges" section
- **C)** Under "Community" dropdown
- **D)** Integrated into main image feed somehow

@justin: A - before Articles
@justin: Can you please create a Claude sub-agent? Go ahead and check the docs on that. For creating design mockups that follow our design system, we use Mantine V7 and Tailwind. You can kind of browse a few components to get an idea of what we use. And these design agents create single-page HTML files to a specific directory, following a single-page HTML file. using a folder structure essentially, so that we can get several variations of a design quickly. And then maybe we make a new Claude skill called Quick Mockups or something that is intended to tell Claude how to use these sub-agents to create five mockups in parallel using these sub-agents under its direction. That would be fantastic. Then after you've done that, let's go ahead and create mockups of this discovery page, and mockups of the crucible landing page, and mockups of the submission page, and mockups of the actual rating experience.

@ai: Done. Created:
- `.claude/agents/design-mockup.md` - Subagent for HTML mockups
- `.claude/skills/quick-mockups/SKILL.md` - Skill for parallel mockup creation
- See [Finalized UI Mockups](#finalized-ui-mockups) section below for selected designs

### 8. Duration Defaults
You mentioned 8 hours default, up to 24 hours typical.

**Question:** What duration constraints?
- **A)** Fixed options: 8h, 24h, 3d, 7d
- **B)** Flexible with min 1h, max 7d
- **C)** Based on "tier" (Skirmish/Battle/Tournament pattern)

@justin: A - 8h is free, longer options cost a setup fee premium...

### 9. Who Can Judge
In factions, any faction member can judge. For standalone:

**Question:** Who can vote on entries?
- **A)** Anyone (logged in)
- **B)** Anyone except entry submitters
- **C)** Users meeting certain criteria (account age, karma, etc.)
- **D)** Invited judges only

@justin: A - Crucible creator can limit to verified users (basically requires the user to have a specific user score or to be a paying member) for a premium.

### 10. MVP Scope
Given you want to "build something that can be done today":

**Question:** What's the MVP vs. future iterations?

**Suggested MVP:**
- [ ] Crucible creation (name, description, duration, entry fee, entry limit, NSFW level, allowed resources)
- [ ] Entry submission (images only)
- [ ] Head-to-head voting (5 pairs at a time)
- [ ] ~~Simple vote count scoring~~ @justin: ELO is a must
- [ ] Automatic prize distribution (Buzz from entry fees)
- [ ] Basic browse page (list, filter by status) @justin: Maybe ability to sort by prize pool size, ending soon, newest
- [ ] Notifications (crucible ended, you won)

**Future iterations:**
- [ ] ELO scoring @justin: Yeah - this needs to be promoted to MVP
- [ ] Premium setup features @justin: For now let's have the buttons, but just have them disabled
- [ ] ~~Post entries (image carousels)~~
- [ ] Video entries @justin: This can be promoted since it's essentially the same as image...
- [ ] In-crucible generation
- [ ] Faction integration
- [ ] Advanced discovery/search

Does this MVP scope align with your vision?

---

Once you answer these questions, I'll prepare a detailed implementation plan with database schema, services, routes, and UI components.

---

## Finalized UI Mockups

After several iterations, these are the selected mockups for each page:

| Page | Mockup | Description |
|------|--------|-------------|
| **Discovery** | [discovery.html](./mockups/discovery.html) | Browse all crucibles with filters, sort by prize/ending/newest |
| **Crucible Landing** | [landing.html](./mockups/landing.html) | Single crucible view with entries, leaderboard, your entries section |
| **Creation** | [creation.html](./mockups/creation.html) | Step-by-step crucible creation flow with premium options |
| **Submission** | [submission.html](./mockups/submission.html) | Modal-based entry submission from existing images |
| **Rating** | [rating.html](./mockups/rating.html) | A/B voting experience with keyboard shortcuts |

### Key UI Decisions from Mockups

**Discovery Page** ([mockup](./mockups/discovery.html)):
- Top-level nav item "Crucibles" before Articles
- Grid of crucible cards showing: name, prize pool, time remaining, entry count
- Sort options: Prize Pool, Ending Soon, Newest
- Filter by status (Active, Upcoming, Completed)

**Crucible Landing** ([mockup](./mockups/landing.html)):
- Hero section with crucible info and prize breakdown
- Tabs: All Entries, Leaderboard, Your Entries, Rules
- "Submit Entry" and "Judge Now" CTAs
- Your entries section shows your submissions and their current ranking

**Creation Flow** ([mockup](./mockups/creation.html)):
- Multi-step form: Basic Info → Entry Rules → Prizes → Review
- Duration selector with free (8h) and premium options (24h, 3d, 7d)
- Entry fee configuration with preview of prize pool
- Resource restrictions (optional) with base model selector
- NSFW level configuration

**Submission Modal** ([mockup](./mockups/submission.html)):
- Modal triggered from crucible landing page
- Select from user's existing images (filtered by crucible requirements)
- Shows entry fee and confirms submission
- Validates resource requirements before allowing submission

**Rating Experience** ([mockup](./mockups/rating.html)):
- Side-by-side image comparison
- Keyboard shortcuts: A/Left for left, D/Right for right
- Skip option for undecided
- Progress indicator showing votes cast
- Quick stats on each entry (current position hint without spoiling)

---

## Implementation Plan

This is a high-level plan with callouts for areas needing discovery and detail.

### Phase 1: Database Schema

**New Tables Required:**

```prisma
model Crucible {
  id            Int       @id @default(autoincrement())
  userId        Int       // Creator
  user          User      @relation(fields: [userId], references: [id])
  name          String
  description   String?
  imageId       Int?      // Cover image
  image         Image?    @relation(fields: [imageId], references: [id])
  nsfwLevel     Int       // Bitwise flag for allowed content
  status        CrucibleStatus @default(pending)

  // Configuration (JSONB)
  entryFee      Int       // Buzz cost per entry
  entryLimit    Int       // Max entries per user
  maxTotalEntries Int?    // Optional cap on total entries
  prizePositions Json     // Array of {position, percentage}
  allowedResources Json?  // Optional: {baseModels: [], modelVersionIds: []}
  judgeRequirements Json? // Optional: {verifiedOnly: bool, minUserScore: int}

  // Timing
  duration      Int       // Duration in hours
  startAt       DateTime
  endAt         DateTime

  // Metadata
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  // Relations
  entries       CrucibleEntry[]

  @@index([status, endAt])
  @@index([userId])
}

model CrucibleEntry {
  id          Int       @id @default(autoincrement())
  crucibleId  Int
  crucible    Crucible  @relation(fields: [crucibleId], references: [id], onDelete: Cascade)
  userId      Int
  user        User      @relation(fields: [userId], references: [id])
  imageId     Int
  image       Image     @relation(fields: [imageId], references: [id])

  score       Int       @default(1500)  // ELO rating
  position    Int?      // Final position (set when crucible ends)

  createdAt   DateTime  @default(now())

  @@unique([crucibleId, imageId])  // Can't submit same image twice
  @@index([crucibleId, score])
  @@index([userId])
}

enum CrucibleStatus {
  pending     // Created but not started
  active      // Accepting entries and votes
  completed   // Ended, prizes distributed
  cancelled   // Cancelled by creator or admin
}
```

**ClickHouse Tables:**
```sql
-- Vote tracking (use buffer table for batching)
CREATE TABLE crucible_votes (...)  -- See crucible-dependencies.md

-- @TODO: Determine if we need additional analytics tables
```

**Redis Keys:**
```
crucible:{id}:elo          -- Hash of entryId -> current ELO
crucible:{id}:vote_count   -- Total votes cast
crucible:{id}:entry_count  -- Total entries
```

> **@DISCOVERY NEEDED:** Check existing schema for similar patterns (Bounty, Contest, etc.) that we can reference for consistency.

---

### Phase 2: Backend Services

**New Services:**

1. **`crucible.service.ts`** - Core CRUD and business logic
   - `createCrucible()` - Validate, create, handle premium fees
   - `getCrucible()` / `getCrucibles()` - With filters (status, sort)
   - `submitEntry()` - Validate resources, charge entry fee, create entry
   - `submitVote()` - Update ELO in Redis, write to ClickHouse buffer
   - `getJudgingPair()` - Smart matchmaking (blend of top/new/random)
   - `finalizeCrucible()` - Calculate final positions, distribute prizes
   - `cancelCrucible()` - Refund logic

2. **`crucible-elo.service.ts`** - ELO calculation helpers
   - `calculateEloChange()` - The math
   - `getEntryRatings()` - Fetch from Redis
   - `updateRatings()` - Atomic Redis update
   - `finalizeRatings()` - Copy Redis → PostgreSQL

> **@DISCOVERY NEEDED:**
> - Look at `bounty.service.ts` for prize pool patterns
> - Look at `games/new-order.service.ts` for matchmaking patterns
> - Check how we handle Buzz transactions for fees

**tRPC Routes:**
```typescript
// crucible.router.ts
crucible.getAll        // List with filters
crucible.getById       // Single crucible detail
crucible.create        // Create new crucible
crucible.submitEntry   // Submit an entry
crucible.getJudgingPair // Get pair to vote on
crucible.submitVote    // Cast vote
crucible.getLeaderboard // Current standings
crucible.getMyEntries  // User's entries in a crucible
```

> **@DISCOVERY NEEDED:** Review existing router patterns for consistency (error handling, validation schemas).

---

### Phase 3: Background Jobs

**Jobs Needed:**

1. **`finalize-crucibles.ts`** - Cron job to end crucibles
   - Run every minute
   - Find crucibles where `status = active AND endAt < now()`
   - Call `finalizeCrucible()` for each
   - Send notifications to winners

2. **`start-crucibles.ts`** - Optional: if we support scheduled start
   - Find crucibles where `status = pending AND startAt < now()`
   - Update to `active`

> **@DISCOVERY NEEDED:** Look at existing job patterns in `src/server/jobs/` for scheduling and error handling.

---

### Phase 4: Frontend Components

**Pages to Create:**

| Route | Component | Mockup |
|-------|-----------|--------|
| `/crucibles` | `CruciblesPage` | [Discovery](./mockups/discovery.html) |
| `/crucibles/[id]` | `CrucibleDetailPage` | [Landing](./mockups/landing.html) |
| `/crucibles/create` | `CrucibleCreatePage` | [Creation](./mockups/creation.html) |
| `/crucibles/[id]/judge` | `CrucibleJudgePage` | [Rating](./mockups/rating.html) |

**Modals/Dialogs:**
- `CrucibleSubmitEntryModal` - [Submission mockup](./mockups/submission.html)
- Register in `dialog-registry.ts`

**Shared Components to Create:**
- `CrucibleCard` - Card for discovery grid
- `CrucibleHeader` - Hero section for detail page
- `CruciblePrizeBreakdown` - Prize pool visualization
- `CrucibleEntryGrid` - Grid of entries with stats
- `CrucibleLeaderboard` - Ranked list of entries
- `CrucibleJudgingUI` - Side-by-side voting interface
- `CrucibleTimer` - Countdown/time remaining

> **@DISCOVERY NEEDED - CRITICAL:** Before building, search for similar existing components:
> - Card components (ModelCard, BountyCard, ArticleCard) - reuse patterns
> - Grid layouts (MasonryGrid usage) - follow existing patterns
> - Timer components - may already exist
> - Image selection modals - likely exists for posts
> - Leaderboard components - check contests/bounties
> - Side-by-side comparison - check if exists anywhere

---

### Phase 5: Navigation & Routing

**Changes Needed:**

1. Add "Crucibles" to main nav (before Articles)
   - File: `src/components/AppLayout/SubNav.tsx` (or similar)
   - Icon: `IconTrophy` or similar from Tabler

2. Add route handling for `/crucibles/*`

> **@DISCOVERY NEEDED:** Find where nav items are configured and how routes are registered.

---

### Phase 6: Notifications

**Notification Types:**
- `crucible-ended` - "Your crucible has ended"
- `crucible-won` - "You placed #X in {crucibleName}"
- `crucible-entry-submitted` - "Someone entered your crucible"

> **@DISCOVERY NEEDED:** Review `src/server/notifications/` for patterns and registration.

---

### Phase 7: Metric Event Watcher Integration

**External Codebase:** `C:\Dev\Repos\work\civitai\metric-event-watcher`

**Tasks:**
1. Add Debezium subscription for `Crucible` and `CrucibleEntry` tables
2. Create handler similar to `bounty-entries.ts`
3. Define ClickHouse materialized views for aggregations

> **@DISCOVERY NEEDED:** Explore the metric-event-watcher codebase to understand:
> - How to add new table subscriptions
> - Handler patterns
> - ClickHouse view definitions

---

### Discovery Checklist (Completed)

Discovery completed - see [Discovery Findings](#discovery-findings) below for details.

**UI Components:**
- [x] Card components - `BountyCard`, `ArticleCard`, `ModelCard` patterns → use `AspectRatioImageCard` as base
- [x] Grid/Masonry layouts - `MasonryGrid2`, `MasonryContainer`, `InViewLoader` for infinite scroll
- [x] Image selection UI - `ImageSelectModal` pattern with multi-source selection
- [x] Timer/countdown components - `Countdown` component (real-time) + `DaysFromNow` (relative)
- [x] Leaderboard/ranking displays - `CreatorCard`, `RankBadge` with crown icons for top 3
- [x] Side-by-side comparison UI - No existing component, build custom
- [x] Prize/reward displays - `CurrencyBadge` component
- [x] Stats badges - `IconBadge` with `cardClasses.chip` styling

**Backend Patterns:**
- [x] Prize pool handling - `bounty.service.ts` central bank pattern (account 0)
- [x] Fee transactions - `TransactionType.Bounty` (8), `createMultiAccountBuzzTransaction()`
- [x] Matchmaking/pairing logic - See [Matchmaking Proposal](#matchmaking-proposal) below
- [x] ClickHouse integration - `Tracker` class, buffer tables, `$query`/`$exec` helpers
- [x] Redis caching - Hash operations (`hSet`/`hGet`/`hIncrBy`), `createCounter` pattern

**Infrastructure:**
- [x] Job scheduling - `createJob()`, `getJobDate()` tracking, Redis locks
- [x] Notification registration - `createNotificationProcessor()`, register in `utils.notifications.ts`
- [x] Router organization - `guardedProcedure`, `isFlagProtected`, Zod schemas, `isOwnerOrModerator` middleware
- [x] Dialog registry - `dialog-registry2.ts`, `dialogStore.trigger()`, `useDialogContext()`

---

### Implementation Order (Suggested)

1. **Schema** - Create migration, generate types
2. **Basic Service** - CRUD operations only
3. **Discovery Page** - List crucibles (proves data flow)
4. **Create Page** - Create a crucible
5. **Detail Page** - View single crucible
6. **Entry Submission** - Submit entries
7. **Judging UI** - Vote on pairs
8. **ELO System** - Redis integration
9. **Finalization Job** - End crucibles, distribute prizes
10. **Notifications** - Alert winners
11. **Premium Features** - Duration upgrades, verified judges
12. **Polish** - Edge cases, error handling, loading states

---

## Detailed Implementation Plan

### Phase 1: Database & Foundation
**Goal:** Get data layer working end-to-end

#### 1.1 Schema & Migration
- [ ] Add `Crucible` and `CrucibleEntry` models to `prisma/schema.prisma`
- [ ] Add `CrucibleStatus` enum
- [ ] Add relations to `User` and `Image` models
- [ ] Create empty migration: `npm run db:migrate:empty crucible`
- [ ] Run migration: `npm run db:migrate`
- [ ] Generate Prisma client: `npm run db:generate`

#### 1.2 Zod Schemas
- [ ] Create `src/server/schema/crucible.schema.ts`
  - [ ] `getCruciblesInfiniteSchema` - list query with filters
  - [ ] `getCrucibleByIdSchema` - single fetch
  - [ ] `createCrucibleInputSchema` - creation input
  - [ ] `updateCrucibleInputSchema` - update input
  - [ ] `submitEntrySchema` - entry submission
  - [ ] `submitVoteSchema` - vote casting

#### 1.3 Basic Service
- [ ] Create `src/server/services/crucible.service.ts`
  - [ ] `createCrucible()` - basic create (no Buzz yet)
  - [ ] `getCrucible()` - fetch by ID with relations
  - [ ] `getCrucibles()` - list with filters/pagination
  - [ ] `updateCrucible()` - basic update
  - [ ] `deleteCrucible()` - soft delete/cancel

#### 1.4 Router
- [ ] Create `src/server/routers/crucible.router.ts`
  - [ ] `getInfinite` - public, paginated list
  - [ ] `getById` - public, single crucible
  - [ ] `create` - guarded, create crucible
  - [ ] `update` - guarded + owner check
  - [ ] `delete` - protected + owner check
- [ ] Register in `src/server/routers/index.ts`
- [ ] Add `crucible` feature flag to feature flags system

#### 1.5 Verify Foundation
- [ ] Test via tRPC playground or API call
- [ ] Confirm types are generated correctly

---

### Phase 2: Discovery Page (Read-Only UI)
**Goal:** Display crucibles in a browsable grid

#### 2.1 CrucibleCard Component
- [ ] Create `src/components/Cards/CrucibleCard.tsx`
  - [ ] Use `AspectRatioImageCard` as base
  - [ ] Header: status badge
  - [ ] Footer: creator avatar, name, countdown, prize pool, entry count
  - [ ] Apply `cardClasses.chip` styling
- [ ] Create `src/components/Cards/CrucibleCard.module.scss` if needed

#### 2.2 Discovery Page
- [ ] Create `src/pages/crucibles/index.tsx`
  - [ ] Use `MasonryContainer` layout
  - [ ] Add filter controls (status, sort)
  - [ ] Implement `CruciblesInfinite` component
  - [ ] Use `InViewLoader` for infinite scroll
- [ ] Create `src/components/Crucible/CruciblesInfinite.tsx`
  - [ ] Connect to `trpc.crucible.getInfinite`
  - [ ] Map results to `CrucibleCard`

#### 2.3 Navigation
- [ ] Add "Crucibles" to main nav (before Articles)
- [ ] Find nav config file and add entry
- [ ] Add route icon (IconTrophy or similar)

#### 2.4 Verify Discovery
- [ ] Seed test data manually or via script
- [ ] Confirm cards render, filters work, infinite scroll loads

---

### Phase 3: Crucible Detail Page (Read-Only)
**Goal:** View a single crucible with entries and leaderboard

#### 3.1 Detail Page Structure
- [ ] Create `src/pages/crucibles/[id]/index.tsx`
  - [ ] Fetch crucible via `trpc.crucible.getById`
  - [ ] Hero section with crucible info
  - [ ] Tabs: All Entries, Leaderboard, Your Entries, Rules

#### 3.2 Components
- [ ] Create `src/components/Crucible/CrucibleHeader.tsx` - hero section
- [ ] Create `src/components/Crucible/CruciblePrizeBreakdown.tsx` - prize visualization
- [ ] Create `src/components/Crucible/CrucibleEntryGrid.tsx` - entry thumbnails
- [ ] Create `src/components/Crucible/CrucibleLeaderboard.tsx` - ranked list
  - [ ] Use `CreatorCard` pattern with crown icons
- [ ] Create `src/components/Crucible/CrucibleTimer.tsx` - countdown wrapper

#### 3.3 Verify Detail Page
- [ ] Navigate from discovery to detail
- [ ] Confirm all tabs render
- [ ] Test with 0, 1, and many entries

---

### Phase 4: Crucible Creation
**Goal:** Users can create new crucibles

#### 4.1 Creation Page
- [ ] Create `src/pages/crucibles/create.tsx`
  - [ ] Multi-step form (Basic Info → Entry Rules → Prizes → Review)
  - [ ] Use React Hook Form + Zod validation
  - [ ] Duration selector (8h free, premium options disabled)
  - [ ] Entry fee input with prize pool preview
  - [ ] NSFW level selector
  - [ ] Optional resource restrictions (base model picker)

#### 4.2 Cover Image Upload
- [ ] Add cover image dropzone
- [ ] Use existing `useCFImageUpload()` hook
- [ ] Create image and link to crucible

#### 4.3 Buzz Integration (Entry Fee Collection)
- [ ] Update `createCrucible()` service:
  - [ ] Validate user has sufficient Buzz
  - [ ] Call `createMultiAccountBuzzTransaction()` for setup fee (if premium)
  - [ ] Store transaction prefix for potential refund
- [ ] Add `buzzTransactionId` field to Crucible model if needed

#### 4.4 Verify Creation
- [ ] Create crucible end-to-end
- [ ] Confirm appears in discovery
- [ ] Confirm Buzz deducted (if applicable)

---

### Phase 5: Entry Submission
**Goal:** Users can submit images to crucibles

#### 5.1 Submission Modal
- [ ] Create `src/components/Crucible/CrucibleSubmitEntryModal.tsx`
  - [ ] Use `ImageSelectModal` pattern
  - [ ] Filter images by crucible requirements (NSFW, resources)
  - [ ] Show entry fee and confirm
- [ ] Create trigger: `src/components/Dialog/triggers/crucible-submit-entry.ts`
- [ ] Register in `dialog-registry2.ts`

#### 5.2 Entry Service
- [ ] Add to `crucible.service.ts`:
  - [ ] `submitEntry()` - validate, charge fee, create entry
  - [ ] `getMyEntries()` - user's entries in a crucible
  - [ ] `validateEntryRequirements()` - check resources, NSFW
- [ ] Add `submitEntry` mutation to router

#### 5.3 Entry Fee Collection
- [ ] Charge entry fee via `createMultiAccountBuzzTransaction()`
- [ ] Store transaction prefix on entry for refund
- [ ] Update prize pool tracking

#### 5.4 Verify Submission
- [ ] Submit entry to crucible
- [ ] Confirm entry appears in crucible
- [ ] Confirm Buzz deducted
- [ ] Test requirement validation (wrong NSFW level, etc.)

---

### Phase 6: Judging/Voting System
**Goal:** Users can vote on entry pairs

#### 6.1 Judging Page
- [ ] Create `src/pages/crucibles/[id]/judge.tsx`
  - [ ] Side-by-side image comparison
  - [ ] Keyboard shortcuts (A/Left, D/Right, S/Skip)
  - [ ] Progress indicator
  - [ ] Skip button

#### 6.2 Judging Components
- [ ] Create `src/components/Crucible/CrucibleJudgingUI.tsx`
  - [ ] Two image panels
  - [ ] Vote buttons
  - [ ] Keyboard listener
- [ ] Create `src/components/Crucible/CrucibleJudgingProgress.tsx`

#### 6.3 Matchmaking Service
- [ ] Add to `crucible.service.ts`:
  - [ ] `getJudgingPair()` - implement Algorithm E (Dynamic Weighted Hybrid)
  - [ ] `submitVote()` - record vote, update ELO
  - [ ] `getUserVotedPairs()` - pairs user has already voted on
- [ ] Add router endpoints:
  - [ ] `getJudgingPair` query
  - [ ] `submitVote` mutation

#### 6.4 Vote Tracking (ClickHouse)
- [ ] Create ClickHouse table `crucible_votes`
- [ ] Add `crucibleVote()` method to Tracker class
- [ ] Insert votes on each submission

#### 6.5 Verify Judging
- [ ] Get pair, vote, get new pair
- [ ] Confirm same pair doesn't repeat
- [ ] Test keyboard shortcuts
- [ ] Verify votes logged to ClickHouse

---

### Phase 7: ELO System
**Goal:** Real-time ELO updates with Redis

#### 7.1 Redis ELO Cache
- [ ] Add Redis key pattern to `REDIS_SYS_KEYS`
- [ ] Create `src/server/redis/crucible-elo.redis.ts`
  - [ ] `setElo(crucibleId, entryId, elo)`
  - [ ] `getElo(crucibleId, entryId)`
  - [ ] `getAllElos(crucibleId)`
  - [ ] `incrementElo(crucibleId, entryId, change)`

#### 7.2 ELO Calculation
- [ ] Create `src/server/services/crucible-elo.service.ts`
  - [ ] `calculateEloChange(winnerElo, loserElo, kFactor)`
  - [ ] `getKFactor(voteCount)` - provisional K-factor
  - [ ] `processVote(crucibleId, winnerEntryId, loserEntryId)`

#### 7.3 Integrate with Voting
- [ ] Update `submitVote()` to call ELO service
- [ ] Update Redis after each vote
- [ ] Track vote count per entry

#### 7.4 Leaderboard from Redis
- [ ] Update leaderboard component to read from Redis
- [ ] Sort entries by ELO for display

#### 7.5 Verify ELO
- [ ] Vote multiple times
- [ ] Confirm ELO changes appropriately
- [ ] Test provisional K-factor (new entries move faster)

---

### Phase 8: Finalization & Prizes
**Goal:** End crucibles and distribute prizes

#### 8.1 Finalization Job
- [ ] Create `src/server/jobs/finalize-crucibles.ts`
  - [ ] Query active crucibles past endAt
  - [ ] Copy Redis ELO to PostgreSQL
  - [ ] Calculate positions
  - [ ] Distribute prizes
  - [ ] Update status to completed
- [ ] Register job in `[[...run]].ts`

#### 8.2 Prize Distribution
- [ ] Add to `crucible.service.ts`:
  - [ ] `finalizeCrucible(id)` - full finalization logic
  - [ ] `calculatePrizeDistribution()` - apply percentages
  - [ ] `distributePrizes()` - Buzz transactions
- [ ] Handle rounding (round down, remainder lost)

#### 8.3 Refund Logic
- [ ] Add `cancelCrucible()` (moderator only)
- [ ] Refund all entry fees via stored transaction prefixes
- [ ] Update status to cancelled

#### 8.4 Verify Finalization
- [ ] Create crucible with short duration
- [ ] Submit entries, cast votes
- [ ] Wait for job to run (or trigger manually)
- [ ] Confirm prizes distributed
- [ ] Confirm final positions set

---

### Phase 9: Notifications
**Goal:** Notify users of crucible events

#### 9.1 Notification Types
- [ ] Create `src/server/notifications/crucible.notifications.ts`
  - [ ] `crucible-ended` - your crucible has ended
  - [ ] `crucible-won` - you placed #X
  - [ ] `crucible-entry-submitted` - someone entered your crucible

#### 9.2 Register Notifications
- [ ] Add to `src/server/notifications/utils.notifications.ts`
- [ ] Import and spread `crucibleNotifications`

#### 9.3 Send Notifications
- [ ] After finalization, notify all participants
- [ ] After entry submission, notify crucible creator

#### 9.4 Verify Notifications
- [ ] Check notification appears in user's inbox
- [ ] Test notification links work

---

### Phase 10: Polish & Edge Cases
**Goal:** Production-ready quality

#### 10.1 Loading States
- [ ] Add skeletons to CrucibleCard
- [ ] Add loading overlays during submissions
- [ ] Handle empty states (no crucibles, no entries)

#### 10.2 Error Handling
- [ ] Graceful errors for insufficient Buzz
- [ ] Handle race conditions in voting
- [ ] Validate all inputs server-side

#### 10.3 Edge Cases
- [ ] Crucible with 0 entries at end (no prizes)
- [ ] Crucible with 1 entry (auto-win)
- [ ] User tries to vote on own entry
- [ ] Concurrent vote submissions

#### 10.4 Anti-Manipulation (Future)
- [ ] Honeypot pairs (Phase 2)
- [ ] Velocity limits (Phase 2)
- [ ] Contrarian detection (Phase 2)

#### 10.5 Premium Features (Disabled)
- [ ] Add UI for premium options (duration, verified judges)
- [ ] Disable with "Coming Soon" tooltip
- [ ] Wire up when ready

---

### Phase Summary

| Phase | Focus | Key Deliverables |
|-------|-------|------------------|
| 1 | Foundation | Schema, service, router |
| 2 | Discovery | CrucibleCard, browse page, nav |
| 3 | Detail | Detail page, tabs, leaderboard |
| 4 | Creation | Create form, Buzz integration |
| 5 | Submission | Entry modal, fee collection |
| 6 | Judging | A/B voting, matchmaking |
| 7 | ELO | Redis cache, calculations |
| 8 | Finalization | Job, prizes, refunds |
| 9 | Notifications | Alerts for events |
| 10 | Polish | Edge cases, loading states |

**Estimated task count:** ~80 individual tasks across 10 phases

---

### Open Questions (Resolved)

1. **Entry fee refunds** - If crucible cancelled, refund all entry fees? @justin: Yes. Only moderators can cancel, though.
2. **Minimum entries** - Should crucibles require minimum entries to start? @justin: No.
3. **Creator entries** - Can the crucible creator submit entries? @justin: Yes.
4. **Vote limits** - Max votes per user per crucible? @justin: No limit, but they can only rate an image once.
5. **Matchmaking** - Exact algorithm for pairing entries? @justin: Not sure. Got ideas? Propose them to a gemini review agent and get one that'll be efficient and work for what we're doing
6. **Prize rounding** - How to handle percentage splits that don't divide evenly? @justin: Round down, any left overs just get lost.

@ai: All questions answered. Key decisions:
- Only moderators can cancel (triggers full entry fee refunds)
- No minimum entry requirement - crucibles run regardless
- Creators can enter their own crucibles
- Users can vote unlimited times, but only once per image pair (prevents duplicate ratings)
- Prize pool remainder after rounding goes to the house
- **Matchmaking algorithm:** See [Matchmaking Proposal](#matchmaking-proposal) below

---

## Matchmaking Proposal

@ai: Proposed algorithms to Gemini 3 Pro for review. **Recommended: Algorithm E (Dynamic Weighted Hybrid)**.

### The Algorithm

Instead of hard phases based on total votes, use **per-image maturity phases**:

**Phase Selection for Image A:**
1. Pick an image weighted by lowest vote count (prioritize under-voted entries)
2. Determine phase based on Image A's individual vote count:

| Phase | Vote Count | Opponent Selection | Purpose |
|-------|------------|-------------------|---------|
| Calibration | 0-5 votes | Match against "anchor" images (avg ELO, low variance) | Quickly establish if above/below average |
| Discovery | 6-20 votes | Match against high-uncertainty images | Refine position |
| Optimization | 20+ votes | Match against similar ELO (±100) | Competitive fine-tuning |

### Provisional K-Factor (Cold Start Solution)

New entries get boosted ELO change to find their "true home" quickly:

```typescript
const BASE_K = 32;
const PROVISIONAL_K = 64;
const PROVISIONAL_THRESHOLD = 10;

function getKFactor(voteCount: number): number {
  return voteCount < PROVISIONAL_THRESHOLD ? PROVISIONAL_K : BASE_K;
}
```

### Anti-Manipulation Strategies

1. **Honeypot Pairs:** Every ~20th vote, show a "control pair" (clear winner). If user votes wrong 3+ times, shadow-ban their votes.

2. **Blind Voting:** Never show author during voting phase.

3. **Velocity Limits:** If voting faster than 1.5s/vote consistently, discard votes.

4. **Contrarian Detection:** Track users who consistently vote against global ELO trends. Lower weight of their votes.

### Implementation

```typescript
async function getJudgingPair(crucibleId: number, userId: number): Promise<[Entry, Entry]> {
  const entries = await getEligibleEntries(crucibleId, userId);
  const votedPairs = await getUserVotedPairs(crucibleId, userId);

  // 1. Select Image A: weighted by lowest vote count
  const imageA = selectWeightedByLowVotes(entries);

  // 2. Determine phase and select Image B
  let imageB: Entry;
  if (imageA.voteCount <= 5) {
    // Calibration: match against anchors (avg ELO, settled)
    imageB = selectAnchorEntry(entries, imageA, votedPairs);
  } else if (imageA.voteCount <= 20) {
    // Discovery: match against uncertain entries
    imageB = selectUncertainEntry(entries, imageA, votedPairs);
  } else {
    // Optimization: match against similar ELO
    imageB = selectSimilarElo(entries, imageA, votedPairs, 100);
  }

  // 3. Randomize left/right position
  return Math.random() > 0.5 ? [imageA, imageB] : [imageB, imageA];
}
```

### Why This Works
- **Scales:** Works for 10 entries or 500+
- **No Fatigue:** Mix changes naturally as images mature
- **Late Entries:** New images enter at Phase 1 regardless of crucible age
- **Efficient:** Converges to accurate rankings quickly

---

## Discovery Findings

### UI Component Patterns

**Card Components** (for CrucibleCard):
```typescript
// Use AspectRatioImageCard as base
<AspectRatioImageCard
  href={`/crucibles/${id}`}
  aspectRatio="square"
  image={coverImage}
  header={<Badge>{status}</Badge>}
  footer={
    <>
      <UserAvatarSimple {...creator} />
      <Text lineClamp={2}>{name}</Text>
      <IconBadge icon={<IconClock />}><DaysFromNow date={endsAt} /></IconBadge>
      <CurrencyBadge currency="BUZZ" unitAmount={prizePool} />
    </>
  }
  footerGradient
/>
```

**Key Files:**
- `src/components/CardTemplates/AspectRatioImageCard.tsx` - Base template
- `src/components/Cards/Cards.module.css` - Shared badge styles (`.chip`, `.infoChip`, `.statChip`)
- `src/components/Cards/BountyCard.tsx` - Best reference for prize/deadline cards

**Grid/Masonry:**
- Use `MasonryContainer` + `ArticlesInfinite` pattern
- `InViewLoader` for infinite scroll (400px root margin)
- Column widths: 320px default, max 7 columns

**Timer:**
- `<Countdown endTime={date} format="short" />` - Real-time "4d 3h 20m"
- `<DaysFromNow date={date} />` - Relative "in 4 days"

**Image Selection:**
- Copy `ImageSelectModal` pattern from training
- Uses `trpc.image.getMyImages.useInfiniteQuery()`
- Supports multi-source (generation, uploaded)

**Leaderboard:**
- `CreatorCard` pattern with crown icons for top 3
- Gold (#FFD700), Silver (#C0C0C0), Bronze (#CD7F32)
- Position delta with chevron icons

**Dialog Registry:**
```typescript
// 1. Add to dialog-registry2.ts
'crucible-submit-entry': { component: dynamic(() => import(...)) }

// 2. Create trigger in triggers/crucible-submit-entry.ts
export function openCrucibleSubmitEntryModal(props) {
  dialogStore.trigger({ component: Modal, props });
}

// 3. Use in component
<button onClick={() => openCrucibleSubmitEntryModal({ crucibleId })}>
```

### Backend Patterns

**Prize Pool (Central Bank Pattern):**
```typescript
// Collect entry fee
await createMultiAccountBuzzTransaction({
  fromAccountId: userId,
  fromAccountTypes: ['yellow'],
  toAccountId: 0,  // Central bank
  amount: entryFee,
  type: TransactionType.Bounty,
  details: { entityId: crucibleId, entityType: 'Crucible' },
});

// Distribute prize
await createMultiAccountBuzzTransaction({
  fromAccountId: 0,
  toAccountId: winnerId,
  amount: prizeAmount,
  type: TransactionType.Bounty,
});

// Refund (on cancel)
await refundMultiAccountTransaction(txPrefix);
```

**Job Scheduling:**
```typescript
// src/server/jobs/finalize-crucibles.ts
export const finalizeCruciblesJob = createJob(
  'finalize-crucibles',
  '*/1 * * * *',  // Every minute
  async (jobContext) => {
    const now = new Date();
    const ended = await dbRead.crucible.findMany({
      where: { status: 'active', endAt: { lte: now } }
    });

    for (const crucible of ended) {
      jobContext.checkIfCanceled();
      await finalizeCrucible(crucible.id);
    }

    return { finalized: ended.length };
  }
);

// Register in pages/api/webhooks/run-jobs/[[...run]].ts
export const jobs: Job[] = [...existingJobs, finalizeCruciblesJob];
```

**Redis ELO Cache:**
```typescript
// Store ELO in Redis hash
const key = `crucible:${crucibleId}:elo`;
await sysRedis.hSet(key, entryId.toString(), elo.toString());
await sysRedis.hIncrBy(key, entryId.toString(), eloChange);
const allElos = await sysRedis.hGetAll(key);

// Copy to PostgreSQL when crucible ends
await dbWrite.crucibleEntry.updateMany({
  where: { crucibleId },
  data: { score: finalElo }
});
```

**ClickHouse Vote Tracking:**
```typescript
// Insert via Tracker (fire-and-forget)
ctx.track.crucibleVote({
  crucibleId, winnerEntryId, loserEntryId, userId, createdAt: new Date()
});

// Or batch insert
await clickhouse.insert({
  table: 'crucible_votes',
  values: votes,
  format: 'JSONEachRow',
});
```

**Router Pattern:**
```typescript
export const crucibleRouter = router({
  getInfinite: publicProcedure
    .input(getCruciblesInfiniteSchema)
    .use(isFlagProtected('crucible'))
    .query(getCruciblesInfiniteHandler),

  create: guardedProcedure
    .input(createCrucibleInputSchema)
    .use(isFlagProtected('crucible'))
    .mutation(createCrucibleHandler),

  submitVote: protectedProcedure
    .input(submitVoteSchema)
    .use(isFlagProtected('crucible'))
    .mutation(submitVoteHandler),
});
```
