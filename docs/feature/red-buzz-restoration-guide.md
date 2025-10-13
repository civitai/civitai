# Red Buzz Restoration Guide

This document outlines the changes made to temporarily disable Red Buzz and use Yellow Buzz instead. When Red Buzz needs to be re-enabled, follow this guide in reverse.

## Overview

Red Buzz has been temporarily disabled in production. All references have been updated to use Yellow Buzz while keeping the infrastructure in place for easy restoration.

## Files Modified

### 1. BuzzTypeSelector Component
**File:** `src/components/Buzz/BuzzPurchase/BuzzTypeSelector.tsx`

**Changes:**
- Changed `redButton` prop to `yellowButton`
- Updated button text from "Red Buzz" to "Yellow Buzz"
- Changed `onSelect('red')` to `onSelect('yellow')`
- Updated CSS classes from `redClassNames` to `yellowClassNames`
- Changed test ID from `buzz-type-red` to `buzz-type-yellow`

**To restore:** Revert all yellow references back to red in this component.

### 2. Buzz Hooks and Utilities
**File:** `src/components/Buzz/useBuzz.ts`

**Changes:**
- Updated default `buzzTypes` array from `['green', 'yellow', 'red']` to `['green', 'yellow']`

**To restore:** Add `'red'` back to the default array.

**File:** `src/components/Buzz/buzz.utils.ts`

**Changes:**
- Updated default `accountTypes` from `['green', 'yellow', 'red']` to `['green', 'yellow']`

**To restore:** Add `'red'` back to the default array.

### 3. Interactive Tip Buzz Button
**File:** `src/components/Buzz/InteractiveTipBuzzButton.tsx`

**Changes:**
- Updated type definitions to exclude 'red' (commented out with "temporarily disabled")
- Removed red account from balance calculations
- Updated currency selector to only show green and yellow
- Commented out `redConfig` usage

**To restore:**
- Uncomment all red-related type definitions
- Restore red account in balance calculations
- Add 'red' back to currency selector array
- Uncomment `redConfig` usage

### 4. Dashboard Overview
**File:** `src/components/Buzz/Dashboard/BuzzDashboardOverview.tsx`

**Changes:**
- Updated yellow case to handle NSFW content (previously red's functionality)
- Commented out red cases in both description and usage functions

**To restore:**
- Restore original yellow case description
- Uncomment red cases in both functions

### 5. GetPaid Component
**File:** `src/components/Buzz/GetPaid/GetPaid.tsx`

**Changes:**
- Changed `redBuzzConfig` to `yellowBuzzConfig`
- Updated CSS variable setting to use yellow color

**To restore:** Revert to use `redBuzzConfig` and update CSS variable accordingly.

### 6. Pricing Pages
**File:** `src/pages/pricing/new.tsx`

**Changes:**
- Updated type definition from `'green' | 'red'` to `'green' | 'red' | 'yellow'`
- Added new section to handle yellow membership selection that redirects to gift cards
- Added import for YellowMembershipGiftCards component

**To restore:** Remove yellow type and yellow membership handling section if desired, or keep for yellow membership support.

**File:** `src/pages/purchase/buzz.tsx`

**Changes:**
- Updated schema enum from `['yellow', 'green', 'red']` to `['yellow', 'green']`

**To restore:** Add 'red' back to the enum array.

### 7. Purchase Components
**File:** `src/components/Purchase/RedMembershipUnavailable.tsx`

**Changes:** None - this component remains unchanged and handles red membership unavailability.

**File:** `src/components/Purchase/YellowMembershipGiftCards.tsx` (NEW)

**Changes:**
- Created new component to handle yellow membership gift card purchases
- Provides options to buy via gift cards, choose green membership, or buy individual yellow buzz

**To restore:** This component can remain as it provides a valid yellow membership flow.

**File:** `src/components/Purchase/MembershipTypeSelector.tsx`

**Changes:**
- Updated to use `yellowButton` instead of `redButton` prop
- Changed text from "Red Membership" to "Yellow Membership"

**To restore:** Revert to use `redButton` prop and "Red Membership" text.

## Configuration Constants

The core buzz constants in `src/shared/constants/buzz.constants.ts` were **NOT** modified to maintain infrastructure. The red buzz type still exists in the system but is not actively used in the UI.

## Easy Restoration Steps

1. **Global Search and Replace:**
   - Find all comments containing "temporarily disabled" and uncomment the red functionality
   - Find all yellow references that were changed from red and revert them

2. **Specific File Changes:**
   - Revert all files listed above according to their restoration notes
   - Update any new tests to include red buzz testing

3. **Verification:**
   - Run type checking: `npm run typecheck`
   - Run linting: `npm run lint`
   - Test all buzz purchase flows with red buzz

## Notes

- The backend infrastructure for red buzz remains intact
- All database schemas and API endpoints still support red buzz
- Payment integrations (crypto) for red buzz are preserved
- Only frontend display and routing logic was modified

**Date:** 2025-09-16
**Author:** Claude Code Assistant