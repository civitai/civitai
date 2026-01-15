# Challenge Platform - Handoff Document

> **For the next developer/agent working on this feature**

## Quick Start

To get the AI agent up to speed on this project, tell it:

```
Read docs/plans/challenge-platform-handoff.md and docs/challenge-design-questions.md to understand the Challenge Platform feature status and what needs to be done next.
```

---

## Current Status: Phase 1 Complete - Ready for Testing

### What's Been Built

#### Database Schema
- **Migration ready**: `prisma/migrations/20260113113902_add_challenge_system/migration.sql`
- Tables: `Challenge`, `ChallengeWinner`
- Enums: `ChallengeSource` (System/Mod/User), `ChallengeStatus` (Draft/Scheduled/Active/Judging/Completed/Cancelled)
- Entries stored as `CollectionItems` in Contest Mode collections (no separate ChallengeEntry table)

#### API Layer (tRPC)
- **Router**: `src/server/routers/challenge.router.ts`
- Public endpoints:
  - `getInfinite` - Paginated challenge feed with filters
  - `getDetail` - Single challenge details
  - `getWinners` - Challenge winners
- Moderator endpoints:
  - `getModeratorChallenges` - All challenges including drafts
  - `upsert` - Create/update challenges (auto-creates collection)
  - `updateStatus` - Change challenge status
  - `delete` - Remove challenge

#### Background Jobs
- `challenge-auto-queue.ts` - Maintains 30-day horizon of scheduled challenges
- `daily-challenge-processing.ts` - Reviews entries, picks winners (uses OpenRouter)

#### UI Components
- `src/components/Cards/ChallengeCard.tsx` - Card for challenge feed
- `src/components/Challenge/ChallengesInfinite.tsx` - Infinite scroll feed
- `src/components/Challenge/ChallengeUpsertForm.tsx` - Moderator create/edit form
- `src/pages/challenges/index.tsx` - Public challenges page
- `src/pages/moderator/challenges/index.tsx` - Mod management page
- `src/pages/moderator/challenges/[id]/edit.tsx` - Mod edit page

#### Navigation
- Challenges tab added to `HomeContentToggle.tsx` (grouped under "More" menu)

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
   - [ ] Test challenge cards render properly
   - [ ] Test `/moderator/challenges` page (requires mod account)
   - [ ] Test create/edit form functionality
   - [ ] Test filtering and sorting on challenge feed

3. **Form Improvements** ✅ Complete
   - [x] Add proper `ModelVersionSelector` component → `ModelVersionMultiSelect.tsx`
   - [x] Style the NSFW level selector appropriately → `ContentRatingSelect.tsx`
   - [x] Add date pickers for startsAt/endsAt/visibleAt → Using `DateTimePicker`

4. **Data Migration** (if needed)
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
| Schema validation | `src/server/schema/challenge.schema.ts` |
| Helper functions | `src/server/games/daily-challenge/challenge-helpers.ts` |
| Auto-queue job | `src/server/jobs/challenge-auto-queue.ts` |
| Processing job | `src/server/jobs/daily-challenge-processing.ts` |
| Challenge feed | `src/components/Challenge/ChallengesInfinite.tsx` |
| Challenge card | `src/components/Cards/ChallengeCard.tsx` |
| Create/edit form | `src/components/Challenge/ChallengeUpsertForm.tsx` |
| Model version selector | `src/components/Challenge/ModelVersionMultiSelect.tsx` |
| NSFW level selector | `src/components/Challenge/ContentRatingSelect.tsx` |

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
- [ ] View active challenges in the feed
- [ ] Click a challenge card to view details
- [ ] Filter challenges by status (Active, Upcoming, Completed)

### As a Moderator
- [ ] Navigate to `/moderator/challenges`
- [ ] View all challenges including Drafts
- [ ] Create a new challenge with the form
- [ ] Edit an existing challenge
- [ ] Change challenge status (Draft → Scheduled → Active)
- [ ] Delete a draft challenge

### Background Jobs (Manual Trigger)
- [ ] `challenge-auto-queue` job creates scheduled challenges
- [ ] `daily-challenge-processing` job reviews entries when challenge ends

---

## Questions?

Review the full specification in `docs/features/challenge-platform.md` for context on the feature vision and phased implementation plan.
