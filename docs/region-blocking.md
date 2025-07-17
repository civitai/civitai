# Region Blocking Implementation

This document describes the region blocking mechanism implemented for Civitai to restrict access based on user geographic location.

## Overview

The region blocking system prevents users from specific countries/regions from accessing the Civitai platform due to legal requirements (e.g., UK's Online Safety Act).

## Components

### 1. Middleware

- **`region-block.middleware.ts`**: Blocks web traffic from restricted regions
- **`api-region-block.middleware.ts`**: Blocks API access from restricted regions

### 2. Utilities

- **`region-blocking.ts`**: Core utilities for determining if a region is blocked

### 3. Pages

- **`region-blocked.tsx`**: Static page displayed to users from blocked regions
- **`api/region-status.ts`**: API endpoint for testing region detection

### 4. Hooks

- **`useIsRegionBlocked.ts`**: React hook for client-side region detection (fallback)

## Configuration

### Environment Variables

Set the `RESTRICTED_REGIONS` environment variable to configure blocked regions:

```bash
RESTRICTED_REGIONS=GB,UK,FR,DE
```

If not set, defaults to `['GB', 'UK']` (United Kingdom).

### Cloudflare Integration

The system relies on Cloudflare's `CF-IPCountry` header to determine user location. Ensure your deployment is behind Cloudflare for this to work.

## How It Works

1. **Request Interception**: Next.js middleware intercepts all requests
2. **Region Detection**: Extracts country code from `CF-IPCountry` header
3. **Access Control**:
   - Web requests from blocked regions → Redirect to `/region-blocked`
   - API requests from blocked regions → Return 451 status code
4. **Display**: Blocked users see a static page with explanation

## Testing

### Local Testing

To test the region blocking locally, you can manually set the `CF-IPCountry` header:

```bash
curl -H "CF-IPCountry: GB" http://localhost:3000/
```

Or you can use a browser extension like [Requestly](https://requestly.com/) to override request headers if needed.

### Check Region Status

Use the `/api/region-status` endpoint to check region detection:

```bash
curl http://localhost:3000/api/region-status
```

## File Structure

```
src/
├── server/
│   ├── middleware/
│   │   ├── region-block.middleware.ts
│   │   └── api-region-block.middleware.ts
│   └── utils/
│       └── region-blocking.ts
├── pages/
│   ├── region-blocked.tsx
│   └── api/
│       └── region-status.ts
└── hooks/
    └── useIsRegionBlocked.ts
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

To add or remove blocked regions:

1. Update the `RESTRICTED_REGIONS` environment variable
2. Redeploy the application
3. No code changes required

## Performance Impact

- Minimal overhead: Single header check per request
- No database queries or external API calls
- Leverages Cloudflare's existing geolocation data
