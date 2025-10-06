# Changelog Service Documentation

## Overview
The Changelog Service is a comprehensive system for managing and displaying application updates, bug fixes, features, and announcements to users. It provides both public-facing display and admin management capabilities.

## Architecture

### Database Schema

The changelog system uses a single `Changelog` table with the following structure:

```
Changelog {
  id          Int           -- Primary key, auto-increment
  title       String        -- Required title
  content     String        -- Rich text content (HTML)
  link        String?       -- Optional link to commit or article
  cta         String?       -- Optional call-to-action link
  effectiveAt DateTime      -- When the changelog becomes visible
  createdAt   DateTime      -- Auto-set creation timestamp
  updatedAt   DateTime      -- Auto-updated modification timestamp
  type        ChangelogType -- Enum type of changelog
  tags        String[]      -- Array of tags for categorization
  disabled    Boolean       -- Whether the entry is disabled
  titleColor  String?       -- Optional gradient color for title
  sticky      Boolean       -- Whether to pin at the top
}
```

#### Changelog Types
- **Feature**: New functionality added
- **Bugfix**: Bug fixes and corrections
- **Policy**: Policy changes or updates
- **Update**: General updates or improvements
- **Incident**: Service incidents or issues

### Backend Services

#### Service Layer (`src/server/services/changelog.service.ts`)

The service layer provides core CRUD operations and query functionality:

**Key Functions:**
- `getChangelogs()`: Retrieves paginated changelog entries with filtering
  - Supports search across title and content
  - Date range filtering (dateAfter/dateBefore)
  - Type and tag filtering
  - Handles sticky items separately (always shown at top)
  - Feature flag support for admin visibility
  
- `createChangelog()`: Creates new changelog entry
- `updateChangelog()`: Updates existing entry
- `deleteChangelog()`: Removes an entry
- `getAllTags()`: Returns unique tags from all entries
- `getLatestChangelog()`: Gets timestamp of most recent entry

**Query Features:**
- Full-text search using PostgreSQL GIN indexes with trigram support
- Pagination with cursor-based navigation
- Filtering by type, tags, date range
- Sticky items always appear first
- Admin users can see disabled and future-dated entries

#### Router Layer (`src/server/routers/changelog.router.ts`)

TRPC router exposing API endpoints:

- `getInfinite`: Public endpoint for fetching changelogs with infinite scroll
- `create`: Moderator-only endpoint for creating entries
- `update`: Moderator-only endpoint for updating entries
- `delete`: Moderator-only endpoint for deleting entries
- `getAllTags`: Public endpoint for fetching all available tags
- `getLatest`: Cached endpoint returning latest changelog timestamp

**Security:**
- Write operations protected by `moderatorProcedure` middleware
- Feature flag protection (`changelogEdit`) for admin operations
- Edge caching on read operations for performance

### Frontend Components

#### Main Display Component (`src/components/Changelog/Changelogs.tsx`)

The primary component for displaying and managing changelogs:

**Features:**
- Infinite scroll pagination
- Real-time search
- Sort direction toggle (ascending/descending by date)
- Filter dropdown integration
- Admin editing interface
- New/unread indicator based on local storage
- Sticky items display
- Deep linking support (scroll to specific entry via URL)

**Admin Features (when `changelogEdit` feature flag enabled):**
- Inline create/edit form
- Rich text editor for content
- Date picker for scheduling
- Tag management
- Disable/enable entries
- Delete with confirmation modal

#### Filter Component (`src/components/Changelog/ChangelogFiltersDropdown.tsx`)

Provides advanced filtering options:
- Multi-select type filter
- Tag selection with autocomplete
- Date range selection (before/after)
- Mobile-optimized drawer on small screens
- Filter count indicator
- Clear all filters button

## Data Flow

### Read Flow
1. User visits `/changelog` page
2. Page component prefetches tags via SSG
3. Changelogs component fetches initial data via `getInfinite` query
4. User scrolls → triggers infinite scroll to fetch more
5. Filters/search trigger new queries with debouncing

### Write Flow (Admin)
1. Admin user with `changelogEdit` feature flag accesses page
2. Clicks "Create New" button to open form
3. Fills out form with rich text editor
4. Submits → calls `create` mutation
5. Invalidates queries to refresh display
6. Shows success notification

## Key Features

### Sticky Items
- Entries marked as `sticky: true` always appear at the top
- Only loaded on first page (skip=0) to avoid duplication
- Useful for important announcements

### Visibility Control
- `effectiveAt`: Controls when an entry becomes visible
- `disabled`: Hides entry from public view
- Admins can see all entries regardless of state

### Rich Content
- HTML content with sanitization via `RenderHtml` component
- Support for embedded media, links, formatting
- Optional CTA button for feature promotion

### User Experience
- "New" indicator for unseen updates (stored in localStorage)
- Deep linking to specific changelog entries
- Mobile-responsive with drawer filters
- Gradient title colors for visual hierarchy
- Type badges with semantic colors

## Feature Flags

The system uses the `changelogEdit` feature flag to control admin capabilities:
- When enabled: Full CRUD operations available
- When disabled: Read-only public view
