# Bitwise Flag Utilities

Utilities for working with bitwise flags throughout the codebase.

## Overview

The codebase uses bitwise flags extensively for:
- NSFW levels and content filtering
- Multi-select options stored efficiently (e.g. `OnboardingSteps`)

Feature flags are **not** bitwise — those are string-keyed and Flipt-backed, see `src/server/services/feature-flags.service.ts`.

## Key Files

| File | Purpose |
|------|---------|
| `src/shared/utils/flags.ts` | `Flags` utility class |
| `src/server/common/enums.ts` | `NsfwLevel` enum (the bit values) |
| `src/shared/constants/browsingLevel.constants.ts` | Derived browsing-level flags + predicates |

## The Flags Class

```typescript
import { Flags } from '~/shared/utils/flags';
```

Only the four methods below are covered here; `flags.ts` exports about a dozen more
(`toggleFlag`, `intersection`, `instanceToArray`, `diff`, …). Read the file rather than
assuming this list is complete.

### Check if Flag is Set

```typescript
// Check if a specific flag is set
Flags.hasFlag(instance, flag);

// Example: Check if user has PG13 enabled
const hasPG13 = Flags.hasFlag(userBrowsingLevel, NsfwLevel.PG13);
```

### Check for Any Overlap

```typescript
// Check if ANY bits overlap between two values
Flags.intersects(a, b);

// Example: Check if content is visible to user
const isVisible = Flags.intersects(contentLevel, userBrowsingLevel);
// Returns true if content's level matches any of user's allowed levels
```

### Add a Flag

```typescript
// Add a flag to an existing value
const newValue = Flags.addFlag(instance, flag);

// Example: Add R-rated content to user's preferences
const newLevel = Flags.addFlag(userBrowsingLevel, NsfwLevel.R);
```

### Remove a Flag

```typescript
// Remove a flag from an existing value
const newValue = Flags.removeFlag(instance, flag);

// Example: Remove XXX from user's preferences
const newLevel = Flags.removeFlag(userBrowsingLevel, NsfwLevel.XXX);
```

## Common Patterns

### Combining Multiple Flags

```typescript
// Combine flags with bitwise OR
const multipleFlags = Flag.A | Flag.B | Flag.C;

// Example: Allow PG, PG13, and R content
const allowedLevels = NsfwLevel.PG | NsfwLevel.PG13 | NsfwLevel.R; // = 7
```

### Checking Multiple Conditions

```typescript
// Check if ALL flags are set (bitwise AND)
const hasAll = (value & requiredFlags) === requiredFlags;

// Check if ANY flags are set (intersects)
const hasAny = Flags.intersects(value, checkFlags);
```

### Database Queries with Flags

The column is camelCase and must be quoted in raw SQL:

```sql
-- Check if content matches user's browsing level
WHERE (i."nsfwLevel" & :userBrowsingLevel) != 0

-- Check if specific flag is set
WHERE (flags & :specificFlag) = :specificFlag
```

### TypeScript Enum Flags

```typescript
// Define flags as powers of 2
enum MyFlags {
  None = 0,
  OptionA = 1,    // 0b0001
  OptionB = 2,    // 0b0010
  OptionC = 4,    // 0b0100
  OptionD = 8,    // 0b1000
  All = 15,       // 0b1111
}
```

## See Also

- [NSFW Filtering](./nsfw-filtering.md) - Primary use case for bitwise flags
