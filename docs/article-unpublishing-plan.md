# Article Unpublishing Feature Implementation Plan

## Overview
This document outlines the plan to add unpublishing functionality for Articles, mirroring the existing system used for Models. This will enable moderators to unpublish ToS-violating articles while maintaining history and automatically notifying content owners.

## Current State Analysis

### Models (Reference Implementation)
Models currently support:
- ✅ Two unpublished states: `Unpublished` (user-initiated) and `UnpublishedViolation` (moderation action)
- ✅ 20+ predefined unpublish reasons with notification messages
- ✅ Custom message support for "other" reasons
- ✅ Metadata storage for unpublish history (reason, timestamp, moderator ID)
- ✅ Automatic notification system for content owners
- ✅ Visibility rules: unpublished content visible to owner + moderators only
- ✅ Permission middleware enforcing owner/moderator access
- ✅ Search index updates (removal from public listings)

**Key Files:**
- Status enum: `src/shared/utils/prisma/enums.ts:130-141`
- Router: `src/server/routers/model.router.ts:173-176`
- Service: `src/server/services/model.service.ts:1680-1760`
- Notifications: `src/server/notifications/unpublish.notifications.ts:1-124`
- Reasons: `src/server/common/moderation-helpers.ts:1-89`

### Articles (Current State)
Articles currently have:
- ⚠️ Basic `Unpublished` status only (no `UnpublishedViolation`)
- ⚠️ Simple unpublish endpoint with no reason support
- ⚠️ No permission middleware (missing owner/moderator checks in route)
- ⚠️ No notification system
- ⚠️ No metadata storage for unpublish details
- ⚠️ Basic visibility rules exist but don't account for violation state
- ✅ `metadata` JSON field in schema (ready to store unpublish data)
- ✅ `tosViolation` boolean field in schema

**Key Files:**
- Status enum: `src/shared/utils/prisma/enums.ts:502-508` (only 3 statuses)
- Router: `src/server/routers/article.router.ts:60-63`
- Service: `src/server/services/article.service.ts:710-739`

## Implementation Plan

### Phase 1: Database & Schema Updates

#### 1.1 Update Article Status Enum
**File:** `src/shared/utils/prisma/enums.ts`

Add `UnpublishedViolation` status to `ArticleStatus`:

```typescript
export const ArticleStatus = {
  Draft: 'Draft',
  Published: 'Published',
  Unpublished: 'Unpublished',
  UnpublishedViolation: 'UnpublishedViolation',  // NEW
} as const;
```

**Why:** Distinguishes between user-initiated unpublishing and moderation actions for ToS violations.

#### 1.2 Create Article Unpublish Schema
**File:** `src/server/schema/article.schema.ts`

Add new schema for unpublish operations:

```typescript
export const unpublishArticleSchema = z.object({
  id: z.number(),
  reason: z.custom<UnpublishReason>((x) => UnpublishReasons.includes(x as string)).optional(),
  customMessage: z.string().optional(),
});

export type UnpublishArticleSchema = z.infer<typeof unpublishArticleSchema>;
```

**Why:** Enables moderators to specify structured reasons and custom messages when unpublishing.

#### 1.3 Define Article Metadata Type
**File:** `src/server/services/article.service.ts` (or types file)

```typescript
interface ArticleMetadata {
  unpublishedReason?: UnpublishReason;
  customMessage?: string;
  unpublishedAt?: string;
  unpublishedBy?: number;
  // ... other existing metadata fields
}
```

**Why:** TypeScript type safety for metadata JSON field.

### Phase 2: API & Permissions

#### 2.1 Create Permission Middleware
**File:** `src/server/routers/article.router.ts`

Add `isOwnerOrModerator` middleware (mirroring model.router.ts):

```typescript
const isOwnerOrModerator = middleware(async ({ ctx, next, input = {} }) => {
  if (!ctx.user) throw throwAuthorizationError();

  const { id } = input as { id: number };
  const userId = ctx.user.id;
  const isModerator = ctx?.user?.isModerator;

  if (!isModerator && !!id) {
    const ownerId = (
      await dbRead.article.findUnique({
        where: { id },
        select: { userId: true }
      })
    )?.userId;

    if (ownerId !== userId) throw throwAuthorizationError();
  }

  return next({
    ctx: { user: ctx.user },
  });
});
```

**Why:** Ensures only article owners and moderators can unpublish content.

#### 2.2 Update Router Endpoint
**File:** `src/server/routers/article.router.ts`

Replace current unpublish route:

```typescript
// OLD:
unpublish: guardedProcedure
  .input(getByIdSchema)
  .use(isFlagProtected('articles'))
  .mutation(unpublishArticleHandler),

// NEW:
unpublish: protectedProcedure
  .input(unpublishArticleSchema)
  .use(isFlagProtected('articles'))
  .use(isOwnerOrModerator)
  .mutation(unpublishArticleHandler),
```

**Changes:**
- `guardedProcedure` → `protectedProcedure` (requires authentication)
- `getByIdSchema` → `unpublishArticleSchema` (adds reason/message support)
- Added `.use(isOwnerOrModerator)` middleware

### Phase 3: Business Logic

#### 3.1 Update Controller
**File:** `src/server/controllers/article.controller.ts`

Enhance `unpublishArticleHandler`:

```typescript
export const unpublishArticleHandler = async ({
  input,
  ctx,
}: {
  input: UnpublishArticleSchema;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { id } = input;

    // Fetch current metadata
    const article = await dbRead.article.findUnique({
      where: { id },
      select: { metadata: true, nsfw: true },
    });

    if (!article) throw throwNotFoundError(`No article with id ${input.id}`);

    const metadata = (article.metadata as ArticleMetadata | null) || {};

    // Call service with enhanced parameters
    const updatedArticle = await unpublishArticleById({
      ...input,
      metadata,
      userId: ctx.user.id,
      isModerator: ctx.user.isModerator,
    });

    // Optional: Track analytics event (if article tracking exists)
    if (ctx.track.articleEvent) {
      await ctx.track.articleEvent({
        type: 'Unpublish',
        articleId: id,
        nsfw: article.nsfw,
      });
    }

    return updatedArticle;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};
```

**Why:** Prepares metadata and delegates to service layer, following model implementation pattern.

#### 3.2 Enhance Service Layer
**File:** `src/server/services/article.service.ts`

Replace `unpublishArticleById` function:

```typescript
export async function unpublishArticleById({
  id,
  reason,
  customMessage,
  metadata,
  userId,
  isModerator,
}: UnpublishArticleSchema & {
  metadata?: ArticleMetadata;
  userId: number;
  isModerator?: boolean;
}) {
  // Fetch article
  const article = await dbRead.article.findUnique({
    where: { id },
    select: { userId: true, publishedAt: true, status: true },
  });

  if (!article) throw throwNotFoundError(`No article with id ${id}`);

  // Permission check (defensive, already checked in middleware)
  const isOwner = article.userId === userId || isModerator;
  if (!isOwner) throw throwAuthorizationError('You cannot perform this action');

  // State validation
  if (!article.publishedAt || article.status !== ArticleStatus.Published) {
    throw throwBadRequestError('Article is not published');
  }

  // Atomic update with transaction
  const updated = await dbWrite.$transaction(
    async (tx) => {
      const unpublishedAt = new Date().toISOString();

      // Build updated metadata
      const updatedMetadata = {
        ...metadata,
        ...(reason
          ? {
              unpublishedReason: reason,
              customMessage,
            }
          : {}),
        unpublishedAt,
        unpublishedBy: userId,
      };

      // Update article status and metadata
      return await tx.article.update({
        where: { id },
        data: {
          status: reason
            ? ArticleStatus.UnpublishedViolation
            : ArticleStatus.Unpublished,
          metadata: updatedMetadata,
        },
      });
    },
    { timeout: 30000, maxWait: 10000 }
  );

  // Update search index (remove from public search)
  await articlesSearchIndex.queueUpdate([
    { id, action: SearchIndexUpdateQueueAction.Delete }
  ]);

  // Bust user content cache
  await userContentOverviewCache.bust(article.userId);

  return updated;
}
```

**Key Changes:**
- Stores unpublish metadata (reason, customMessage, timestamp, moderator ID)
- Sets status to `UnpublishedViolation` when reason is provided
- Uses transaction for atomic updates
- Updates search index and caches

### Phase 4: Notification System

#### 4.1 Create Article Unpublish Notifications
**File:** `src/server/notifications/article-unpublish.notifications.ts` (NEW)

```typescript
import { NotificationCategory } from '~/server/common/enums';
import { unpublishReasons } from '~/server/common/moderation-helpers';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';

export const articleUnpublishNotifications = createNotificationProcessor({
  'article-unpublished': {
    displayName: 'Article unpublished',
    category: NotificationCategory.System,
    toggleable: false,  // Users cannot disable ToS notifications
    prepareMessage: ({ details }) =>
      details
        ? {
            message:
              details.reason !== 'other'
                ? `Your article "${details.articleTitle}" has been unpublished: ${
                    unpublishReasons[details.reason]?.notificationMessage ?? ''
                  }`
                : `Your article "${details.articleTitle}" has been unpublished: ${
                    details.customMessage ?? ''
                  }`,
            url: `/articles/${details.articleId}`,
          }
        : undefined,
    prepareQuery: ({ lastSent }) => `
      WITH unpublished AS (
        SELECT DISTINCT
          a."userId",
          jsonb_build_object(
            'articleId', a.id,
            'articleTitle', a.title,
            'reason', a.metadata->>'unpublishedReason',
            'customMessage', a.metadata->>'customMessage'
          ) "details"
        FROM "Article" a
        WHERE jsonb_typeof(a.metadata->'unpublishedReason') = 'string'
          AND (a.metadata->>'unpublishedAt')::timestamp > '${lastSent}'
      )
      SELECT
        concat('article-unpublished:', details->>'articleId', ':', '${lastSent}') "key",
        "userId",
        'article-unpublished' "type",
        details
      FROM unpublished;
    `,
  },
});
```

**How It Works:**
1. Notification job runs periodically (cron)
2. Query finds articles where `metadata.unpublishedReason` exists and `unpublishedAt` is recent
3. For each article, creates notification with:
   - Predefined message from `unpublishReasons` dictionary, OR
   - Custom message if reason is "other"
   - Link to article page
4. Sends to article owner (`userId`)

#### 4.2 Register Notifications
**File:** `src/server/notifications/utils.notifications.ts`

Import and export the new processor:

```typescript
import { articleUnpublishNotifications } from '~/server/notifications/article-unpublish.notifications';

export const notificationProcessors = [
  // ... existing processors
  articleUnpublishNotifications,
];
```

### Phase 5: Visibility & Access Control

#### 5.1 Update Article Detail Query
**File:** `src/server/services/article.service.ts` - `getArticleById` function

Current implementation already supports basic visibility, no changes needed:

```typescript
where: {
  id,
  OR: !isModerator
    ? [
        { publishedAt: { not: null }, status: ArticleStatus.Published },
        { userId },  // Owner can see own unpublished articles
      ]
    : undefined,  // Mods can see all articles
},
```

**Result:**
- ✅ Public users: Only see Published articles
- ✅ Article owner: Can see own articles in any status (including `UnpublishedViolation`)
- ✅ Moderators: Can see all articles

#### 5.2 Update Article Listing Queries
**File:** `src/server/services/article.service.ts` - `getArticles` and similar functions

Ensure unpublished articles don't appear in public listings:

```typescript
// For public listings
const statusFilter = isModerator
  ? undefined  // Mods see all
  : { equals: ArticleStatus.Published };

// For user's own content (includeDrafts flag)
const statusFilter = input.includeDrafts && isOwner
  ? { in: [ArticleStatus.Draft, ArticleStatus.Published, ArticleStatus.Unpublished, ArticleStatus.UnpublishedViolation] }
  : { equals: ArticleStatus.Published };
```

### Phase 6: UI Components

**Components to update:**
1. **Article Moderation Panel** - Add unpublish button with reason selector
2. **Article Detail Page** - Show unpublish status banner to article owner
3. **Mod Dashboard** - Add unpublished articles section (if not already present)
4. **Restore Functionality** - Add restore button for moderators viewing unpublished articles

**Implementation details in Section 6.1 below.**

## Unpublish Reasons Reference

The system uses predefined reasons from `src/server/common/moderation-helpers.ts`:

| Reason | Notification Message |
|--------|----------------------|
| `no-posts` | "Resource does not have example images" |
| `mature-real-person` | "Resource depicts a likeness of a real-person" |
| `mature-underage` | "Resource depicts likeness of minors in a mature context" |
| `hate-speech` | "Resource promotes hate speech" |
| `scat` | "Resource depicts feces" |
| `violence` | "Resource depicts violence or gore" |
| `beastiality` | "Resource depicts beastiality" |
| `nudify` | "Resource depicts nudification of an individual without their consent" |
| `non-generated-image` | "Image(s) were not generated by the resource" |
| `spam` | "Resource is spam" |
| `duplicate` | "Resource is a duplicate" |
| `insufficient-description` | "Resource has an insufficient description" |
| `other` | Uses `customMessage` field |

## Database Migration

**Required:** Add `UnpublishedViolation` enum value to `ArticleStatus` in Prisma schema.

**File:** `prisma/schema.prisma`

```prisma
enum ArticleStatus {
  Draft
  Published
  Unpublished
  UnpublishedViolation  // NEW
}
```

Then run:
```bash
npx prisma migrate dev --name add-article-unpublished-violation-status
```

**Note:** Existing data migration not needed - only new unpublish actions will use `UnpublishedViolation`.

## Testing Plan

### Unit Tests
1. Service layer: `unpublishArticleById` with various reasons
2. Schema validation: Valid/invalid unpublish inputs
3. Permission checks: Owner, moderator, unauthorized users

### Integration Tests
1. Full unpublish flow: API call → database update → notification sent
2. Visibility rules: Public, owner, moderator views
3. Search index updates: Verify unpublished articles removed

### Manual Testing Checklist
- [ ] Moderator can unpublish article with ToS reason
- [ ] Article status changes to `UnpublishedViolation`
- [ ] Metadata stores reason, timestamp, moderator ID
- [ ] Article owner receives notification with correct message
- [ ] Article no longer appears in public search/listings
- [ ] Article owner can still view their unpublished article
- [ ] Moderators can still view unpublished article
- [ ] Non-owners cannot view unpublished article
- [ ] Custom message works with "other" reason
- [ ] Owner can unpublish own article without reason (regular `Unpublished` status)
- [ ] Search index updated correctly

## Rollout Strategy

### Phase 1: Backend Implementation (This PR)
- Database schema update
- API endpoint changes
- Service layer logic
- Notification system

### Phase 2: UI Updates (Separate PR?)
- Moderation panel updates
- Article status indicators
- Unpublish modal/form

### Phase 3: Monitoring
- Track unpublish events
- Monitor notification delivery
- Review false positives

## Phase 6.1: Restore Endpoint (NEW)

Since a restore endpoint doesn't exist, we need to create it.

#### 6.1.1 Create Restore Schema
**File:** `src/server/schema/article.schema.ts`

```typescript
export const restoreArticleSchema = z.object({
  id: z.number(),
});

export type RestoreArticleSchema = z.infer<typeof restoreArticleSchema>;
```

#### 6.1.2 Add Router Endpoint
**File:** `src/server/routers/article.router.ts`

```typescript
restore: protectedProcedure
  .input(restoreArticleSchema)
  .use(isFlagProtected('articles'))
  .use(isModerator)  // Only moderators can restore
  .mutation(restoreArticleHandler),
```

**Note:** Need `isModerator` middleware (might already exist, or create it).

#### 6.1.3 Create Controller
**File:** `src/server/controllers/article.controller.ts`

```typescript
export const restoreArticleHandler = async ({
  input,
  ctx,
}: {
  input: RestoreArticleSchema;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { id } = input;
    const restoredArticle = await restoreArticleById({
      id,
      userId: ctx.user.id,
    });
    return restoredArticle;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};
```

#### 6.1.4 Create Service Function
**File:** `src/server/services/article.service.ts`

```typescript
export async function restoreArticleById({
  id,
  userId,
}: {
  id: number;
  userId: number;
}) {
  const article = await dbRead.article.findUnique({
    where: { id },
    select: {
      userId: true,
      status: true,
      metadata: true,
    },
  });

  if (!article) throw throwNotFoundError(`No article with id ${id}`);

  // Can only restore unpublished articles
  if (![ArticleStatus.Unpublished, ArticleStatus.UnpublishedViolation].includes(article.status)) {
    throw throwBadRequestError('Article is not unpublished');
  }

  const updated = await dbWrite.$transaction(
    async (tx) => {
      const metadata = (article.metadata as ArticleMetadata) || {};

      // Clear unpublish metadata
      const updatedMetadata = {
        ...metadata,
        unpublishedReason: undefined,
        customMessage: undefined,
        unpublishedAt: undefined,
        unpublishedBy: undefined,
      };

      return await tx.article.update({
        where: { id },
        data: {
          status: ArticleStatus.Published,
          publishedAt: new Date(),
          metadata: updatedMetadata,
        },
      });
    },
    { timeout: 30000, maxWait: 10000 }
  );

  // Re-add to search index
  await articlesSearchIndex.queueUpdate([
    { id, action: SearchIndexUpdateQueueAction.Update }
  ]);

  await userContentOverviewCache.bust(article.userId);

  return updated;
}
```

## Phase 6.2: Publish Endpoint Protection

**Critical:** Prevent owners from re-publishing articles with `UnpublishedViolation` status.

**File:** `src/server/services/article.service.ts` - Find the publish function

Add this check to the existing `publishArticle` or similar function:

```typescript
export async function publishArticle({ id, userId, isModerator }) {
  const article = await dbRead.article.findUnique({
    where: { id },
    select: { status: true, userId: true },
  });

  // NEW: Prevent owners from re-publishing violation unpublishes
  if (
    article.status === ArticleStatus.UnpublishedViolation &&
    article.userId === userId &&
    !isModerator
  ) {
    throw throwBadRequestError(
      'This article was unpublished for violating Terms of Service and cannot be republished. Please contact support if you believe this was in error.'
    );
  }

  // ... rest of publish logic
}
```

## Phase 6.3: UI Components

Now let's find and update the relevant UI components.

**Need to explore:**
1. Where is the article moderation UI? (likely in `src/components/Article/`)
2. Where is the publish/unpublish button?
3. Is there a modal system for unpublish reasons?
4. How do models show unpublish UI (reference implementation)?

**Action items:**
- Add unpublish button with reason modal to article moderation panel
- Add restore button for moderators
- Show unpublish status banner on article detail page
- Add unpublish reason display

## Files to Create

1. ✨ `src/server/notifications/article-unpublish.notifications.ts` - Notification processor
2. ✨ UI component for unpublish modal (TBD - need to explore existing patterns)

## Files to Modify

### Backend
1. 📝 `src/shared/utils/prisma/enums.ts` - Add `UnpublishedViolation` to ArticleStatus
2. 📝 `src/server/schema/article.schema.ts` - Add `unpublishArticleSchema` + `restoreArticleSchema`
3. 📝 `src/server/routers/article.router.ts` - Update unpublish endpoint + add restore endpoint + add middleware
4. 📝 `src/server/controllers/article.controller.ts` - Update `unpublishArticleHandler` + add `restoreArticleHandler`
5. 📝 `src/server/services/article.service.ts` - Enhance `unpublishArticleById` + add `restoreArticleById` + protect publish function
6. 📝 `src/server/notifications/utils.notifications.ts` - Register article notifications
7. 📝 `prisma/schema.prisma` - Add `UnpublishedViolation` enum value

### Frontend (TBD after exploration)
8. 📝 Article moderation component(s)
9. 📝 Article detail page component
10. 📝 Unpublish modal/form component

## Success Criteria

✅ Moderators can unpublish articles with structured reasons
✅ Unpublish history stored in article metadata
✅ Article owners automatically notified with reason
✅ Unpublished articles visible only to owner + mods
✅ Unpublished articles removed from public search
✅ Moderators can restore unpublished articles (existing restore functionality)
✅ No breaking changes to existing article functionality

## Requirements Summary

Based on feedback:
1. ✅ **Full implementation** - Backend + UI + restore functionality
2. ✅ **Create restore endpoint** - Doesn't currently exist for articles
3. ✅ **Leave related content** - Comments/reactions unaffected
4. ✅ **Use existing reasons** - Start with model unpublish reasons
5. ✅ **No history tracking** - Single unpublish state only
6. ⚠️ **Critical:** Owners cannot re-publish articles unpublished by violation (moderator-only action)

## Estimated Effort

- **Backend Implementation:** ~4-6 hours
- **Testing:** ~2-3 hours
- **UI Updates:** ~3-4 hours (if included)
- **Total:** ~9-13 hours

## References

- Model unpublishing: `src/server/services/model.service.ts:1680-1760`
- Model notifications: `src/server/notifications/unpublish.notifications.ts`
- Unpublish reasons: `src/server/common/moderation-helpers.ts:1-89`
- Current article unpublish: `src/server/services/article.service.ts:710-739`

