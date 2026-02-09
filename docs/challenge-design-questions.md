# Challenge Platform - Design Questions

These questions arose during agent review of the Challenge Platform implementation. Please review and provide inline feedback.

---

## 1. Multiple Concurrent Challenges

The current spec states:
> "Multiple challenges can be active simultaneously"

Agent recommendation suggested: "When setting a challenge active, deactivate other active challenges"

**Current Implementation**: Allows multiple concurrent active challenges.

@dev: There should be no limit to the number of concurrent challenges. The plan is to make it so that it's a whole system and users will be able to add challenges and we can add challenges and there could be a bunch of different active challenges at the same time.

@ai: Confirmed. No changes needed - current implementation already supports unlimited concurrent challenges.

---

## 2. Winner Image Validation

`ChallengeWinner` stores an `imageId`, but there's no foreign key constraint ensuring that image is actually an entry in the challenge's collection.

**Options**:
- A) Trust application logic to only award winners from valid entries
- B) Add a database trigger or check constraint
- C) Add runtime validation in the award procedure

@dev: the speaker is a little bit more. Maybe it also needs to link to a collection item ID that belongs to the challenge. I mean, there was additional data that we were putting on the with the collection item ID for challenges previously. Are we still doing that? I guess there probably still wouldn't be a foreign key constraint there. I guess you could check and make sure that it's in the collection. Either way, it would require an additional check, some logic to run. So I think we should probably just go with A and trust that the application's only going to award winners that are valid.

@ai: Understood. Option A - trust application logic. The award winners procedure will verify the image is in the collection before awarding. No schema changes needed.

---

## 3. Draft Challenges and Scheduling Horizon

The `challenge-auto-queue` job looks 30 days ahead for scheduling. Currently it queries:
```sql
WHERE status IN ('Draft', 'Scheduled') AND startsAt <= NOW() + INTERVAL '30 days'
```

**Question**: Should Draft challenges count toward the 30-day planning horizon, or only Scheduled ones?

@dev: I think only scheduled ones, and essentially the auto-creation of challenges should go directly into a scheduled state.

@ai: Will update `challenge-auto-queue.ts` to only query Scheduled status (remove Draft from the query). Auto-created challenges will be created with `status: Scheduled` instead of Draft.

---

## 4. Collection Creation

When creating a challenge, should the system auto-create a Contest Mode collection?

**Current behavior**: `collectionId` is required, moderator must create/link collection separately.

**Alternative**: Auto-create collection when challenge is created, with proper Contest Mode settings.

@dev: The challenge collection should be auto-created with all of the correct settings, essentially like it was before. Having to manually create that collection is stupid, and really collections are just an artifact of a challenge in this situation.

@ai: Will update the challenge creation flow to auto-create a Contest Mode collection. The existing `createChallengeCollection()` helper in `challenge-helpers.ts` already does this. Will integrate it into the router's upsert procedure so moderators don't need to create collections manually.

Changes needed:
1. Make `collectionId` optional on input schema
2. Auto-create collection in the upsert procedure if not provided
3. Set proper Contest Mode metadata (maxItemsPerUser, submissionStartDate, submissionEndDate, forcedBrowsingLevel)

---

## 5. Entry Model/Version Validation

Challenges can require a specific `modelId` or `modelVersionId`. How should we validate that submissions actually use the required resource?

**Options**:
- A) Trust the collection's existing validation (if any)
- B) Add custom validation in the submission flow
- C) Validate during judging phase only
- D) No validation - it's on the honor system

@dev: We already handled this validation. You can look and see how we were doing it previously. We should do it the same way. We were looking at the meta, not the metadata, the image resources. I think there's a table called image resource new or something like that. You'll see it in the code. We were already doing this. I think we'll want to make it so that challenges, though, and you might need to make some adjustments here, can support multiple models or model version IDs. So this might require some changes on your end. this requirement would be an OR requirement, not an AND requirement, meaning that as long as you have at least one of the model versions, you're accepted.
@dev: I'm realizing that there's probably another requirement that we should allow the challenge creators to set, and that's not safe for work level. They should be able to say, hey, it's limited to PG through PG-13 entries, or, hey, this only is an X-rated challenge, or something like that, if that makes sense. So, if you don't already have that in there, we'll want to add that. Keep in mind that's currently a bitwise flag, so you don't have to have some array or something like that to handle this. the existing challenge system only allowed PG entries, and so you can kind of see how that works if you're looking at how to validate this.

@ai: Found the existing validation in `daily-challenge-processing.ts:reviewEntries()` - it queries `ImageResourceNew` table to verify the image was generated using one of the challenge's model versions.

**Schema changes completed:**
1. ✅ Changed to `modelVersionIds Int[]` (array) in Challenge table
2. ✅ Added `allowedNsfwLevel Int @default(1)` field - bitwise flag for allowed NSFW levels
3. ✅ Updated collection creation to set `forcedBrowsingLevel` in collection metadata

**Validation logic (OR requirement):**
- Entry is valid if image has ANY of the required modelVersionIds in `ImageResourceNew`
- Entry NSFW level must match `allowedNsfwLevel` bitwise flag
- Job uses SQL `ANY()` operator for array matching

**UI Components created:**
- `ModelVersionMultiSelect.tsx` - Uses resource select modal to pick multiple model versions
- `ContentRatingSelect.tsx` - Visual checkbox selector with presets (SFW Only, Include Mature, All Content)

---

## 6. Challenge Visibility Logic

Current implementation:
- `visibleAt` controls when challenge appears in public feed
- Draft challenges are never visible to public
- Cancelled challenges remain visible (is this correct?)

@dev: They should be hidden.

@ai: Will update `getChallengeDetail()` visibility check to also hide Cancelled challenges from public. They'll still be visible to moderators.

---

## 7. Entry Prize Distribution

The spec mentions `entryPrize` (participation prize) and `entryPrizeRequirement` (minimum entries to qualify).

**Question**: When should entry prizes be distributed?
- A) Immediately when user reaches the threshold during the challenge
- B) After challenge ends, during the judging phase
- C) After winners are announced

@dev: A.

@ai: Option A - distribute immediately when user reaches threshold during the challenge. This will require a trigger in the entry submission flow (when CollectionItem count for user reaches `entryPrizeRequirement`). Will need to track which users have already received their entry prize to avoid double-awarding.

**Implementation approach:**
1. Add `entryPrizeAwardedAt DateTime?` to track when prize was awarded (or track in `UserChallengeStat`)
2. After successful entry submission, check if user's entry count >= `entryPrizeRequirement` && not already awarded
3. Award buzz + points immediately
4. Mark as awarded

---

## 8. Status Transition Enforcement

Current implementation allows any status transition at the application level. No database constraints enforce valid transitions.

Valid transitions should be:
```
Draft → Scheduled → Active → Judging → Completed
Draft → Cancelled (at any point before Active)
Active → Cancelled (emergency only)
```

@dev: application level is enough.

@ai: Confirmed. Will keep status transitions in application logic only. The router procedures will validate transitions before executing.

---

## Summary of Decisions

| # | Question | Decision | Action Required |
|---|----------|----------|-----------------|
| 1 | Multiple concurrent challenges | No limit | None |
| 2 | Winner image validation | Trust app logic | None |
| 3 | Draft in 30-day horizon | Scheduled only | Update auto-queue job |
| 4 | Collection creation | Auto-create | Update upsert procedure |
| 5 | Entry model validation | Use ImageResourceNew, support multiple versions | Schema change + validation update |
| 5b | NSFW level requirement | Add allowedNsfwLevel field | Schema change |
| 6 | Cancelled visibility | Hidden | Update visibility check |
| 7 | Entry prize timing | Immediate on threshold | Add prize distribution trigger |
| 8 | Status transitions | App-level | None |

---

## Implementation Checklist

- [x] Schema: Change `modelVersionId` to `modelVersionIds Int[]`
- [x] Schema: Add `allowedNsfwLevel Int @default(1)`
- [x] Schema: Add `entryPrizeRequirement Int @default(10)`
- [x] Schema: Make `collectionId` optional (auto-created)
- [x] Router: Auto-create Contest Mode collection in upsert
- [x] Router: Update visibility check to hide Cancelled
- [x] Job: Update auto-queue to query only Scheduled status
- [x] Job: Update validation to use `ANY()` for modelVersionIds + bitwise NSFW
- [x] Service: Add immediate entry prize distribution on threshold
- [x] Form: Add NSFW level selector for challenge creators → `ContentRatingSelect.tsx`
- [x] Form: Add entry prize requirement field
- [x] Form: Add model version multi-select component → `ModelVersionMultiSelect.tsx`
- [x] API: Add `getVersionsByIds` endpoint for edit mode support
