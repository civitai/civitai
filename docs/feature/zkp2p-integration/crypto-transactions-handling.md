There's a crypto transactions modal that you can access from your account page, and it says stuff about Coinbase and ZKP2P, which is great. It makes it clear that they've got, you know, dollars that are pending. I think we need to make this more obvious. It's not clear that you need to go into your account settings and the place that it's put is just kind of strange. I think that we put it there just for, you know, not knowing where else to put it. But I think it makes more sense. to have a thing inside the Buzz dashboard that maybe displays the amount of USDC that they have pending and gives them an easy button that they can press to buy Buzz with it. Maybe it goes alongside the needing more Buzz notification there, or maybe underneath it or above it. Something like, you have X USDC available. Would you like to purchase Buzz with it? And then you can click, you know, complete purchase. and probably should say the amount of buzz that you're purchasing. And then ideally, it looks kind of like that need more buzz thing. And maybe we don't even display the need more buzz thing if they have USDC.

Please prepare a clear plan and outline of what needs to be done below this line.
---

# ZKP2P Crypto Transactions Integration Plan

## Overview
Improve the visibility and usability of USDC pending balances by integrating them directly into the Buzz dashboard, making it more intuitive for users to complete crypto-to-Buzz purchases.

## Current Issues
- Crypto transactions modal is hidden in account settings
- Not obvious that users have pending USDC available
- Placement feels disconnected from the Buzz purchase flow
- Users may not know they can complete purchases with their pending crypto

## Proposed Solution

### 1. Move USDC Balance Display to Buzz Dashboard
**Location**: Buzz dashboard main view
**Components to modify**:
- Buzz dashboard component (likely in `/components/Buzz/Dashboard/` or similar)
- Add new USDC pending balance component
@dev: Let's only display this component if they have USDC in their wallet. Ideally, we can use the crypto transaction table rather than have to actually go hit their wallet. Let me know how we might query that. You can always look at data schemas inside of the Prisma schema file.

@ai: Based on the Prisma schema, I found the `CryptoTransaction` table with these fields:
- `userId` - to identify user's transactions
- `status` - enum with values like `WaitingForRamp`, `Complete`, `RampSuccess`, `SweepSuccess`
- `amount` - stored in pennies for USDC
- `currency` - defaults to `USDC`

We can query pending USDC by checking for transactions with status `RampSuccess` (USDC received but not yet converted to Buzz). We can also use the existing `useCoinbaseOnrampBalance` hook which already gets the wallet balance.
@dev: Is there anything inside of that hook that's going to be unnecessary for us, or is it using the crypto transaction table in the same way?

### 2. New USDC Purchase Prompt Component
**Features**:
- Display pending USDC amount clearly
- Show equivalent Buzz amount they can purchase
- One-click "Complete Purchase" button
- Visual design matching the existing "Need More Buzz" notification

**Component Structure**:
```
┌─────────────────────────────────────────────────────────────────────────┐
│ 💰 You have $X.XX USDC                          [Purchase Y,000 Buzz →] │
└─────────────────────────────────────────────────────────────────────────┘
```
@dev: Let's go ahead and do the purchase Y buzz inside of this button. And try and get all of this onto one line. Obviously it can wrap if they're on mobile.

@ai: Updated the component design to be single-line with the purchase amount integrated into the button label.

@dev: I adjusted it just a bit more, but I'm happy with it now.


### 3. Smart Display Logic
- Check if user has pending USDC balance
- If USDC is available:
  - Show USDC purchase prompt
  - Hide or minimize "Need More Buzz" notification
- If no USDC available:
  - Show standard "Need More Buzz" notification

### 4. Technical Implementation Tasks

#### Phase 1: Discovery & Analysis
- [x] Located crypto transactions modal at `/components/Account/CryptoTransactions.tsx`
- [x] Found Buzz dashboard at `/components/Buzz/Dashboard/BuzzDashboardOverview.tsx`
- [x] Identified USDC balance via `useCoinbaseOnrampBalance` hook
- [x] Found existing `processUserPendingTransactions` function

#### Phase 2: Component Development
- [ ] Create `USDCPurchasePrompt` component (single component for both display and action)
- [ ] Integrate into `BuzzDashboardOverview.tsx`
- [ ] Reuse component in `CryptoTransactions.tsx` modal
- [ ] Implement conditional rendering (only show if USDC balance > 0)
@dev: Do we need the pending USDC balance component, or can we just use the USDC purchase prompt and have the USDC balance displayed in there? Additionally, just want to make sure that we query the database to see if they have any pending transactions or something like that, and then we check their balance in their wallet. I think we probably don't have any sort of loading state or skeleton for this component, because otherwise there's going to be a lot of jumping around while we load every time we do this check. So instead just render it if it comes back and says that there is a transaction for them.

@ai: Good point! We don't need a separate pending balance component. The `USDCPurchasePrompt` will handle everything:
1. Query the database first for pending transactions
2. If found, then check wallet balance via `useCoinbaseOnrampBalance`
3. Only render the component if balance > 0 (no loading states to avoid UI jumping)
4. The component itself will display the balance inline with the purchase button

#### Phase 3: Integration & Flow
- [ ] Connect to existing crypto transaction processing
- [ ] Update state management for USDC balances
- [ ] Ensure proper refresh after purchases
- [ ] Handle error states and edge cases

#### Phase 4: Polish & Testing
- [ ] Match visual design with existing Buzz UI
- [ ] Add loading states and animations
- [ ] Test purchase flow end-to-end
- [ ] Verify Coinbase & ZKP2P integrations work

@dev: Let's also remove the existing links to the crypto transactions modal and instead have that somewhere on the Buzz dashboard. Can you also make sure that the purchase button there works correctly? And maybe we actually use that USDC purchase prompt inside of the modal so that we don't have to repeat ourselves. I think it'll work there as well.

@ai: Will do:
1. Remove the crypto transactions modal link from account settings
2. Add a link to crypto transactions modal on the Buzz dashboard (likely at the bottom of the Recent Transactions card)
3. Reuse the `USDCPurchasePrompt` component inside the `CryptoTransactions` modal to avoid duplication
4. Ensure the purchase button calls `processUserPendingTransactions` which already exists in the codebase
@dev: As part of this project can you review how that works to make sure that it's functional? I've noticed that right now when I press that button it doesn't seem to do anything, or at least it didn't update the front end.

## Files to Be Modified (Based on Codebase Analysis)

### Frontend Components
- `/components/Buzz/Dashboard/BuzzDashboardOverview.tsx` - Add USDC purchase prompt
- `/components/Account/CryptoTransactions.tsx` - Reuse USDC prompt component
- `/components/Buzz/BuzzTopUpCard.tsx` - Modify to conditionally hide when USDC available
- `/components/Coinbase/util.ts` - Already has `useCoinbaseOnrampBalance` hook

### New Component to Create
- `/components/Buzz/USDCPurchasePrompt.tsx` - Shared component for USDC balance display

### Backend (Already Exists)
- `/server/services/coinbase.service.ts` - Has `processUserPendingTransactions`
- `/server/routers/coinbase.router.ts` - Exposes the tRPC endpoints
- `/server/common/constants.ts` - Has `buzzDollarRatio: 1000`

### Database Schema (Already Exists)
- `CryptoTransaction` table tracks USDC transactions
- `CryptoWallet` table stores user wallet info

## Success Criteria
1. Users can see pending USDC balance without navigating to settings
2. One-click purchase from dashboard to complete crypto-to-Buzz conversion
3. Clear indication of how much Buzz they'll receive
4. Seamless integration with existing Buzz dashboard UI
5. Smart hiding of redundant "Need More Buzz" when USDC is available
@dev: Can you look at how we purchasing buzz with crypto (the actual moving of USDC and sending of Buzz), just to make sure that we're on the same page about how to get that done? There should be existing functions for it.

@ai: Found the existing flow:
1. `processUserPendingTransactions` in `coinbase.service.ts` handles the conversion
2. It checks wallet balance via `getUserWalletBalance`
3. The mutation is exposed via tRPC in `coinbase.router.ts`
4. The frontend uses `useMutateCoinbase` hook which provides `processUserPendingTransactions`
5. This is already being used in the `CryptoTransactions` component with the "Process Pending Transactions" button

## Questions to Clarify
- @ai: Should we show both fiat and crypto pending balances, or just USDC?
- @dev: There will be no fiat balance.
- @ai: Understood, only USDC balances will be shown.

- @ai: What's the exact calculation for USDC to Buzz conversion rates?
- @dev: Can you look through the codebase to see if we have that conversion rate somewhere already? I would imagine that we have some sort of utility for it since we're already transacting USDC for Buzz. But if not, let's go ahead and create one. The conversion rate is one USDC to a thousand Buzz.
- @ai: Found it in `src/server/common/constants.ts`: `buzzDollarRatio: 1000`. This means 1 USD = 1000 Buzz. Since USDC is pegged to USD, the conversion is 1 USDC = 1000 Buzz. The `getBuzzWithdrawalDetails` function in `src/utils/buzz.ts` uses this constant for conversions.
- @dev: Okay, can we potentially move that conversion somewhere else if there's not a specific conversion function or add that as a utility? Just so that we can use it in those places? And in our own instance?

- @ai: Should there be a minimum USDC amount before showing the prompt?
- @dev: No.
- @ai: The prompt will show for any USDC amount > 0.

- @ai: Do we need to handle multiple crypto currencies or just USDC for now?
- @dev: Just USDC
- @ai: Will focus solely on USDC for this implementation.

@dev: I'm pretty sure that right now we're using the crypto transaction to determine how much buzz they should get, but instead I think we want to just be using the amount of USDC they have in their wallet to determine how much buzz to send them.
