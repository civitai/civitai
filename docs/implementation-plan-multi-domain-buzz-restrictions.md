# Multi-Domain Buzz Currency Restriction Implementation Plan

## Executive Summary

This plan addresses the migration to support multiple sub-domains where each supports one primary Buzz currency (Yellow or Green) while allowing Blue Buzz everywhere. The implementation enforces currency restrictions at both transaction and UI levels.

## Current Architecture Analysis

### Current Buzz Implementation
- **Transaction Service**: `src/server/services/buzz.service.ts` handles all Buzz transactions
- **Account Types**: Yellow, Green, Blue, Red (disabled), with various config options
- **Front-end**: Uses `useBuzz.ts`, `buzz.utils.ts` for balance queries and transactions
- **Feature Flags**: `isGreen` flag exists and controls domain-specific behavior

### Affected Features
1. **Model Training** - Uses `BuzzTransactionButton` with configurable account types
2. **Generation** - Supports multi-account transactions via `createMultiAccountBuzzTransaction`
3. **Tipping** - Uses `SendTipModal` with currency type selection
4. **Model Early Access** - Uses `BuzzTransactionButton` for purchases
5. **Bounty Creation** - Uses `BuzzTransactionButton` with `buzzSpendTypes` 
6. **Cosmetic Purchases** - Uses `createMultiAccountBuzzTransaction`

## Implementation Plan

### Phase 1: Back-end Transaction Logic Changes

#### 1.1 Update Transaction Validation (`src/utils/buzz.ts`)

```typescript
// Update getBuzzTransactionSupportedAccountTypes to accept base array approach
export const getBuzzTransactionSupportedAccountTypes = ({
  nsfwLevel,
  isNsfw,
  baseTypes, // New parameter for domain-filtered account types
}: {
  nsfwLevel?: NsfwLevel;
  isNsfw?: boolean;
  baseTypes?: BuzzSpendType[]; // Defaults to all spend types if not provided
}): BuzzSpendType[] => {
  // Function filters baseTypes based on content restrictions
  // This keeps the service layer clean and domain-agnostic
}

// Services remain clean - no domain knowledge needed
// Controllers/routers will handle filtering account types based on domain
// No changes to createBuzzTransaction or createMultiAccountBuzzTransaction needed
// They already accept fromAccountType and fromAccountTypes parameters
```

#### 1.2 Update Controllers and Routers (Not Services)

Services remain unchanged - they already accept account types as parameters.
Controllers and routers will filter allowed account types based on feature flags.

**Controller Helper Functions:**
```typescript
// src/server/utils/buzz-helpers.ts
export function getAllowedAccountTypes(
  features: FeatureAccess,
  baseTypes: BuzzSpendType[] = ['blue'] // Default includes blue (universal currency)
): BuzzSpendType[] {
  const domainTypes: BuzzSpendType[] = [];

  if (features.isGreen) {
    domainTypes.push('green');
  } else {
    domainTypes.push('yellow');
  }

  return [...domainTypes, ...baseTypes];
}
```

#### 1.3 TRPC Context

No changes needed - `isGreen` feature flag already exists in context under `features.isGreen`.

### Phase 2: Front-end Integration with Feature Flags

#### 2.1 Create Domain-Aware Buzz Hook

**New Hook (`src/components/Buzz/useAvailableBuzz.ts`):**
```typescript
export function useAvailableBuzz(includeBlue = false): BuzzSpendType[] {
  const features = useFeatureFlags();

  return useMemo(() => {
    const allowedTypes: BuzzSpendType[] = [];

    if (features.isGreen) {
      allowedTypes.push('green');
    } else {
      allowedTypes.push('yellow');
    }

    if (includeBlue) {
      allowedTypes.push('blue');
    }

    return allowedTypes;
  }, [features.isGreen, includeBlue]);
}
```

**Update BuzzTransactionButton:**
```typescript
export function BuzzTransactionButton({
  buzzAmount,
  accountTypes: propAccountTypes,
  includeBlue = false,
  // ... other props
}: Props) {
  const domainAllowedTypes = useAvailableBuzz(includeBlue);

  // Use provided account types filtered by domain, or domain defaults
  const allowedAccountTypes = propAccountTypes
    ? propAccountTypes.filter(type => domainAllowedTypes.includes(type))
    : domainAllowedTypes;

  // ... rest of component using allowedAccountTypes
}
```

**SendTipModal (`src/components/Modals/SendTipModal.tsx`):**
```typescript
// Use the new hook for consistency
const supportedCurrencyTypes = useAvailableBuzz(true); // Include blue for tipping
```

#### 2.2 Update Buzz Utilities

**useBuzz.ts:**
```typescript
export function useQueryBuzz(buzzTypes?: BuzzSpendType[]) {
  const defaultTypes = useAvailableBuzz(true); // Include blue by default
  const accountTypes = buzzTypes ?? defaultTypes;

  // ... rest of implementation
}
```

**buzz.utils.ts:**
```typescript
export const useBuzzTransaction = (opts?: {
  // ... existing options
  includeBlue?: boolean;
}) => {
  const defaultAccountTypes = useAvailableBuzz(opts?.includeBlue ?? true);
  const {
    accountTypes = defaultAccountTypes,
    // ... other opts
  } = opts ?? {};

  // ... rest of implementation
};
```

#### 2.3 Update Generation Forms

**GenerationForm2.tsx:**
- Pass domain context to generation requests
- Filter available account types for cost calculation

**TrainingSubmit.tsx:**
- Update account type selection based on domain
- Show appropriate currency restrictions in UI

### Phase 3: API Changes

#### 3.1 Router Updates
**IMPORTANT**: Services should remain domain-agnostic. Calculate allowed account types at router level and pass them down to services.

Update all relevant routers to filter account types based on domain:
- `buzz.router.ts`
- `orchestrator.router.ts`
- `bounty.router.ts`
- `model-version.router.ts`
- `cosmetic-shop.router.ts`

Example pattern:
```typescript
// In router file
import { getAllowedAccountTypes } from '~/server/utils/buzz-helpers';

// For services using createMultiAccountBuzzTransaction
purchaseItem: protectedProcedure
  .input(purchaseItemInput)
  .mutation(async ({ ctx, input }) => {
    // Calculate domain-allowed account types at router level
    const allowedAccountTypes = getAllowedAccountTypes(ctx.features);

    return purchaseItemService({
      ...input,
      userId: ctx.user.id,
      allowedAccountTypes, // Pass to service, not features
    });
  })

// For direct transaction validation
createTransaction: protectedProcedure
  .input(createBuzzTransactionInput)
  .mutation(async ({ ctx, input }) => {
    // Validate fromAccountType against domain restrictions
    if (input.fromAccountType) {
      const allowedTypes = getAllowedAccountTypes(ctx.features);

      if (!allowedTypes.includes(input.fromAccountType as BuzzSpendType)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `${input.fromAccountType} Buzz is not allowed on this domain`
        });
      }
    }

    return createBuzzTransaction({
      ...input,
      fromAccountId: ctx.user.id,
    });
  })
```

#### 3.2 Schema Updates

No schema changes needed - existing `fromAccountType` and `fromAccountTypes` fields are sufficient.
Validation occurs at the router level using feature flags from context.

### Phase 4: Testing Strategy
@dev: you can skip the tests. I'll test manually.

#### 4.1 Testing Approach

Focus on integration and E2E testing rather than unit tests.

**Router Integration Tests:**
```typescript
// Test router validation logic
describe('Buzz router domain restrictions', () => {
  it('should reject invalid account types for domain', async () => {
    // Test API calls with wrong currency types
  });
});
```

**Component Integration Tests:**
```typescript
// Test hook behavior
describe('useAvailableBuzz', () => {
  it('returns correct currencies for each domain type', () => {
    // Test hook with different feature flag values
  });
});
```

#### 4.2 Integration Tests

**Feature Flow Tests:**
- Test complete generation flow on Green vs non-Green domains
- Test tipping with different currency types across domains
- Test model training submission with currency restrictions
- Test early access purchases with domain-specific currencies
- Test bounty creation with appropriate currency filtering
- Test cosmetic purchases across different domains

#### 4.3 End-to-End Tests

**Multi-Domain Scenarios:**
- User switches between Green and non-Green subdomains
- Transaction attempts with wrong currency types are blocked
- UI correctly shows/hides currency options based on domain
- Error messages are appropriate for blocked transactions

### Phase 5: Implementation Order

#### 5.1 Backend Implementation (Week 1)
1. Create `buzz-helpers.ts` utility functions for domain-based account type filtering
2. Update router validation logic to filter account types based on feature flags
3. Test router integration with domain restrictions
4. No service or context changes needed

#### 5.2 Frontend Implementation (Week 2)
1. Create `useAvailableBuzz` hook for domain-aware currency filtering
2. Update `BuzzTransactionButton` to use new hook with `includeBlue` parameter
3. Update `useBuzz` and `buzz.utils` to use new hook for defaults
4. Update transaction modals and forms to use new hook
5. Write component integration tests

#### 5.3 Integration & Testing (Week 3)
1. Integration testing across all affected features
2. End-to-end testing on different domain configurations
3. Performance testing for additional validation overhead
4. User acceptance testing with domain switching scenarios

#### 5.4 Deployment & Monitoring (Week 4)
1. Feature flag rollout strategy
2. Monitoring transaction success rates
3. Error logging for blocked transactions
4. User feedback collection and iteration

## Acceptance Criteria Verification

✅ **Green Domain Restrictions**: Only Green and Blue Buzz usable when `isGreen = true`
✅ **Non-Green Domain Restrictions**: Only Yellow and Blue Buzz usable when `isGreen = false`
✅ **Blue Buzz Universal**: Blue Buzz works everywhere regardless of flag
✅ **Frontend Display**: UI shows correct primary Buzz color for current subdomain
✅ **Automated Testing**: Comprehensive test coverage for all behaviors and features

## Risk Mitigation

- **Feature Flag Rollout**: Gradual release with ability to disable restrictions
- **Backward Compatibility**: Existing transactions continue working during transition
- **User Communication**: Clear error messages when transactions are blocked
- **Fallback Mechanisms**: Blue Buzz as universal fallback option
- **Monitoring**: Transaction success rate monitoring and alerting

## Additional Considerations

### Performance Impact
- Minimal overhead from additional validation logic
- Feature flag lookups are cached and performant
- Database queries remain unchanged

### User Experience
- Clear visual indicators of allowed currencies per domain
- Graceful error handling for restricted transactions
- Consistent currency color coding across domains

### Rollback Strategy
- Feature flags allow instant disable of restrictions
- Database schema changes are additive only
- Rollback testing included in deployment plan

## Success Metrics

- **Functional**: 100% of restricted transactions properly blocked
- **User Experience**: Error rate < 1% for valid transactions
- **Performance**: < 5ms additional latency for transaction validation
- **Coverage**: 90%+ test coverage for all new validation logic
