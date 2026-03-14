# BitDex Filter Testing

Test that BitDex correctly handles all image search filter combinations used across the site.

## Prerequisites

A dev server (or production) must be running with BitDex enabled (Flipt `bitdex-image-search` set to `primary` or `shadow`).

## Scripts

### 1. `query.mjs` — Interactive Query Tool

Run individual queries against the image search endpoint. Use this to explore, debug, or verify specific filter combinations.

```bash
# Basic query
node .claude/skills/bitdex-test/query.mjs --sort Newest --limit 5

# Filter by type and base model
node .claude/skills/bitdex-test/query.mjs --sort "Most Reactions" --types image --base-models "SD 1.5"

# User profile view
node .claude/skills/bitdex-test/query.mjs --username civitai --sort Newest

# Model gallery view
node .claude/skills/bitdex-test/query.mjs --model-version-id 12345 --sort "Most Reactions"

# Remixes
node .claude/skills/bitdex-test/query.mjs --remix-of 12345
node .claude/skills/bitdex-test/query.mjs --remixes-only
node .claude/skills/bitdex-test/query.mjs --non-remixes-only

# NSFW filtering (bitmask: PG=1, PG13=2, R=4, X=8, XXX=16)
node .claude/skills/bitdex-test/query.mjs --nsfw 1       # PG only
node .claude/skills/bitdex-test/query.mjs --nsfw 3       # PG+PG13
node .claude/skills/bitdex-test/query.mjs --nsfw 31      # All (default)

# Machine-readable output
node .claude/skills/bitdex-test/query.mjs --json         # Compressed JSON
node .claude/skills/bitdex-test/query.mjs --raw           # Full tRPC response

# Pagination
node .claude/skills/bitdex-test/query.mjs --cursor "200|bdx:{...}"
```

**All flags**: `--base-url`, `--limit`, `--sort`, `--period`, `--types`, `--tags`, `--tools`, `--techniques`, `--base-models`, `--user-id`, `--username`, `--model-id`, `--model-version-id`, `--post-id`, `--remix-of`, `--remixes-only`, `--non-remixes-only`, `--with-meta`, `--from-platform`, `--nsfw`, `--cursor`, `--raw`, `--json`

### 2. `test-filters.mjs` — Full Test Suite

Runs all filter combinations organized by site context and outputs a markdown report.

```bash
# Run all tests
node .claude/skills/bitdex-test/test-filters.mjs

# Run specific section
node .claude/skills/bitdex-test/test-filters.mjs --section main-feed

# List available sections
node .claude/skills/bitdex-test/test-filters.mjs --list

# Save report to file
node .claude/skills/bitdex-test/test-filters.mjs --output docs/working/bitdex-test-results.md

# Verbose (includes query params in output)
node .claude/skills/bitdex-test/test-filters.mjs --verbose
```

**Test sections**:
| Section | What it covers |
|---------|---------------|
| `main-feed` | /images page — all sorts, periods, types, base models, meta, platform, remix filters, NSFW levels, combinations |
| `user-profile` | User profile image tab — user-scoped queries with sorts and type filters |
| `model-gallery` | Model version gallery — modelVersionId-scoped queries |
| `post-detail` | Post detail page — postId-scoped queries |
| `remix-detail` | Image remix tab — remixOfId queries |
| `edge-cases` | Empty results, limit boundaries, multi-tag filters |

## How to Review Results

When reviewing the markdown output, look for:

1. **Errors (❌)**: Any query that returned an HTTP error — likely a filter that BitDex doesn't handle
2. **Empty results that shouldn't be**: Compare against what you'd expect (e.g., "Newest images" should never be empty)
3. **Wrong sort order**: Check that "Most Reactions" results are sorted by reaction count descending, "Newest" by date descending, etc.
4. **NSFW leakage**: PG-only queries should not return images with nsfwLevel > 1
5. **Type mismatches**: "image only" queries should not return videos
6. **Missing data**: Check that stats, tags, user info, and metadata are populated
7. **Date sanity**: Dates should be reasonable (not year 2106 or 1970)

## Extending Tests

Add new test cases to the `sections` object in `test-filters.mjs`. Each test is a `[name, inputObject]` tuple where `inputObject` matches the `getInfiniteImagesSchema` fields.

For model-specific or post-specific tests, the agent should first discover real IDs using `query.mjs` and then substitute them into the test cases.
