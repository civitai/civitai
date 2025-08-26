# Geo-Based Feature Flags Proposal

## Overview
This document proposes extending the Civitai feature flag system to support geographic restrictions, allowing features to be enabled/disabled based on user location.

## Current Feature Flag System

### Location: `src/server/services/feature-flags.service.ts`

The current system uses simple arrays to define who has access to features:
```typescript
export const featureFlags = {
  zkp2pPayments: ['mod'],  // Only moderators
  nowpaymentPayments: [],  // Disabled
  coinbasePayments: ['public'],  // Everyone
  // ...
};
```

**Reference Pattern:** Found in AppContext (`src/providers/AppContext.tsx:62-65`)
```typescript
const region = getRegion(req);
context.region = {
  countryCode: region.countryCode as string,
  regionCode: region.regionCode,
};
```

## Proposed Enhancement

### Option 1: Extend Feature Flag Definition
```typescript
// src/server/services/feature-flags.service.ts

type FeatureFlag = string[] | {
  access: string[];
  regions?: {
    include?: string[];  // Whitelist regions
    exclude?: string[];  // Blacklist regions
  };
};

export const featureFlags = {
  zkp2pPayments: {
    access: ['public'],
    regions: {
      include: ['US']  // US-only initially
    }
  },
  
  // Backward compatible - string arrays still work
  coinbasePayments: ['public'],
  
  // Example: Available everywhere except UK
  someFeature: {
    access: ['public'],
    regions: {
      exclude: ['GB']
    }
  }
};
```

### Option 2: Separate Geo Configuration
```typescript
// src/server/services/feature-flags.service.ts

export const featureFlags = {
  zkp2pPayments: ['public'],
  // ... existing flags
};

export const featureFlagRegions = {
  zkp2pPayments: {
    include: ['US']
  },
  // Only features with geo restrictions need entries
};
```

## Implementation Details

### 1. Feature Flag Check Function
```typescript
// src/server/services/feature-flags.service.ts

export function hasFeature(
  featureName: string,
  user: { tier?: string; isModerator?: boolean },
  region?: { countryCode?: string }
): boolean {
  const flag = featureFlags[featureName];
  
  if (!flag) return false;
  
  // Handle legacy string array format
  if (Array.isArray(flag)) {
    return checkAccess(flag, user);
  }
  
  // Check access level
  if (!checkAccess(flag.access, user)) {
    return false;
  }
  
  // Check region restrictions
  if (flag.regions && region?.countryCode) {
    const { include, exclude } = flag.regions;
    
    if (include && !include.includes(region.countryCode)) {
      return false;
    }
    
    if (exclude && exclude.includes(region.countryCode)) {
      return false;
    }
  }
  
  return true;
}

function checkAccess(
  access: string[],
  user: { tier?: string; isModerator?: boolean }
): boolean {
  if (access.includes('public')) return true;
  if (access.includes('mod') && user.isModerator) return true;
  if (user.tier && access.includes(user.tier)) return true;
  return false;
}
```

### 2. Server-Side Integration
```typescript
// src/server/routers/system.router.ts

export const getFeatureFlagsHandler = async ({ ctx }) => {
  const region = ctx.region;  // Already available in context
  const user = ctx.user;
  
  const features = {};
  for (const [key, flag] of Object.entries(featureFlags)) {
    features[key] = hasFeature(key, user, region);
  }
  
  return features;
};
```

### 3. Client-Side Hook
```typescript
// src/hooks/useFeatureFlags.ts

export function useFeatureFlag(flagName: string): boolean {
  const features = useFeatureFlags();
  const { region } = useAppContext();
  const currentUser = useCurrentUser();
  
  // Client-side double-check (server should be source of truth)
  return hasFeature(flagName, currentUser, region);
}
```

## Region Detection References

### Existing Region Detection (`src/server/utils/region-blocking.ts`)
```typescript
export function getRegion(req: NextRequest | NextApiRequest | IncomingMessage) {
  let countryCode = req.headers['cf-ipcountry'];
  const isUKHeader = req.headers['x-isuk'];
  
  // Override countryCode to GB if x-isuk header is present
  if (isUKHeader === 'true' || isUKHeader === '1') {
    countryCode = 'GB';
  }
  
  return { countryCode, regionCode, fullLocationCode };
}
```

This is already used in:
- `src/server/utils/server-side-helpers.ts:116`
- `src/pages/api/region-status.ts:7`
- `src/providers/AppContext.tsx:62`

## Migration Path

1. **Phase 1:** Implement new system with backward compatibility
2. **Phase 2:** Gradually migrate existing flags to new format as needed
3. **Phase 3:** Update documentation and developer guidelines

## Benefits

1. **Centralized Control:** All feature access logic in one place
2. **Backward Compatible:** Existing flags continue to work
3. **Flexible:** Support both whitelisting and blacklisting regions
4. **Consistent:** Uses existing region detection infrastructure
5. **Type-Safe:** Can add TypeScript definitions for better IDE support

## Example Usage

```typescript
// In a component
const features = useFeatureFlags();

{features.zkp2pPayments && (
  <BuzzZkp2pButton />
)}

// In getServerSideProps
const region = getRegion(context.req);
const hasZkp2p = hasFeature('zkp2pPayments', session.user, region);
```

## Testing Strategy

1. **Unit Tests:** Test `hasFeature` function with various combinations
2. **Integration Tests:** Test with actual CloudFlare headers
3. **VPN Testing:** Test with VPN to simulate different regions
4. **Header Override:** Use `x-isuk` pattern for other test regions

## Recommendation

**Recommend Option 1** (Extended Feature Flag Definition) because:
- More explicit and self-documenting
- All configuration in one place
- Easier to understand feature availability at a glance
- Supports future extensions (time-based, A/B testing, etc.)

## Next Steps

1. Review and approve approach
2. Implement `hasFeature` function with tests
3. Update feature flag definitions
4. Test with ZKP2P as first geo-restricted feature
5. Document for other developers