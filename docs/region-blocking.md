# Region Blocking Implementation

This document describes the region blocking mechanism implemented for Civitai to restrict access based on user geographic location with support for scheduled blocking dates.

## Overview

The region blocking system prevents users from specific countries/regions from accessing the Civitai platform due to legal requirements (e.g., UK's Online Safety Act). The system now supports:

- **Date-based blocking**: Configure when restrictions will take effect
- **Warning notifications**: Alert users before restrictions become active
- **Dynamic modal warnings**: Redis-backed modal dialogs with region-specific content

## Components

### 1. Middleware

- **`region-block.middleware.ts`**: Blocks web traffic from restricted regions (date-aware)
- **`api-region-block.middleware.ts`**: Blocks API access from restricted regions (date-aware)

### 2. Utilities

- **`region-blocking.ts`**: Core utilities for determining if a region is blocked or pending block
  - `isRegionBlocked()`: Check if region is currently blocked
  - `isRegionPendingBlock()`: Check if region will be blocked in future
  - `getDaysUntilRegionBlock()`: Calculate days remaining
  - `getRegionBlockDate()`: Get effective date for region

### 3. Pages

- **`region-blocked.tsx`**: Dynamic page with content based on blocking status
- **`api/region-status.ts`**: API endpoint for testing region detection

### 4. Hooks & Components

- **`useIsRegionBlocked.ts`**: React hook for client-side region detection
- **`useRegionBlockWarning.ts`**: React hook for showing warning notifications
- **`RegionWarningModal.tsx`**: Dynamic modal component that fetches content from Redis

### 5. Content Management

- **`content.service.ts`**: Server-side service for managing markdown content in Redis
  - `getMarkdownContent()`: Retrieve markdown content by key
- **`content.router.ts`**: tRPC router for content operations
- **Redis Content Storage**: Dynamic content management using `REDIS_SYS_KEYS.CONTENT.REGION_WARNING`

## Configuration

### Environment Variables

Set the `REGION_BLOCK_CONFIG` environment variable to configure blocked regions with effective dates:

```bash
REGION_BLOCK_CONFIG=GB:2025-07-24,FR:2025-08-01
```

**Format**: `REGION:YYYY-MM-DD,REGION:YYYY-MM-DD`

If not set, defaults to `GB:2025-07-24,UK:2025-07-24` (United Kingdom effective July 24, 2025).

**Legacy Support**: The old `RESTRICTED_REGIONS` environment variable is still supported but deprecated.

### Cloudflare Integration

The system relies on Cloudflare's `CF-IPCountry` header to determine user location. Ensure your deployment is behind Cloudflare for this to work.

### UK Region Header Support

For UK-specific region detection, the system also supports the `x-isuk` header:

- **Header**: `x-isuk`
- **Values**: `true`, `1` (overrides countryCode to GB)
- **Purpose**: Allows override of country detection for UK users regardless of CF-IPCountry
- **Usage**: When `x-isuk` is set to `true` or `1`, the system overrides `countryCode` to `GB`

**Example**:

```bash
# Test GB blocking regardless of actual location
curl -H "x-isuk: true" http://localhost:3000/
```

### Redis Content Management

The system uses Redis to store dynamic markdown content for region-specific warnings and block pages:

**Content Keys Format**: `system:content:region-warning:{countryCode}` (e.g., `system:content:region-warning:GB` for UK)

**Content Structure**: Markdown with frontmatter

```markdown
---
title: '⚠️ Important Notice for UK Users'
description: 'UK region restriction notice'
---

Your markdown content here with **bold** text for emphasis...
```

**Storage Location**: `REDIS_SYS_KEYS.CONTENT.REGION_WARNING` hash in system Redis

**Management**: Use the content service functions or tRPC endpoints to manage content

## How It Works

1. **Request Interception**: Next.js middleware intercepts all requests
2. **Region Detection**: Extracts country code from `CF-IPCountry` header
3. **Date Checking**: Compares current date with configured effective dates
4. **Access Control**:
   - **Before effective date**: Show warning modals with region-specific content
   - **After effective date**: Block access completely
   - Web requests from blocked regions → Redirect to `/region-blocked`
   - API requests from blocked regions → Return 451 status code
5. **Display**: Users see appropriate messaging based on blocking status and content from Redis

## New Features

### Date-Based Blocking

- Configure specific dates when restrictions take effect
- Gradual rollout: warnings before actual blocking
- All times are in UTC (end of day)

### Warning System

- **Modal warnings**: Dynamic modals that fetch content from Redis based on country code
- **Dismissible**: Users can dismiss modals, stored in localStorage with region-specific keys
- **Content management**: Administrators can update warning content without code deployments
- **Fallback behavior**: Modal only shows if content exists in Redis for the region

### Dynamic Content

- **Redis-backed**: All warning content stored in Redis for easy updates
- **Region-specific**: Content keys formatted as `system:content:region-warning:{countryCode}`
- **Markdown support**: Full markdown rendering with custom component styling
- **Support integration**: Region-blocked page includes contact link to support@civitai.com

## Testing

### Local Testing

To test the region blocking locally, you can manually set headers:

**Standard Country Testing**:

```bash
curl -H "CF-IPCountry: GB" http://localhost:3000/
```

**UK Region Testing**:

```bash
# Test GB blocking with x-isuk header (overrides countryCode)
curl -H "x-isuk: true" http://localhost:3000/

# Test with both headers (x-isuk overrides CF-IPCountry to GB)
curl -H "CF-IPCountry: US" -H "x-isuk: 1" http://localhost:3000/
```

Or you can use a browser extension like [Requestly](https://requestly.com/) to override request headers if needed.

### Check Region Status

Use the `/api/region-status` endpoint to check region detection and blocking status:

```bash
curl http://localhost:3000/api/region-status
```

**Response includes**:

- Current blocking status
- Pending block status
- Days until block (if applicable)
- Effective date information

## File Structure

```
src/
├── server/
│   ├── middleware/
│   │   ├── region-block.middleware.ts
│   │   └── api-region-block.middleware.ts
│   ├── utils/
│   │   └── region-blocking.ts
│   ├── services/
│   │   └── content.service.ts (Redis content management)
│   ├── routers/
│   │   └── content.router.ts (tRPC endpoints)
│   ├── redis/
│   │   └── client.ts (REDIS_SYS_KEYS.CONTENT.REGION_WARNING)
│   └── notifications/
│       └── system.notifications.ts (updated)
├── pages/
│   ├── region-blocked.tsx
│   └── api/
│       └── region-status.ts
├── hooks/
│   ├── useIsRegionBlocked.ts
│   └── useRegionBlockWarning.ts
├── components/
│   ├── AppLayout/
│   │   └── AppLayout.tsx (updated with modal)
│   └── RegionBlock/
│       └── RegionWarningModal.tsx (Redis-backed)
└── static-content/
    ├── gb-region-block.md
    └── gb-region-block-warning.md
```

## Error Handling

- **Web Traffic**: Users are redirected to a user-friendly error page
- **API Traffic**: Returns HTTP 451 (Unavailable For Legal Reasons) with JSON error
- **Fallback**: Client-side hook provides additional safety net

## Security Considerations

- The middleware runs before authentication, ensuring blocked users can't bypass restrictions
- API endpoints are also protected to prevent programmatic access
- The system is fail-safe: unknown regions are allowed access by default

## Maintenance

### Region Configuration

To add or remove blocked regions:

1. Update the `REGION_BLOCK_CONFIG` environment variable
2. Format: `REGION:YYYY-MM-DD,REGION:YYYY-MM-DD`
3. Redeploy the application
4. No code changes required

**Examples:**

- Single region: `REGION_BLOCK_CONFIG=GB:2025-07-24`
- Multiple regions: `REGION_BLOCK_CONFIG=GB:2025-07-24,FR:2025-08-01,DE:2025-09-15`
- US state specific: `REGION_BLOCK_CONFIG=US:CA:2025-07-24` (for California)
- Mixed configuration: `REGION_BLOCK_CONFIG=GB:2025-07-24,US:CA:2025-08-01,US:NY:2025-09-15`

### Content Management

To update warning messages and region-blocked page content:

1. **Via tRPC**: Use the `content.getMarkdown` and content management endpoints
2. **Content Keys**:
   - `system:content:region-warning:{countryCode}` for modal warnings
   - Add content with markdown and frontmatter
3. **Real-time Updates**: Changes take effect immediately without deployment
4. **Fallback**: If no Redis content exists, modal won't show (graceful degradation)

**Example Content Management:**

```typescript
// Set content for UK warnings
await contentService.setMarkdownContent({
  key: 'system:content:region-warning:GB',
  content: `---
title: "⚠️ Important Notice for UK Users"
description: "UK region restriction notice"
---

We're deeply disappointed to announce that access to Civitai will be restricted in your region due to the UK's Online Safety Act.

**This decision is effective immediately.**

We recommend downloading any important content before access is restricted.`,
});
```

## Performance Impact

- Minimal overhead: Single header check per request
- No database queries or external API calls
- Leverages Cloudflare's existing geolocation data
