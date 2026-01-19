# Challenge Platform - Handoff Document

> **For the next developer/agent working on this feature**

## Quick Start

To get the AI agent up to speed on this project, tell it:

```
Read docs/plans/challenge-platform-handoff.md and docs/challenge-design-questions.md to understand the Challenge Platform feature status and what needs to be done next.
```

---

## Current Status: Phase 1 Complete - Polished & Mobile-Optimized

### What's Been Built

#### Database Schema
- **Migration ready**: `prisma/migrations/20260113113902_add_challenge_system/migration.sql`
- Tables: `Challenge`, `ChallengeWinner`
- Enums: `ChallengeSource` (System/Mod/User), `ChallengeStatus` (Draft/Scheduled/Active/Judging/Completed/Cancelled)
- Entries stored as `CollectionItems` in Contest Mode collections (no separate ChallengeEntry table)

#### API Layer (tRPC)
- **Router**: `src/server/routers/challenge.router.ts` (slim, delegates to service)
- **Service**: `src/server/services/challenge.service.ts` (business logic)
- **Schema**: `src/server/schema/challenge.schema.ts` (types and Zod schemas)

**Public endpoints:**
- `getInfinite` - Paginated challenge feed with filters
- `getById` - Single challenge details
- `getUpcomingThemes` - Preview widget for upcoming challenges
- `getWinners` - Challenge winners

**Moderator endpoints:**
- `getModeratorList` - All challenges including drafts
- `upsert` - Create/update challenges (auto-creates collection, handles cover image)
- `updateStatus` - Change challenge status
- `delete` - Remove challenge (with entry validation)

#### Background Jobs
- `challenge-auto-queue.ts` - Maintains 30-day horizon of scheduled challenges
- `daily-challenge-processing.ts` - Reviews entries, picks winners (uses OpenRouter)

#### UI Components
- `src/components/Cards/ChallengeCard.tsx` - Card for challenge feed (displays cover image)
- `src/components/Challenge/ChallengesInfinite.tsx` - Infinite scroll feed
- `src/components/Challenge/ChallengeUpsertForm.tsx` - Moderator create/edit form
- `src/components/Challenge/challenge.utils.ts` - React Query hooks
- `src/pages/challenges/index.tsx` - Public challenges page
- `src/pages/challenges/[id]/[[...slug]].tsx` - Challenge details page (displays cover image)
- `src/pages/moderator/challenges/index.tsx` - Mod management page
- `src/pages/moderator/challenges/create.tsx` - Mod create page
- `src/pages/moderator/challenges/[id]/edit.tsx` - Mod edit page

#### Navigation
- Challenges tab added to `HomeContentToggle.tsx` (grouped under "More" menu)
- "Manage Challenge" button on details page links directly to edit page

---

## What's Been Completed

### Cover Image Upload ✅ Complete
- [x] Added `SimpleImageUpload` component to `ChallengeUpsertForm.tsx`
- [x] Schema accepts full `coverImage` object (like Article does)
- [x] Backend creates `Image` record when uploading new cover image
- [x] Edit page transforms `coverImageId`/`coverUrl` to `coverImage` object for form
- [x] Challenge details page displays cover image with `EdgeMedia2`
- [x] ChallengeCard displays cover image as background

### Form Improvements ✅ Complete
- [x] Add proper `ModelVersionSelector` component → `ModelVersionMultiSelect.tsx`
- [x] Style the NSFW level selector appropriately → `ContentRatingSelect.tsx`
- [x] Add date pickers for startsAt/endsAt/visibleAt → Using `DateTimePicker`

### "Enter Challenge" Resource Loading ✅ Complete
- [x] Changed button from Link to Button with onClick handler
- [x] Calls `generationPanel.open()` with model version ID from `modelVersionIds[0]`
- [x] Sets generator type to 'image' (default for challenges)

### Code Organization ✅ Complete
- [x] Separated business logic into `challenge.service.ts`
- [x] Moved types to `challenge.schema.ts`
- [x] Router is now slim (~65 lines) and delegates to service functions

### Form Refactoring ✅ Complete
- [x] Refactored `ChallengeUpsertForm.tsx` to use `Form` component pattern with custom Input components
- [x] Replaced Controller wrappers with `InputText`, `InputRTE`, `InputNumber`, `InputSelect`, `InputDateTimePicker`, `InputSimpleImageUpload`, `InputTextArea`
- [x] Form schema extends `upsertChallengeSchema` from server (single source of truth for validation)
- [x] Custom components (`ModelVersionMultiSelect`, `ContentRatingSelect`) wrapped with `withController` HOC

### Mobile Optimization ✅ Complete
- [x] Challenge details page (`/challenges/[id]`) optimized for mobile
  - Responsive header with stacked layout on mobile
  - Inline CTA after description on mobile (hidden sidebar CTA)
  - Responsive grid gutters and padding
- [x] Challenge upsert form optimized for mobile
  - `SimpleGrid` with responsive cols (`base: 1, sm: 2/3`) for all field groups
  - Responsive Paper padding (`p={{ base: 'sm', sm: 'md' }}`)
  - Full-width action buttons on mobile
- [x] `ModelVersionMultiSelect` updated to use `Input.Wrapper` for form compatibility
- [x] `ContentRatingSelect` updated to use `Input.Wrapper` for form compatibility

### Collection Metadata Sync ✅ Complete
- [x] `upsertChallenge` service syncs collection metadata when updating:
  - `submissionStartDate` / `submissionEndDate` (from challenge dates)
  - `maxItemsPerUser` (from `maxEntriesPerUser`)
  - `forcedBrowsingLevel` (from `allowedNsfwLevel`)

---

## What Needs to Be Done

### Immediate (Before Merge)

1. **Run the database migration**
   ```sql
   -- File: prisma/migrations/20260113113902_add_challenge_system/migration.sql
   -- Run this against your development database
   ```

2. **UI Review & Testing**
   - [ ] Test the `/challenges` page loads correctly
   - [ ] Test challenge cards render properly with cover images
   - [ ] Test `/moderator/challenges` page (requires mod account)
   - [ ] Test create/edit form functionality with cover image upload
   - [ ] Test filtering and sorting on challenge feed
   - [ ] Test "Manage Challenge" button links to edit page

3. **Data Migration** (if needed)
   - Script exists at `src/server/jobs/migrate-challenges.ts`
   - Migrates old Article-based challenges to new Challenge table

### Phase 2 (Future Work)

See `docs/features/challenge-platform.md` for full roadmap:
- Variable duration challenges (multi-day, flash challenges)
- User-created challenges with Buzz escrow
- Prompt Lab for custom judging criteria
- User challenge stats and leaderboards
- Streak tracking and badges

---

## Key Files to Review

| Purpose | File |
|---------|------|
| Database schema | `prisma/migrations/20260113113902_add_challenge_system/migration.sql` |
| API router | `src/server/routers/challenge.router.ts` |
| Business logic | `src/server/services/challenge.service.ts` |
| Types & Zod schemas | `src/server/schema/challenge.schema.ts` |
| Helper functions | `src/server/games/daily-challenge/challenge-helpers.ts` |
| Auto-queue job | `src/server/jobs/challenge-auto-queue.ts` |
| Processing job | `src/server/jobs/daily-challenge-processing.ts` |
| Challenge feed | `src/components/Challenge/ChallengesInfinite.tsx` |
| Challenge card | `src/components/Cards/ChallengeCard.tsx` |
| Challenge details page | `src/pages/challenges/[id]/[[...slug]].tsx` |
| Create/edit form | `src/components/Challenge/ChallengeUpsertForm.tsx` |
| Model version selector | `src/components/Challenge/ModelVersionMultiSelect.tsx` |
| NSFW level selector | `src/components/Challenge/ContentRatingSelect.tsx` |
| React Query hooks | `src/components/Challenge/challenge.utils.ts` |
| Form library | `src/libs/form/index.ts` (Input components used in form) |

---

## Architecture Overview

```
challenge.schema.ts          # Types (ChallengeDetail, ChallengeListItem, etc.)
       ↓                     # Zod schemas (upsertChallengeSchema, etc.)

challenge.service.ts         # Business logic functions
       ↓                     # getInfiniteChallenges(), upsertChallenge(), etc.
                             # Syncs collection metadata on update

challenge.router.ts          # tRPC endpoints (slim, delegates to service)
       ↓                     # Re-exports types for backward compatibility

challenge.utils.ts           # React Query hooks (useQueryChallenges, etc.)
       ↓

UI Components                # ChallengeCard, ChallengesInfinite, etc.

Form Architecture:
  upsertChallengeSchema      # Server-side validation schema
         ↓
  ChallengeUpsertForm        # Extends schema, adds flattened prize fields
         ↓                   # Uses Form component from ~/libs/form
  Input Components           # InputText, InputRTE, InputNumber, etc.
         ↓                   # Custom: InputModelVersionMultiSelect, InputContentRatingSelect
  withController HOC         # Wraps custom components for form integration
```

---

## Design Decisions Made

All design decisions are documented in `docs/challenge-design-questions.md` with `@dev:` and `@ai:` annotations. Key decisions:

1. **No limit on concurrent challenges** - Multiple can run simultaneously
2. **Entries use Collections** - No separate ChallengeEntry table, uses CollectionItems
3. **Auto-create collections** - Challenge creation auto-creates Contest Mode collection
4. **modelVersionIds is an array** - Supports requiring any of multiple model versions (OR logic)
5. **allowedNsfwLevel is bitwise** - Filter entries by NSFW level using bitwise flags
6. **Entry prizes distributed immediately** - When user reaches entry count threshold
7. **Cancelled challenges hidden** - Not visible in public feed
8. **Cover image uses Image table** - Like Article, creates Image record for cover uploads
9. **Form schema extends server schema** - `ChallengeUpsertForm` extends `upsertChallengeSchema` to keep validation in sync
10. **Custom inputs use Input.Wrapper** - `ModelVersionMultiSelect` and `ContentRatingSelect` use Mantine's `Input.Wrapper` for consistent form integration
11. **Collection metadata synced** - When challenge dates or settings change, collection metadata is updated in the same transaction

---

## Environment Requirements

```env
# Required for AI judging (OpenRouter)
OPENROUTER_API_KEY=your_key_here

# Standard database connection
DATABASE_URL=your_connection_string
```

---

## Testing Checklist

### As a Regular User
- [ ] Navigate to `/challenges` from the home page "More" menu
- [ ] View active challenges in the feed with cover images
- [ ] Click a challenge card to view details
- [ ] See cover image displayed on challenge details page
- [ ] Filter challenges by status (Active, Upcoming, Completed)

### As a Moderator
- [ ] Navigate to `/moderator/challenges`
- [ ] View all challenges including Drafts
- [ ] Create a new challenge with cover image upload
- [ ] Edit an existing challenge (cover image loads correctly)
- [ ] Click "Manage Challenge" on details page → goes to edit page
- [ ] Change challenge status (Draft → Scheduled → Active)
- [ ] Delete a draft challenge

### Background Jobs (Manual Trigger)
- [ ] `challenge-auto-queue` job creates scheduled challenges
- [ ] `daily-challenge-processing` job reviews entries when challenge ends

---

## Questions?

Review the full specification in `docs/features/challenge-platform.md` for context on the feature vision and phased implementation plan.
