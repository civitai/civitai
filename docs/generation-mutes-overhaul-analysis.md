# Generation Mutes Overhaul — Task Analysis

**ClickUp Task:** [868h68pea](https://app.clickup.com/t/868h68pea)
**Status:** To Do
**Date:** 2026-01-26

---

## Task Summary

Overhaul the generation mute system to:
1. Track bad prompts and what specifically triggered the block
2. Record a `UserRestriction` DB record when a user is muted, capturing the prompts that caused it
3. Show muted users an informational UI (no more support tickets) — mutes are automatically reviewed by mods within 2 business days
4. Build on-site moderator UI to review bans, prompts, and take action
5. Allow moderators to mark triggers as benign (false positive reduction)
6. Generation mute appeals will **not** cost buzz

---

## How Muting Works Today

### Detection Flow (`auditPromptServer` in `promptAuditing.ts`)

1. **Regex audit** (`auditPrompt` in `audit.ts`) — runs checks in this order, returns on first hit:
   - **Minor age** — fuzzy-matches ages 1-17 with typo variants → `blockedFor: ["17 year old"]`
   - **POI (celebrity)** — matches against `words-poi.json` → `blockedFor: ["Prompt cannot include celebrity names"]`
   - **Inappropriate combos** — young words + NSFW, harmful regex patterns → `blockedFor: ["Inappropriate minor content"]`
   - **NSFW blocklist** — matches words from `blocklist-nsfw.json` → `blockedFor: ["the_word"]`
   - **Profanity** (green domain only) — obscenity library with leetspeak → `blockedFor: ["word1", "word2"]`

2. **External moderation** (`extModeration.moderatePrompt`) — OpenAI `omni-moderation-latest`:
   - Pre-processes prompt to remove known false positive triggers (e.g. `\d*girl` → `woman`)
   - Returns flagged category names → `blockedFor: ["sexual/minors", ...]`

3. **Recording** — `track.prohibitedRequest()` writes to ClickHouse `prohibitedRequests`:
   - Fields: `time`, `userId`, `prompt`, `negativePrompt`, `source` (Regex|External), `ip`, `userAgent`, `deviceId`
   - **NOT stored:** what triggered the block, category, matched word, imageId

4. **Escalation** — Redis counter via `blockedPromptLimiter` tracks count in 24h window:
   - Count > 3 → warning message
   - Count > 5 → "sent for review" message
   - Count > 8 → muted message
   - Auto-mute in `reportProhibitedRequest` when ClickHouse count >= `muted - notified` (3)

5. **Mute applied** — `User.muted = true` in PostgreSQL, DB trigger sets `mutedAt`, session refreshed

### What's Missing

- **No structured trigger data** — `blockedFor` is lossy. POI blocks say "celebrity names" but not *which* name. Minor content blocks don't say which word matched.
- **No PostgreSQL mute record** — mute is just a boolean on User. No history of what caused it.
- **No appeal path** — user sees a dead-end lock screen
- **No false positive feedback loop** — 60% of mutes are false positives with no way to learn from them

---

## Proposed Design

### 1. Enrich Trigger Data

The current `auditPrompt` returns `{ blockedFor: string[], success: boolean }` where `blockedFor` is a flat list of human-readable strings. For the moderator review and false-positive system, we need structured trigger data on the server side.

Proposed: add a parallel return path in `auditPromptServer` that captures structured triggers:

```typescript
interface PromptTrigger {
  category: 'minor_age' | 'poi' | 'inappropriate_minor' | 'inappropriate_poi'
           | 'nsfw_blocklist' | 'profanity' | 'harmful_combo' | 'external';
  source: 'regex' | 'external';
  message: string;       // The human-readable blockedFor string
  matchedWord?: string;  // The specific word/pattern that matched (when available)
}
```

This means modifying the audit functions to return the matched word alongside the category. For example, `includesPoi` currently returns `boolean` — it would need to return the matched name. Similarly, `includesInappropriate` would return which young/POI word triggered it.

### 2. UserRestriction Record

Instead of reusing the `Appeal` table (which has entity-keying complications), create a purpose-built `UserRestriction` model:

```prisma
model UserRestriction {
  id              Int           @id @default(autoincrement())
  userId          Int
  user            User          @relation(fields: [userId], references: [id])
  type            String        @default("generation") // extensible for future ban types
  status          String        @default("pending")    // pending | upheld | overturned
  triggers        Json          // Array of PromptTrigger objects with prompt text
  createdAt       DateTime      @default(now())
  updatedAt       DateTime      @updatedAt
  resolvedAt      DateTime?
  resolvedBy      Int?
  resolvedMessage String?
  userMessage     String?       // Optional context from user ("Provide Context" button)
  userMessageAt   DateTime?

  @@index([userId])
  @@index([status])
  @@index([type, status])
}
```

The `triggers` JSON column stores an array of the prohibited prompts with their structured trigger data:
```json
[
  {
    "prompt": "the full prompt text",
    "negativePrompt": "...",
    "source": "regex",
    "category": "nsfw_blocklist",
    "matchedWord": "specific_word",
    "message": "specific_word",
    "imageId": null,
    "time": "2026-01-26T..."
  }
]
```

**When created:** In `reportProhibitedRequest`, after auto-muting, query the recent ClickHouse `prohibitedRequests` for that user (last 24h) and create the `UserRestriction` with trigger data. Since we're enriching the ClickHouse records with trigger info (see section 1), we can pull the full picture.

**Repeat mutes:** A user can have multiple `UserRestriction` records over time. Each auto-mute creates a new one. No unique constraint issues — a user who was previously overturned and later muted again gets a fresh `UserRestriction`.

### 3. Muted User Experience

- Replace the lock screen in `src/pages/generate/index.tsx` with an informational UI
- All mutes are automatically queued for moderator review within 2 business days — no user action required
- Show the user their current `UserRestriction` status:
  - **Pending review**: "Your account has been restricted and is being reviewed by our moderation team. You'll receive a notification with the decision within 2 business days. You do not need to contact support." + optional "Provide Context" button to submit a message.
  - **Upheld**: "Your account has been reviewed and the restriction has been upheld."
  - **Overturned**: (user is unmuted, doesn't see this screen)

### 4. Moderator UI

New page at `/moderator/generation-restrictions` showing:
- List of `UserRestriction` records with status filter (pending, upheld)
- Click into a ban → see the triggers/prompts, user's optional context message
- Blocked prompt history from ClickHouse `prohibitedRequests`
- Action buttons: **Unmute** (overturns), **Stay Muted** (upholds), **Ban** (escalates)
- Each action sends a notification to the user
- "Mark as Benign" button per trigger → adds to `PromptAllowlist`

### 5. False Positive Allowlist

This is the key mechanism for reducing the 60% false positive rate.

#### The Problem in Detail

The regex audit system has several layers that can produce false positives:

| Check | What triggers | Example false positive |
|-------|--------------|----------------------|
| NSFW blocklist (`blocklist-nsfw.json`) | Exact word match with leetspeak variants | A word that has innocent uses in context |
| POI names (`words-poi.json`) | Celebrity name match | Common name that happens to be a celebrity |
| Young words (`words-young.json`) | Young-related nouns in NSFW context | Non-sexual use of "school" in NSFW prompt |
| Harmful combinations (`harmful-combinations.ts`) | Regex patterns for dangerous combos | Pattern too broad, catches innocent phrasing |
| External moderation | OpenAI category scores > threshold | Model over-flags certain art styles |

The external moderation service already has a rudimentary false-positive system (hardcoded replacements in `moderation.ts`), but it's static and limited to 5 patterns.

#### Proposed: `PromptAllowlist` Table

```prisma
model PromptAllowlist {
  id          Int      @id @default(autoincrement())
  trigger     String   // The word/phrase to allow (e.g., "schoolgirl" or "emma watson")
  category    String   // Which check: nsfw_blocklist | poi | young_noun | harmful_combo
  addedBy     Int      // Moderator who approved it
  addedByUser User     @relation(fields: [addedBy], references: [id])
  reason      String?  // Why this was approved
  userRestrictionId   Int?     // Optional: link to the UserRestriction that prompted this
  createdAt   DateTime @default(now())

  @@unique([trigger, category])
  @@index([category])
}
```

#### Runtime Integration

The allowlist does **not** modify the regex patterns. Instead, it acts as a post-filter:

1. `auditPrompt` runs as normal and returns `{ blockedFor, success: false }`
2. **New step in `auditPromptServer`**: Load the allowlist (cached in Redis, refreshed every ~5min)
3. For each trigger in `blockedFor`, check if the matched word + category is in the allowlist
4. If all triggers are allowlisted → treat as success, don't count toward mute threshold
5. If some remain → proceed with the remaining triggers

```typescript
// Pseudocode for auditPromptServer
const { blockedFor, triggers, success } = auditPromptEnriched(prompt, negativePrompt);
if (!success) {
  const allowlist = await getCachedAllowlist(); // Redis-cached Set<"category:word">
  const remaining = triggers.filter(t =>
    !t.matchedWord || !allowlist.has(`${t.category}:${t.matchedWord}`)
  );
  if (remaining.length === 0) {
    // All triggers were allowlisted — don't count this as a violation
    return;
  }
  // Continue with remaining triggers...
}
```

#### Why Post-Filter Instead of Modifying Regexes

Modifying the blocklist JSON files or regex patterns dynamically is risky:
- Regex modification is fragile — one bad pattern breaks all auditing
- Removing a word from `blocklist-nsfw.json` requires a code deployment
- No audit trail of what was changed and why
- Can't easily revert if a "false positive" turns out to be real

The post-filter approach is:
- **Safe** — the base detection stays intact, the allowlist only exempts specific known-good cases
- **Auditable** — every allowlist entry has a moderator, reason, and timestamp
- **Reversible** — delete the entry to re-enable blocking
- **Immediate** — no deployment needed, just a DB insert + cache bust
- **Contextual** — scoped by category, so allowing a word for `poi` doesn't allow it for `nsfw_blocklist`

#### Moderator Workflow

When reviewing a `UserRestriction`, the moderator sees each trigger with its category and matched word. For false positives:

1. Moderator clicks "Mark as Benign" on a specific trigger
2. This creates a `PromptAllowlist` entry for that `(trigger, category)` pair
3. Redis cache is invalidated
4. Future prompts containing that word/pattern in that category won't count toward mute threshold

Over time, this builds an allowlist that systematically reduces false positives without touching the regex code.

#### Handling External Moderation False Positives

The external moderation service (OpenAI) returns category-level flags, not specific words. False positives here are harder to handle at the word level. Options:
- Add prompt text patterns to the existing `removeFalsePositiveTriggers` in `moderation.ts` (requires deployment)
- Raise the `EXTERNAL_MODERATION_THRESHOLD` for specific categories
- Add category-level overrides to the allowlist (e.g., allow `external:sexual` for specific prompt patterns)

@dev: External moderation false positives may need a different strategy. For now, the allowlist focuses on regex-based blocks which are the easier win.

---

## Enriching `auditPrompt` — What Needs to Change

The core issue is that `auditPrompt` is lossy. Here's what each check returns today vs. what we need:

| Check | Today's `blockedFor` | Needed `matchedWord` |
|-------|---------------------|---------------------|
| Minor age | `"17 year old"` | `"17"` (the age number) |
| POI | `"Prompt cannot include celebrity names"` | `"emma watson"` (the matched name) |
| Inappropriate minor | `"Inappropriate minor content"` | The young word that matched (e.g., `"schoolgirl"`) |
| Inappropriate POI | `"Inappropriate real person content"` | The POI name that matched |
| NSFW blocklist | `"the_word"` | Same — already has the word |
| Profanity | `["word1", "word2"]` | Same — already has the words |
| External | `["sexual/minors"]` | Category name (no word-level data available) |

The functions that need modification:
- `includesPoi()` → return the matched name, not just boolean
- `includesMinor()` → return the matched young word
- `includesInappropriate()` → return both the category and matched word
- `includesHarmfulCombinations()` → return which pattern matched

These are all in [audit.ts](src/utils/metadata/audit.ts). The changes are backwards-compatible: we can add an optional `enriched` mode or create parallel `*Enriched` functions for server-side use.

---

## Updated Implementation Order

1. **Enrich trigger data** — Modify audit functions to return structured triggers server-side
2. **Add `imageId` to ClickHouse** — Extend `prohibitedRequests` table and `track.prohibitedRequest()`
3. **Create `UserRestriction` model** — Prisma schema + migration, create records on auto-mute
4. **`PromptAllowlist` model** — Prisma schema + migration, Redis caching, post-filter in `auditPromptServer`
5. **Muted user UX** — Replace lock screen with informational UI + optional "Provide Context" message
6. **Notifications** — New notification types for mute decisions (unmuted, upheld, banned)
7. **Moderator UI** — Ban list page, prompt viewer, action buttons, "mark as benign" workflow

---

## Open Questions

### Q1: Non-blocked generation history
The mod UI should show "some of their non-blocked history." Where does non-blocked generation history live? Is it queryable from ClickHouse or the orchestrator?

@dev: What's the source for non-blocked generation history, and how much should we show?
@dev - do we really need non-blocked generation history?
@ai: Agreed, we can skip non-blocked history. The mod UI will just show blocked prompts from ClickHouse `prohibitedRequests`. Simpler and covers the actual need — seeing what triggered the mute.

### Q2: Session refresh on notification click
When the mod unmutes, `refreshSession()` already runs server-side. The "you've been restored" notification click would just need to trigger a client-side page reload / re-fetch of session data.

@dev: Confirming that a client-side router refresh is sufficient here?
@dev - a client side router refresh should be sufficient. In theory, they shouldn't even need a client side refresh, as any subsequent trpc requests should include a header that triggers a client side session refresh.
@ai: Got it. The server-side `refreshSession()` call on unmute is sufficient — the next tRPC request will pick up the new session state via headers. No special notification click handler needed. Resolved.

### Q3: Mute state messaging
Should the UI show distinct states?
- **Pre-review:** "Your account is under review..."
- **Appealed:** "Your appeal is being reviewed..."
- **Upheld:** "Your appeal was reviewed and the restriction was upheld."

@dev: What distinct states/messages should the UI show?
@dev - One thing to note is that mutes will be automatically reviewed by the moderator team within 2 business days. This means that users won't be manually "appealing" their bans that occur from submitting blocked prompts.
@ai: This simplifies the flow significantly. The user doesn't initiate an appeal — all mutes are automatically queued for moderator review. The "Appeal Restriction Here" button from the original task is really about explaining the process and optionally letting the user provide context, not gating the review.

Revised user-facing states:
- **Pending review**: "Your account has been restricted and is being reviewed by our moderation team. You'll receive a notification with the decision within 2 business days. You do not need to contact support." + optional "Provide Context" button to submit a message.
- **Upheld**: "Your account has been reviewed and the restriction has been upheld."
- **Overturned**: (user is unmuted, doesn't see this screen)

This also simplifies the `UserRestriction.status` field — no "appealed" state needed. Just `pending → upheld | overturned`.

### Q4: External moderation false positives
The allowlist system works well for regex-based blocks (word-level granularity). External moderation only provides category-level results. Should we handle external false positives separately, or is the regex allowlist sufficient for the 60% problem?

@dev: Is the false positive problem primarily in the regex system or the external moderation, or both?
@dev - the regex allow list is probably sufficient for both.
@ai: Sounds good. We'll focus the `PromptAllowlist` on regex-based triggers. The external moderation already has its own `removeFalsePositiveTriggers` pre-processing in `moderation.ts` which can be extended separately if needed later. Resolved.

---

## Existing Infrastructure We Can Leverage

| Component | Location | Reuse Strategy |
|-----------|----------|----------------|
| Prompt auditing + auto-mute | `src/server/services/orchestrator/promptAuditing.ts` | Extend with enriched triggers, imageId, UserRestriction creation |
| Audit functions | `src/utils/metadata/audit.ts` | Add enriched return paths for server-side use |
| ClickHouse prohibited requests | `containers/clickhouse/docker-init/init.sh` | Add `imageId`, `category`, `matchedWord` columns |
| Tracker | `src/server/clickhouse/client.ts` | Extend `prohibitedRequest()` signature |
| Session refresh | `src/server/auth/session-invalidation.ts` | Already works, wire to notification click |
| Moderator endpoints | `src/server/routers/user.router.ts` (toggleMute, toggleBan) | Reuse for mod actions |
| Notification system | `src/server/notifications/` | Add new notification categories |
| Confirm mutes job | `src/server/jobs/confirm-mutes.ts` | May need updates for new flow |
| Generate page UI | `src/pages/generate/index.tsx` | Replace lock screen with appeal UI |
| External moderation | `src/server/integrations/moderation.ts` | Existing false-positive pre-processing to extend |
