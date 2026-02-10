# TOS Violation Logging Overhaul

> **Phase 1 PR:** https://github.com/civitai/civitai/pull/2020
> **HackMD:** https://hackmd.io/@civitai/H1dEB0vPWl

## Summary for Moderator Team

**What's changing**: When a mod removes an image for a TOS violation, our analytics currently record *that* it was removed but not *why*. Over a third of our ~1.9M TOS removal records have no reason at all, and the rest use vague labels like "reported" or "manual" instead of the specific violation category.

**What we're doing about it**: We're adding a `violationType` field to our analytics that records the specific reason—minor, real-person likeness, graphic violence, CSAM, prohibited content, etc. These categories match what users already select when filing reports. For images that enter the mod queue via reports, the violation type will flow through automatically. No changes to the moderator workflow are needed in Phase 1.

**What mods will notice**: Nothing changes about how you block or remove images today. The system will just capture better data behind the scenes. In a later phase, the "Remove as TOS Violation" right-click option may gain a dropdown to pick the violation category, but that's optional and separate.

**Impact on existing moderation**: Zero. This is an analytics/logging change. It doesn't alter how images are blocked, what notifications users receive, or how appeals work. The mod queue, block actions, and restore actions all continue to function identically.

**Existing violation reasons** (what users select today when reporting a TOS violation):

1. Depiction of real-person likeness
2. Graphic violence
3. False impersonation
4. Deceptive content
5. Sale of illegal substances
6. Child abuse and exploitation
7. Photorealistic depiction of a minor
8. Prohibited concepts

These categories already exist in the report form. The problem is they get stored in PostgreSQL but never make it to our analytics. This proposal fixes that gap.

## Scope and Timeline

**Estimated effort**: Phase 1 (schema changes + all three backend code paths + consistent field population) touches 5 files with straightforward changes. The logic is simple—look up existing report data and pass it through to the analytics layer. An agent team could complete and test Phase 1 in a single session.

**Review surface**: This is a low-stakes change. It only affects what gets written to ClickHouse analytics rows. It does not change:

- How images are blocked or unblocked in PostgreSQL
- User-facing notifications or moderation UI
- Any API responses or frontend behavior
- Report processing or appeal flows

The review comes down to verifying five things:

1. The new ClickHouse columns are added correctly (two `ALTER TABLE` statements)
2. The `Tracker.images()` TypeScript interface accepts the new optional fields
3. Each of the three code paths populates `violationType` from the right source
4. Tags and resources are now populated in the two paths that were sending empty arrays
5. Moderator ID is passed as `userId` in all paths

No database migrations (PostgreSQL is untouched). No frontend changes in Phase 1. The ClickHouse columns are nullable with defaults, so if anything goes wrong, existing behavior is unaffected—we'd just get null values in the new columns, same as today.

**Backfill** (Phase 2) is a separate step that maps historical rows. It runs as an offline script and doesn't touch any live code paths.

## Problem

When a moderator removes an image for a TOS violation, we lose the reason. Three separate code paths write `DeleteTOS` rows to ClickHouse, each logging different fields at different levels of detail. The result: 38% of ~1.9M `DeleteTOS` rows have a null `tosReason`, and even when populated, the reason is vague ("reported", "manual", "other") rather than specific ("Photorealistic depiction of a minor").

Meanwhile, the data we need already exists. Users who report images select from eight violation categories. The moderation queue displays these details to moderators. But when a moderator clicks "Block", the specific violation category is discarded—ClickHouse receives only the review queue bucket (e.g., `reported`) or a hardcoded string (`manual`).

## Current State

### Three code paths, three behaviors

| Path | File | `tosReason` | tags | resources | moderator ID |
|------|------|-------------|------|-----------|-------------|
| Mod queue "Block" | `image.controller.ts:91` | `needsReview` value (`minor`, `poi`, `reported`, etc.) | empty `[]` | empty `[]` | not logged |
| Context menu "Remove as TOS Violation" | `image.controller.ts:226` | hardcoded `manual` | populated | populated | not logged |
| Webhook `/api/mod/remove-images` | `remove-images.ts:24` | freeform `reason` param | empty `[]` | empty `[]` | available but not logged |

### What users report (stored in `Report.details` as JSON)

The `TosViolationForm` collects a `violation` field from this list:

1. Depiction of real-person likeness
2. Graphic violence
3. False impersonation
4. Deceptive content
5. Sale of illegal substances
6. Child abuse and exploitation
7. Photorealistic depiction of a minor
8. Prohibited concepts

Plus an optional `comment` for real-person reports. This data reaches PostgreSQL in the `Report` table but never reaches ClickHouse.

### What the ClickHouse `images` table stores today

| Column | Type | Notes |
|--------|------|-------|
| `type` | Enum8 (Create, Delete, DeleteTOS, Tags, Resources, Restore, Play) | |
| `imageId` | Int32 | |
| `ownerId` | Int32 | image uploader |
| `userId` | Int32 | intended for actor/moderator, often `0` |
| `nsfw` | Enum8 (None, Soft, Mature, X, Blocked) | |
| `tags` | Array(String) | often empty |
| `resources` | Array(Int32) | often empty |
| `tosReason` | LowCardinality(Nullable(String)) | coarse or null |
| `mediaType` | LowCardinality(String) | |
| `time` | DateTime | |

### `tosReason` distribution

| value | count | % of total |
|-------|-------|-----------|
| null | 728K | 38% |
| `reported` | 446K | 23% |
| `minor` | 299K | 16% |
| `poi` | 170K | 9% |
| `other` | 95K | 5% |
| `tag` | 90K | 5% |
| `manual` | 52K | 3% |
| `newUser` | 39K | 2% |
| `blocked` | 9K | <1% |
| `csam` | 691 | <1% |

## Proposal

### 1. Define a unified violation taxonomy

Combine the review queue categories (`needsReview` values) with the user-facing report categories into one canonical set. This set represents *why* an image was removed:

```
minor              — flagged as depicting a minor
poi                — flagged as person-of-interest / real person likeness
csam               — child abuse / exploitation
graphic_violence   — graphic violence
false_impersonation — false impersonation
deceptive_content  — deceptive content
illegal_substances — sale of illegal substances
prohibited_concept — prohibited concepts (bestiality, etc.)
tag_violation      — violating tag detected by scanner
new_user_review    — new user content blocked on review
blocked_hash       — matched a blocked perceptual hash
other              — catch-all / unclassified
```

@dev: The user-facing report options map naturally into this list. The scanner-originated categories (`tag`, `newUser`, `blocked`) also fold in. Should we keep these as a TypeScript enum in `server/common/enums.ts`, or as a shared constant that both the report form and ClickHouse logging reference? I'd recommend a shared constant so the report form's radio options derive from the same source of truth.

### 2. Add two columns to the ClickHouse `images` table

```sql
ALTER TABLE images ADD COLUMN violationType LowCardinality(Nullable(String)) AFTER tosReason;
ALTER TABLE images ADD COLUMN violationDetails String DEFAULT '' AFTER violationType;
```

- **`violationType`**: one of the canonical values above. Replaces the role `tosReason` plays today with a well-defined vocabulary.
- **`violationDetails`**: free-text context (the reporter's comment, the matched tag name, the scanner rule ID, etc.).

We keep `tosReason` as-is for backward compatibility with existing queries and dashboards. New code writes both `tosReason` (for continuity) and `violationType` + `violationDetails` (for granularity).

@dev: Alternatively, we could repurpose `tosReason` and backfill. That's cleaner long-term but requires migrating every downstream query. Your call on which tradeoff you prefer.

### 3. Update the Tracker interface

In `src/server/clickhouse/client.ts`, extend the `images()` method's value type:

```typescript
public images(
  values: {
    type: ImageActivityType;
    imageId: number;
    nsfw: NsfwLevelDeprecated;
    tags: string[];
    ownerId: number;
    tosReason?: string;           // keep for backward compat
    violationType?: string;       // new: canonical violation category
    violationDetails?: string;    // new: free-text context
    resources?: number[];
    userId?: number;
  }[]
)
```

### 4. Fix each code path

#### A. Mod queue "Block" (`moderateImageHandler`)

**Current**: logs `needsReview` as `tosReason`, empty tags/resources, no moderator.

**Change**: Before logging, look up reports for the blocked images and extract the violation category. Populate tags and resources. Pass the moderator's user ID.

```typescript
// Pseudocode for the key change:
const reportDetails = await getReportDetailsForImages(imageIds);

images.map(({ id, userId, nsfwLevel, needsReview }) => ({
  type: 'DeleteTOS',
  imageId: id,
  nsfw: getNsfwLevelDeprecatedReverseMapping(nsfwLevel),
  tags: imageTags[id] ?? [],
  resources: imageResources[id] ?? [],
  tosReason: needsReview ?? 'other',            // unchanged
  violationType: mapToViolationType(needsReview, reportDetails[id]),
  violationDetails: reportDetails[id]?.comment ?? '',
  ownerId: userId,
  userId: ctx.user.id,                           // moderator
}))
```

The `mapToViolationType` function resolves the canonical type:
- If a report exists with `reason: 'TOSViolation'`, use `details.violation` mapped to the canonical key.
- If `needsReview` is `minor`, `poi`, `csam`, etc., map directly.
- Otherwise, fall back to `other`.

@dev: The report lookup adds a DB query per block action. For the moderation queue, images are processed in batches via `Limiter()`, so this should be fine. For bulk webhook calls (which can block thousands of images), we may want to make this optional or batch the report lookup. Thoughts?

#### B. Context menu "Remove as TOS Violation" (`setTosViolationHandler`)

**Current**: hardcodes `tosReason: 'manual'`, does populate tags/resources.

**Change**: Look up the image's pending reports (same as above) and extract the violation category. If no report exists (pure manual action), set `violationType: 'other'` and rely on a future UI enhancement (see step 5) to collect the reason.

Also pass `userId: ctx.user.id` for the moderator.

#### C. Webhook `/api/mod/remove-images`

**Current**: passes freeform `reason` string, empty tags/resources, ignores `moderatorId`.

**Change**: Extend the webhook schema to accept `violationType` and `violationDetails`. Pass `moderatorId` as `userId`. Optionally fetch tags/resources (this is the bulk path, so make it opt-in).

```typescript
const schema = z.object({
  imageIds: z.array(z.number()).optional(),
  userId: z.number().optional(),
  moderatorId: z.number().optional(),
  reason: z.string().optional(),
  violationType: z.string().optional(),     // new
  violationDetails: z.string().optional(),  // new
});
```

### 5. (Future) Add violation reason to the moderator UI

The "Remove as TOS Violation" context menu currently shows a bare confirmation dialog. A stronger version would include a dropdown of violation categories (derived from the shared constant) and an optional comment field. This gives moderators a single click more of friction in exchange for a complete audit trail.

@dev: This is the only part that touches the frontend. If you want to keep this proposal backend-only for now, we can defer step 5 and still get most of the value—the mod queue "Block" action will pull violation types from existing reports, and the webhook will accept them from callers. The context menu path would just default to `other` until the UI catches up.

### 6. Backfill historical data

For the 446K rows where `tosReason = 'reported'`, we can backfill `violationType` by joining ClickHouse `images` rows against PostgreSQL `Report` + `ImageReport` tables on `imageId`. The report's `details->>'violation'` maps to our canonical types.

For `tosReason IN ('minor', 'poi', 'csam', 'tag', 'newUser', 'blocked')`, the mapping is direct—these *are* the violation type.

For the 728K null rows and 95K `other` rows, we have no data to recover. They remain `violationType = NULL`.

```sql
-- Example backfill for direct mappings (run with --writable):
ALTER TABLE images
  UPDATE violationType = tosReason
  WHERE type = 'DeleteTOS'
    AND tosReason IN ('minor', 'poi', 'csam', 'tag', 'newUser', 'blocked');
```

The report-based backfill requires an external script that reads from PostgreSQL and writes to ClickHouse, since we can't join across the two databases in a single query.

## Migration Path

**Phase 1 — Schema + backward-compatible logging (this PR)**
1. Add `violationType` and `violationDetails` columns to ClickHouse.
2. Add fields to the `Tracker.images()` interface.
3. Define the canonical violation type constant.
4. Update all three code paths to populate the new fields alongside existing `tosReason`.
5. Populate `tags`, `resources`, and `userId` consistently in paths A and C.

**Phase 2 — Backfill**
1. Direct-mapping backfill via ClickHouse `ALTER TABLE UPDATE`.
2. Report-join backfill via script.

**Phase 3 — Frontend (optional, separate PR)**
1. Add violation category dropdown to the "Remove as TOS Violation" dialog.
2. Pass selected category through to `setTosViolationHandler`.

**Phase 4 — Deprecate `tosReason` (optional, later)**
1. Migrate downstream queries and dashboards to use `violationType`.
2. Stop writing `tosReason`.
3. Drop column when ready.

## Files to change

| File | Change |
|------|--------|
| `src/server/common/enums.ts` | Add `ViolationType` constant |
| `src/server/clickhouse/client.ts` | Extend `Tracker.images()` value type |
| `src/server/controllers/image.controller.ts` | Update `moderateImageHandler` and `setTosViolationHandler` |
| `src/pages/api/mod/remove-images.ts` | Extend schema, populate new fields |
| `src/server/services/image.service.ts` | Add helper to fetch report violation details for image IDs |


---

```js
const tosReasons =
    [
     {
      label: "Depicting Real People",
      value: "Depicting real people is not allowed.",
      reason: "",
      violationType: "realPerson",
      strikeWeight: 0
     },
     {
      label: "Depicting Real People in mature context",
      value: "Depicting real people in mature context is not allowed.",
      reason: "",
      violationType: "realPersonNsfw",
      strikeWeight: 1
     },
    {
      label: "Realistic minor",
      value: "Realistic images of minors is not allowed.",
      reason: "",
      violationType: "realisticMinor",
      strikeWeight: 0
    },
    {
      label: "Realistic Minor displayed in mature context",
      value: "Realistic Minors displayed in mature context is not allowed.",
      reason: "",
      violationType: "realisticMinorNsfw",
      strikeWeight: '1-3'
      /*
    There'll always be borderline cases where you remove something
    to be on the safer side, but it might not be enough for an instant
    ban or CSAM report.

    Maybe the age determined by the age scanner can help determine
    the punishment.

    If the AI says they're an adult but it still gets removed,
    is that 1 strike?

    With the option of banning them anyway afterwards if you disagree.
  */

     },
     {
      label: "Animiated Minor displayed in mature context",
      value: "Animated Minors displayed in mature context is not allowed.",
      reason: "",
      violationType: "animatedMinorNsfw",
      strikeWeight: '0-3'
      /*
    There'll always be borderline cases where you remove something
    to be on the safer side, but it might not be enough for an instant
    ban or CSAM report.

    Maybe the age determined by the age scanner can help determine
    the punishment.
  */

     },
     {
      label: "NSFW potential minor in a school environment",
      value: "NSFW potential minors in a school environment is not allowed",
      reason: "",
      violationType: "schoolNsfw",
      strikeWeight: 0
     },
    {
      label: "Bestiality",
      value: "Bestiality is not allowed.",
      reason: "",
      violationType: "bestiality",
      strikeWeight: '0-3'
    /*
    Actual realistic bestiality is currently instant ban(3 strikes).

    Less severe cartoon stuff is usually 0 or 1.
  */
    },
    {
      label: "Rape/Forced Sex",
      value: "Depicting rape and domestic abuse is not allowed."
      reason: "",
      violationType: "sexualViolence",
      strikeWeight: '0-3'
    /*
    Depends on severity, can be hard to judge in still images
  */
    },
    {
      label: "Mind altered NSFW",
      value: "Mind altered NSFW is not allowed"
      reason: "",
      violationType: "mindAlteredNsfw",
      strikeWeight: '0'
    },
    {
      label: "Scat/Fecal matter",
      value: "Fecal matter, gaseous emission, object or lifeform being ejected from an anus is not allowed",
      reason: "",
      violationType: "fecalMatter",
      strikeWeight: 0
    },
     {
      label: "Graphic Violence/Gore",
      value: "Graphic Violence and/or gore is not allowed",
      reason: "",
      violationType: "gore",
      strikeWeight: '0-1'
    },
    {
      label: "Diapers",
      value: "Diapers are not allowed",
      reason: "",
      violationType: "diaper",
      strikeWeight: 0
    },
    {
      label: "Anorexia",
      value: "Anorexia is not allowed",
      reason: "",
      violationType: "anorexia",
      strikeWeight: 0
    },
    {
      label: "Prohibited bodily fluids",
      value: "Certain bodily fluids are not allowed",
      reason: "",
      violationType: "bodilyFluids",
      strikeWeight: 0
    },
    {
      label: "Incest",
      value: "Incest is not allowed",
      reason: "",
      violationType: "incest",
      strikeWeight: 0
    },
    {
      label: "Hate Speech/Extreme political",
      value: "Hate Speech/Extreme political content is not allowed",
      reason: "",
      violationType: "hate",
      strikeWeight: 1
    },
    {
      label: "Non AI content",
      value: "CivitAI is for posting AI-generated images or videos, go here to start generating some https://civitai.com/generate",
      reason: "",
      violationType: "non-ai",
      strikeWeight: 0
    },
    {
      label: "Spam",
      value: "Spam",
      reason: "",
      violationType: "spam",
      strikeWeight: 1
    },
    {
      label: "Other",
      value: {{textArea1.value}}
    }
  ]

return tosReasons;
```

```
cc -r 6831430c-3aa1-41ce-9406-4a0e153b07bd
```
