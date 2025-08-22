# Region Blocking and Restriction Implementation

This document describes the region blocking and restriction mechanisms implemented for Civitai to control access based on user geographic location with support for scheduled effective dates.

## Overview

The region system prevents or limits access to the Civitai platform due to legal requirements. The system supports two types of regional controls:

### Blocked Regions

Complete access restriction - users cannot access the site at all.

### Restricted Regions

Limited feature access - users can access the site but with reduced functionality.

Both systems support:

- **Date-based activation**: Configure when restrictions will take effect
- **Warning notifications**: Alert users before restrictions become active
- **Dynamic modal warnings**: Redis-backed modal dialogs with region-specific content

## Components

### 1. Middleware

- **`region-block.middleware.ts`**: Blocks web traffic from blocked regions (date-aware)
- **`region-restriction.middleware.ts`**: Redirects restricted regions to civitai.green domain
- **`api-region-block.middleware.ts`**: Blocks API access from blocked regions (date-aware)

### 2. Utilities

- **`region-blocking.ts`**: Core utilities for determining region status with DRY architecture. Contains several helper and core functions to handle region blocking and restriction, including status checking, date calculations, and effective date retrieval.

### 3. Pages

- **`region-blocked.tsx`**: Dynamic page with content based on blocking status
- **`api/region-status.ts`**: API endpoint for testing region detection

### 4. Hooks & Components

- **`useIsRegionBlocked.ts`**: React hook for client-side region blocking detection
- **`useIsRegionRestricted.ts`**: React hook specifically for region restriction status
- **`useRegionBlockWarning.ts`**: React hook for showing warning notifications using dialogStore pattern
- **`useRegionRedirectDetection.ts`**: React hook that automatically detects region-based redirects and triggers modal using dialogStore
- **`RegionWarningModal.tsx`**: Dynamic modal component that fetches content from Redis
- **`RegionRedirectModal.tsx`**: Modal component to inform users about region redirects

### 5. Content Management

- **Redis Content Storage**: Dynamic content management using `REDIS_SYS_KEYS.CONTENT.REGION_WARNING`

## Configuration

### Environment Variables

#### Blocked Regions (Complete Access Restriction)

Set the `REGION_BLOCK_CONFIG` environment variable to configure blocked regions with effective dates:

```bash
REGION_BLOCK_CONFIG=GB:2025-07-24,FR:2025-08-01
```

**Format**: `REGION:YYYY-MM-DD,REGION:YYYY-MM-DD`

If not set, defaults are configured in `src/utils/region-blocking.ts`

#### Restricted Regions (Limited Features)

Set the `REGION_RESTRICTION_CONFIG` environment variable to configure restricted regions with effective dates:

```bash
REGION_RESTRICTION_CONFIG=DE:2025-08-15,US:CA:2025-09-01
```

**Format**: Same as block config - `REGION:YYYY-MM-DD,REGION:YYYY-MM-DD`

If not set, defaults are configured in `src/utils/region-blocking.ts`

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
   - **After effective date for blocked regions**: Block access completely
   - **After effective date for restricted regions**: Limit features and functionality
   - Web requests from blocked regions → Redirect to `/region-blocked`
   - API requests from blocked regions → Return 451 status code
   - Restricted regions → Continue with limited feature set
5. **Display**: Users see appropriate messaging based on status and content from Redis

## New Features

### Date-Based Controls

- Configure specific dates when restrictions take effect for both blocking and restriction
- Gradual rollout: warnings before actual blocking/restriction
- All times are in UTC (end of day)

### Dual Control System

- **Complete blocking**: For regions requiring full access restriction
- **Feature limitation**: For regions requiring reduced functionality while maintaining access
- **Separate configuration**: Block and restriction configs are independent

### Region Restriction Redirect

- **Automatic redirect**: Users from restricted regions are automatically redirected to the green domain (civitai.green)
- **Transparent experience**: The redirect maintains the same URL path and query parameters
- **User notification**: A modal informs users about the redirect and explains the content limitations
- **Headers**: Redirect includes `x-region-redirect: true` and `x-redirect-reason: region-restriction` headers
- **Query parameter**: Adds `region-redirect=true` to the URL for frontend detection

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

### Feature Flags Integration

The region system integrates with the feature flags service to enable region-based feature toggling:

**Region Availability Types**:

- `restricted`: Feature only available in restricted regions
- `nonRestricted`: Feature only available in non-restricted regions

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

- Current blocking status (`isBlocked`)
- Current restriction status (`isRestricted`)
- Pending block status (`isPendingBlock`)
- Pending restriction status (`isPendingRestriction`)
- Days until block (if applicable)
- Days until restriction (if applicable)
- Effective date information for both blocks and restrictions

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
│   ├── useIsRegionRestricted.ts
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

To add or remove blocked or restricted regions:

1. **For blocked regions**: Update the `REGION_BLOCK_CONFIG` environment variable
2. **For restricted regions**: Update the `REGION_RESTRICTION_CONFIG` environment variable
3. Format: `REGION:YYYY-MM-DD,REGION:YYYY-MM-DD`
4. Redeploy the application
5. No code changes required

**Examples:**

- **Blocked regions**: `REGION_BLOCK_CONFIG=GB:2025-07-24,FR:2025-08-01`
- **Restricted regions**: `REGION_RESTRICTION_CONFIG=DE:2025-08-15,IT:2025-09-01`
- **US state specific**: `REGION_RESTRICTION_CONFIG=US:CA:2025-07-24` (for California)
- **Mixed configuration**:
  - `REGION_BLOCK_CONFIG=GB:2025-07-24`
  - `REGION_RESTRICTION_CONFIG=DE:2025-08-15,FR:2025-09-01,US:NY:2025-10-15`

### Default Configurations

If no environment variables are set, defaults are configured in `src/utils/region-blocking.ts`

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
