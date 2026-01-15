# NSFW Level Filtering

Filter content based on maturity ratings and user browsing preferences.

## Overview

The NSFW filtering system uses bitwise flags to efficiently filter content based on maturity levels. Users set their browsing preferences, and content is filtered to only show what matches their settings.

## Key Files

| File | Purpose |
|------|---------|
| `src/server/common/enums.ts` | `NsfwLevel` enum (lines 277+) |
| `src/shared/constants/browsingLevel.constants.ts` | Level constants and utilities |
| `event-engine-common/utils/nsfw-utils.ts` | `Flags` utility class |

## NsfwLevel Enum

The levels are bitwise flags, allowing content to be tagged with multiple levels and users to allow multiple levels:

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
import { Flags } from '~/event-engine-common/utils/nsfw-utils';

// Check if content is visible to user
const isVisible = Flags.intersects(contentNsfwLevel, userBrowsingLevel);
// Returns true if ANY bits overlap (content allowed for user)
```

### Checking if Content is NSFW

```typescript
import { nsfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

// Check if content is NSFW (R, X, or XXX)
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

```typescript
// In Prisma queries, use bitwise AND
where: {
  nsfwLevel: {
    // Content level AND user level != 0
    // This is typically done with raw SQL or computed fields
  }
}
```

### Setting Content Levels

When creating content that accepts multiple NSFW levels:
```typescript
// Allow PG through R content
const allowedLevels = NsfwLevel.PG | NsfwLevel.PG13 | NsfwLevel.R; // = 7
```

## See Also

- [Bitwise Flag Utilities](./bitwise-flags.md) - General flag manipulation utilities
