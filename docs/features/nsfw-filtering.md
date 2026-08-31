# NSFW Level Filtering

Filter content based on maturity ratings and user browsing preferences.

## Overview

The NSFW filtering system uses bitwise flags to efficiently filter content based on maturity levels. Users set their browsing preferences, and content is filtered to only show what matches their settings.

## Key Files

| File | Purpose |
|------|---------|
| `src/server/common/enums.ts` | `NsfwLevel` enum — source of truth for the bit values |
| `src/shared/constants/browsingLevel.constants.ts` | Derived flags, ceilings and predicates |
| `src/shared/utils/flags.ts` | `Flags` utility class |
| `src/server/services/image.service.ts` | The feed filter in practice |

## NsfwLevel Enum

The levels are bitwise flags, allowing content to be tagged with multiple levels and users to allow multiple levels. Mirrored here because they're the whole subject of this doc — `src/server/common/enums.ts` is authoritative:

```typescript
enum NsfwLevel {
  PG = 1,      // 0b00001  - Safe for all ages
  PG13 = 2,    // 0b00010  - Teen appropriate
  R = 4,       // 0b00100  - Mature themes
  X = 8,       // 0b01000  - Adult content
  XXX = 16,    // 0b10000  - Explicit content
  Blocked = 32 // 0b100000 - Blocked content
}
```

## Usage

### Checking Content Visibility

```typescript
import { Flags } from '~/shared/utils/flags';

// Check if content is visible to user
const isVisible = Flags.intersects(contentNsfwLevel, userBrowsingLevel);
// Returns true if ANY bits overlap (content allowed for user)
```

This is the core predicate but **not** the whole filter — see "What the mask alone doesn't tell you" below.

### Checking if Content is NSFW

```typescript
import { nsfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

// R | X | XXX | Blocked === 60. Note it includes Blocked, not just the three mature levels.
const isNsfw = Flags.intersects(level, nsfwBrowsingLevelsFlag);
```

### Combining Levels

```typescript
// User wants to see PG and PG13 content
const browsingLevel = NsfwLevel.PG | NsfwLevel.PG13; // = 3

// Content tagged as PG13
const contentLevel = NsfwLevel.PG13; // = 2

// Check visibility
Flags.intersects(contentLevel, browsingLevel); // true
```

## Common Patterns

### Filtering Database Queries

Prisma has no bitwise operator, so this is always raw SQL. The column is camelCase and must be quoted:

```typescript
Prisma.sql`AND (i."nsfwLevel" & ${browsingLevel}) != 0`
```

### Setting Content Levels

When creating content that accepts multiple NSFW levels:
```typescript
// Allow PG through R content
const allowedLevels = NsfwLevel.PG | NsfwLevel.PG13 | NsfwLevel.R; // = 7
```

## What the mask alone doesn't tell you

`Flags.intersects(contentLevel, browsingLevel)` is necessary but not sufficient. The real feed path in `image.service.ts` layers three more rules on top, and code that reimplements only the mask will not match it:

- **`Blocked` is stripped before the comparison.** Browsing levels go through `onlySelectableLevels()` (`browsingLevel.constants.ts`) first, so a user's stored level never admits `Blocked` content.
- **Unrated content (`nsfwLevel = 0`) matches nothing** — `0 & anything === 0` — so it needs its own branch. The public feed excludes it explicitly; owners see their own, and moderators get it added only when their level already intersects NSFW.
- **A per-domain ceiling clamps the result.** `domainBrowsingCeiling` limits blue/green domains to SFW regardless of user preference; red is unclamped.

## See Also

- [Bitwise Flag Utilities](./bitwise-flags.md) - General flag manipulation utilities
