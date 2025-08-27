# ZKP2P iframe Integration - Implementation Plan

## Overview
This document outlines the plan to integrate ZKP2P payment methods as individual options in the Buzz purchase interface, using an embedded iframe for the actual payment processing.

## Current State Analysis

### Existing ZKP2P Integration
ZKP2P is **already integrated** in Civitai with:
- ✅ Full backend API (`zkp2pRouter`, `zkp2pService`)
- ✅ Frontend button component (`BuzzZkp2pOnrampButton.tsx`)
- ✅ Multiple payment app support (Venmo, CashApp, Zelle, PayPal, Wise, Revolut)
- 🔒 Currently limited to moderators via feature flag

### Current Implementation Approach
The existing implementation opens ZKP2P in a **new window/tab** rather than an iframe. This plan will modify it to use an **embedded iframe** on a dedicated page.

## Implementation Goals

1. **Display individual ZKP2P payment methods** (Venmo, CashApp, etc.) as separate payment options in the Buzz purchase UI
2. **Create dedicated iframe page** at `/purchase/zkp2p`
3. **Embed ZKP2P iframe** with proper URL parameters based on purchase amount
4. **Handle iframe events** for transaction status updates
5. **Navigate users back** to Civitai home page after successful purchase

## Technical Implementation

### Phase 1: Create iframe Host Page
**New File:** `src/pages/purchase/zkp2p.tsx`

```tsx
// Page that hosts the ZKP2P iframe
// - Extracts query parameters (amount, payment method)
// - Constructs iframe URL with proper parameters
// - Handles postMessage events from iframe
// - Manages navigation and success states
```

**Requirements:**
- Parse URL parameters: `amount`, `buzzAmount`, `paymentMethod`
- Build iframe URL: `https://zkp2p.civitai.com/onramp?usdcAmount={amount}&currency=usd&paymentMethod={method}`
- Set iframe dimensions: 100% width and height to fill container, min-height: 600px
  ```css
  /* CSS variables already exist in src/styles/globals.css:
     --header-height: 60px;
     --footer-height: 45px; */

  .iframe-container {
    position: relative;
    width: 100%;
    height: calc(100vh - var(--header-height) - var(--footer-height));
    min-height: 600px;
  }
  iframe {
    width: 100%;
    height: 100%;
    border: 0;
  }
  ```
@ai: Using existing CSS variables from globals.css (--header-height: 60px, --footer-height: 45px)
- Add `allow="clipboard-write"` permission

### Phase 2: Create Individual Payment Method Buttons
**Update:** `src/components/Buzz/BuzzZkp2pOnrampButton.tsx`

Instead of one "Pay with ZKP2P" button, create individual buttons for each payment method:
- Venmo Button
- CashApp Button
- PayPal Button
- Zelle Button
- Wise Button
- Revolut Button

Each button will:
1. Navigate to `/purchase/zkp2p` with appropriate parameters
2. Pass `paymentMethod`, `amount`, and `buzzAmount` as query params
3. Show appropriate payment method icon/branding

### Phase 3: iframe Communication

**PostMessage Event Handling:**
```javascript
// Event types from iframe
- 'flow:started' - User began the payment flow
- 'flow:step' - User reached a specific step
- 'flow:completed' - Payment successful
- 'flow:error' - Error occurred
- 'flow:return-home' - User clicked go home button

// Handle success by:
// When 'flow:return-home' event is received, navigate back to home page
router.push('/');
```
@ai: Simplified to just navigate home when 'flow:return-home' event is received


### Phase 4: Payment Method Display Integration

**Update:** `src/components/Buzz/BuzzPurchaseImproved.tsx`

Modify the payment methods section to show individual ZKP2P options:

```tsx
{features.zkp2pPayments && (
  <>
    <BuzzZkp2pButton method="venmo" {...props} />
    <BuzzZkp2pButton method="cashapp" {...props} />
    <BuzzZkp2pButton method="paypal" {...props} />
    {/* Additional methods based on user location/preferences */}
  </>
)}
```
@ai: Changed to fragment to keep buttons inline with other payment methods

## File Changes Required

### New Files
1. **`src/pages/purchase/zkp2p.tsx`** - iframe host page
2. **`src/components/Buzz/BuzzZkp2pButton.tsx`** - Individual payment method button component

### Modified Files
1. **`src/components/Buzz/BuzzPurchaseImproved.tsx`** - Display individual payment methods
2. **`src/server/services/feature-flags.service.ts`** - Keep existing zkp2pPayments flag

### Files to Remove
1. **`src/components/Buzz/BuzzZkp2pOnrampButton.tsx`** - Replace with new individual button components

@ai: Will remove the old BuzzZkp2pOnrampButton since it's only used in BuzzPurchaseImproved, keeping existing feature flag

## User Flow

1. **User visits Buzz purchase page**
   - Sees individual ZKP2P payment options (Venmo, CashApp, etc.)

2. **User clicks a payment method** (e.g., Venmo)
   - Navigates to `/purchase/zkp2p?paymentMethod=venmo&amount=10&buzzAmount=1000`

3. **ZKP2P iframe loads**
   - Shows ZKP2P onramp with pre-configured parameters
   - User completes payment through iframe

4. **Payment completion**
   - iframe sends `flow:completed` event
   - User clicks "Return to Civitai" button `flow:return-home`

## Security Considerations

1. **Origin Verification**
   - Only accept postMessage from `https://zkp2p.civitai.com`

2. **Authentication**
   - Require user to be logged in to access `/purchase/zkp2p` page
   - Use same pattern as `src/pages/user/account.tsx`:

   ```typescript
   export const getServerSideProps = createServerSideProps({
     useSSG: true,
     useSession: true,
     resolver: async ({ ssg, session }) => {
       if (!session?.user || session.user.bannedAt)
         return {
           redirect: {
             destination: '/login?returnUrl=/purchase/zkp2p',
             permanent: false,
           },
         };
       // Continue with page load
     },
   });
   ```
@ai: Added authentication example from account.tsx using createServerSideProps

## Testing Requirements

### Browser Compatibility
- ✅ Chrome (Desktop)
- ✅ Edge (Desktop)
- ✅ Brave (Desktop)
- ❌ Safari (Not supported by ZKP2P)
- ❌ Mobile browsers (Not supported by ZKP2P)

**Browser Detection for Button Disabling:**
```typescript
// In BuzzZkp2pButton component
const isSupported = useMemo(() => {
  const userAgent = navigator.userAgent.toLowerCase();
  const isDesktop = !(/mobile|android|iphone|ipad/i.test(userAgent));
  const isChromium = /chrome|chromium|crios/.test(userAgent) ||
                     /edg/.test(userAgent) ||
                     /brave/.test(userAgent);
  return isDesktop && isChromium;
}, []);

// Disable button for unsupported browsers with popover explanation
import { Popover, Button } from '@mantine/core';

{!isSupported ? (
  <Popover position="top" withArrow>
    <Popover.Target>
      <Button disabled {...props}>
        {config.label}
      </Button>
    </Popover.Target>
    <Popover.Dropdown>
      <Text size="sm">
        This payment method requires Desktop Chrome, Edge, or Brave browser.
        Mobile browsers and Safari are not supported yet.
      </Text>
    </Popover.Dropdown>
  </Popover>
) : (
  <Button {...props}>
    {config.label}
  </Button>
)}
```
@ai: Updated to use Popover component for disabled buttons, following pattern from BrowsingMode.tsx

### Test Scenarios
1. Verify iframe loads correctly with proper parameters
2. Confirm postMessage events are received and handled
3. Test navigation back to home on 'flow:return-home' event
4. Verify browser detection and button disabling works
5. Test authentication redirect for non-logged-in users

@ai: Simplified test scenarios to focus on integration points only, as payment flow testing happens in zkp2p repository

## Rollout Strategy

### Phase 1: Internal Testing
- Keep feature flag as `['mod']`
- Test with moderator accounts
- Verify all payment methods work

### Phase 2: Beta Testing (US Only)
- Update feature flag to include beta testers
- **Geo-restrict to US only** using region detection:

  ```typescript
  // In BuzzZkp2pButton component
  import { useAppContext } from '~/hooks/useAppContext';

  const { region } = useAppContext();
  const isUSRegion = region?.countryCode === 'US';

  // Show buttons only for US users
  if (!isUSRegion) return null;
  ```

  Or use server-side geo detection:
  ```typescript
  // In getServerSideProps
  import { getRegion } from '~/server/utils/region-blocking';

  const region = getRegion(context.req);
  const isUSOnly = region.countryCode === 'US';
  ```

- Monitor transaction success rates
- Gather user feedback
@ai: Added geo-restriction example using existing region detection from region-blocking.ts
@dev: I think it would be nice to be able to have this actually baked into our feature flag system. Can you put together a proposal and a separate document for how to do this? Also, can you provide the references for where you got these examples?
@ai: Created separate proposal document: **[geo-based-feature-flags-proposal.md](./geo-based-feature-flags-proposal.md)**

**References for examples:**
- Region detection: `src/server/utils/region-blocking.ts:39-48`
- AppContext region: `src/providers/AppContext.tsx:62-65`
- useAppContext hook: `src/hooks/useAppContext.tsx`

### Phase 3: Public Launch
- Change feature flag to `['public']`
- Add user education/tooltips
- Monitor metrics and error rates

## Success Metrics

1. **Conversion Rate** - % of users who complete purchase via ZKP2P
2. **Success Rate** - % of initiated transactions that complete
3. **Time to Complete** - Average time from button click to success
4. **Error Rate** - % of transactions that fail
5. **User Feedback** - Satisfaction scores and complaints

### ClickHouse Integration
Full metrics collection specification available in: **[clickhouse-metrics.md](./clickhouse-metrics.md)**

**Quick Implementation:**
```typescript
// Track events using existing Tracker pattern
import { clickhouse } from '~/server/clickhouse/client';

// In button component
clickhouse.zkp2pEvent({
  eventType: 'button_click',
  paymentMethod: 'venmo',
  usdAmount: 10,
  buzzAmount: 1000,
  // ... other fields
});

// In iframe page for postMessage events
clickhouse.zkp2pEvent({
  eventType: 'flow_completed',
  sessionId: sessionId,
  // ... other fields
});
```

See clickhouse-metrics.md for:
- Database table schemas
- Materialized views for analytics
- Query examples for dashboards
- Monitoring and alerting setup

@ai: Created separate clickhouse-metrics.md with full specification

## Open Questions

@ai: Should we show all payment methods to all users, or filter based on location? For example, only show Revolut to European users?
@dev: That's great. Yes. I guess that means that we probably need to have some sort of configuration so that we can define which payment methods are available for which geos.

**Payment Method Geo-Configuration:**
```typescript
// src/components/Buzz/zkp2p-config.ts
export const ZKP2P_PAYMENT_METHODS = {
  venmo: {
    regions: ['US'],
    icon: IconVenmo,
    label: 'Venmo'
  },
  cashapp: {
    regions: ['US'],
    icon: IconCashApp,
    label: 'Cash App'
  },
  paypal: {
    regions: ['US', 'EU', 'GB', 'CA', 'AU'],
    icon: IconPayPal,
    label: 'PayPal'
  },
  zelle: {
    regions: ['US'],
    icon: IconZelle,
    label: 'Zelle'
  },
  wise: {
    regions: ['EU', 'GB', 'CA', 'AU', 'JP', 'US'],
    icon: IconWise,
    label: 'Wise'
  },
  revolut: {
    regions: ['EU', 'GB'],
    icon: IconRevolut,
    label: 'Revolut'
  }
};

// Filter methods by region (undefined regions = available everywhere)
const availableMethods = Object.entries(ZKP2P_PAYMENT_METHODS)
  .filter(([_, config]) => {
    if (!config.regions) return true;  // No regions = available everywhere
    return config.regions.includes(region.countryCode);
  })
  .map(([method, config]) => ({ method, ...config }));
```
@ai: Updated to handle undefined regions (available everywhere)
@dev: Are we going to be able to get the region country code the same way that we're doing that US checkup above?
@ai: Yes, region.countryCode is available from useAppContext() hook in components (as shown above) and from getRegion() in server-side code

@ai: What should happen if the user closes the iframe page before completion? Should we save their progress or require starting over?
@dev: progress is automatically saved by the iframe side of things. Perhaps we should put something in local storage to tell them that they have an open transaction and kind of pin that to their page as a toast notification. I guess look through the code base to see how we're doing other toast notifications. And let's get that on the to-do list. Ideally, if they click through that, they can either, well, they can click it to go back to the transaction or they can dismiss it.

**Pending Transaction Notification:**
Location 1: **Check for pending transaction** - In main app layout or _app.tsx:
```typescript
// src/pages/_app.tsx (in the App component)
// Or in src/components/AppLayout/AppLayout.tsx
useEffect(() => {
  const checkPendingTransaction = () => {
    const pendingTx = localStorage.getItem('zkp2p_pending');
    if (pendingTx) {
      const { sessionId, paymentMethod, amount } = JSON.parse(pendingTx);

      showConfirmNotification({
        title: 'Pending ZKP2P Transaction',
        message: `You have an incomplete ${paymentMethod} payment for $${amount}`,
        autoClose: false, // Keep open until user acts
        onConfirm: () => {
          router.push(`/purchase/zkp2p?sessionId=${sessionId}&paymentMethod=${paymentMethod}&amount=${amount}`);
        },
        onCancel: () => {
          localStorage.removeItem('zkp2p_pending');
        }
      });
    }
  };

  // Check on mount and when window gains focus
  checkPendingTransaction();
  window.addEventListener('focus', checkPendingTransaction);

  return () => window.removeEventListener('focus', checkPendingTransaction);
}, []);
```

Location 2: **Clear on completion** - In iframe postMessage handler:
```typescript
// src/pages/purchase/zkp2p.tsx
window.addEventListener('message', (event) => {
  if (event.data.type === 'flow:completed') {
    localStorage.removeItem('zkp2p_pending');
  }
});
```
@ai: Specified exact locations for pending transaction notification implementation

@ai: Do we want to implement a timeout for the iframe session? What happens if a user leaves the page open for hours?
@dev: The iframe side handles this.
@ai: No timeout implementation needed on our side

@ai: Should we pre-select a recommended payment method based on user location or previous purchases?
@dev: No need to do that for now.
@ai: No pre-selection logic needed

## Next Steps

1. Review and approve this implementation plan
2. Create the iframe host page component
3. Create individual ZKP2P payment method buttons
4. Implement postMessage event handling
5. Add pending transaction notification system
6. Implement geo-based payment method filtering
7. Add ClickHouse metrics tracking
8. Test with moderator accounts
9. Deploy to production with feature flag

## Dependencies

- ZKP2P service must be running at `zkp2p.civitai.com`
- iframe must support the documented URL parameters
- CSP headers must allow embedding from civitai.com

@dev: It's actually not live yet, but it will be soon. Don't worry about it actually loading what the contents of the iframe are, and just assume that you're going to get those post messages. We can test that part of things later.
@ai: Will proceed with implementation assuming iframe will send expected postMessage events
