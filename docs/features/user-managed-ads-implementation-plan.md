# User-Managed Ads Implementation Plan

## Current Ad System Analysis

### Existing Ad Placements
Based on code review, the current ad system includes:

1. **In-Feed Ads** (`AdUnitIncontent_1`)
   - Location: `src/components/MasonryColumns/MasonryGrid.tsx`
   - Injected into masonry grid feeds between content items
   - Sizes: 320x100, 320x50, 300x250, 300x100, 300x50

2. **Adhesive/Sticky Ads** (`AdUnitAdhesive`)
   - Location: `src/components/AppLayout/AppLayout.tsx`
   - Appears at bottom of viewport
   - Hidden for paid members
   - Can be closed by users on desktop

3. **Side Ads** (`AdUnitSide_1`, `AdUnitSide_2`, `AdUnitSide_3`)
   - Various responsive sizes up to 300x600

4. **Top Banner Ads** (`AdUnitTop`)
   - Responsive sizes from 320x50 up to 970x250

5. **Outstream Video Ads**
   - Component exists at `src/components/Ads/AdUnitOutstream.tsx`

### Current Architecture
- **Ad Provider**: Snigel/AdEngine with Google Ad Manager integration
- **Context Provider**: `AdsProvider` manages ad state globally
- **User Settings**: `allowAds` flag in `BrowserSettingsProvider`
- **Membership Check**: `isMember` and `isPaidMember` flags control ad visibility

## Implementation Plan

### Phase 1: Core Ad Layer Infrastructure

#### 1.1 Create Ad Layer Component
```typescript
// src/components/Ads/AdLayer/AdLayer.tsx
- Absolute positioned overlay (z-index: 9999)
- Contains all draggable ad blocks
- Manages collision detection
- Handles persistence of positions
```

#### 1.2 Create Draggable Ad Block Component
```typescript
// src/components/Ads/AdLayer/DraggableAdBlock.tsx
- Wrapper for existing ad units
- Drag functionality using react-draggable or similar
- Resize handles (optional)
- Minimize/expand capability
- Close button (for optional ads)
```

#### 1.3 Ad Layer Store (Zustand)
```typescript
// src/store/adLayer.store.ts
- Track ad block positions per user
- Track which ad blocks are active
- Handle add/remove ad blocks
- Manage refresh intervals
```

### Phase 2: Database Schema Updates

#### 2.1 User Ad Preferences Table
```sql
CREATE TABLE user_ad_preferences (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  device_id VARCHAR(255), -- For non-logged-in users
  ad_blocks JSONB, -- Array of ad block configs
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Ad block config structure:
{
  id: string,
  type: 'banner' | 'square' | 'video',
  position: { x: number, y: number },
  size: { width: number, height: number },
  minimized: boolean,
  enabled: boolean
}
```

### Phase 3: Remove Existing Ad Placements

#### Files to Modify:
1. **`src/components/MasonryColumns/MasonryGrid.tsx`**
   - Remove in-feed ad injection logic
   - Remove `useCreateAdFeed` usage

2. **`src/components/AppLayout/AppLayout.tsx`**
   - Remove `AdhesiveAd` component
   - Add `AdLayer` component instead

3. **`src/components/Image/DetailV2/ImageDetail2.tsx`**
   - Remove any inline ad placements

### Phase 4: User Interface for Ad Management

#### 4.1 Ad Management Panel
```typescript
// src/components/Ads/AdLayer/AdManagementPanel.tsx
```
Features:
- Toggle to show/hide ad management mode
- Add new ad block button
- Select ad format (banner/square/video)
- Reset layout button
- Save preferences button

#### 4.2 Floating Ad Controls Button
```typescript
// src/components/Ads/AdLayer/AdControlsButton.tsx
```
- Fixed position button (bottom-right corner)
- Opens ad management panel
- Shows count of active ad blocks
- Visual indicator for ad-free members

### Phase 5: API Endpoints

#### 5.1 tRPC Routes
```typescript
// src/server/routers/ads.router.ts

// Get user ad preferences
getUserAdPreferences: protectedProcedure
  .query(async ({ ctx }) => {
    // Fetch from database
  })

// Save user ad preferences  
saveUserAdPreferences: protectedProcedure
  .input(adPreferencesSchema)
  .mutation(async ({ ctx, input }) => {
    // Save to database
  })

// Reset ad layout to defaults
resetAdLayout: protectedProcedure
  .mutation(async ({ ctx }) => {
    // Reset to default positions
  })
```

### Phase 6: Integration with Existing Systems

#### 6.1 Modify AdsProvider
- Add ad layer state management
- Handle refresh intervals (60-90 seconds)
- Integrate with existing ad loading logic

#### 6.2 Update User Settings
- Add "Manage Ad Layout" option in settings
- Show different options for free vs. paid users
- Allow paid users to enable optional ads

### Phase 7: Mobile Responsiveness

#### 7.1 Mobile Strategy
- Fixed positions on mobile (no dragging)
- Simplified layout with 1-2 ad blocks max
- Bottom sheet for ad management
- Swipe-to-minimize gesture

### Phase 8: Features & Polish

#### 8.1 Grid Snapping
- 10px grid for cleaner positioning
- Snap to edges
- Alignment guides

#### 8.2 Collision Detection
- Prevent ad blocks from overlapping
- Push other blocks when dragging

#### 8.3 Animations
- Smooth transitions when dragging
- Minimize/expand animations
- Fade in/out when adding/removing

## Technical Dependencies

### Required Packages
```json
{
  "react-draggable": "^4.4.5",
  "react-grid-layout": "^1.4.0", // Alternative option
  "@dnd-kit/sortable": "^7.0.0" // Another alternative
}
```

## Migration Strategy

1. **Soft Launch**
   - Deploy ad layer alongside existing ads
   - A/B test with small user group
   - Monitor performance metrics

2. **Gradual Rollout**
   - Enable for logged-in users first
   - Then expand to all users
   - Keep fallback to old system

3. **Full Migration**
   - Remove old ad components
   - Clean up unused code
   - Archive old ad-related tables

## Success Metrics

- **Viewability Rate**: Target 100% (vs current ~40-60%)
- **CPM Increase**: Target 2-3x current rates
- **User Satisfaction**: Measure through surveys
- **Ad Revenue**: Track total revenue change
- **User Retention**: Monitor impact on user engagement

## Risk Mitigation

1. **Ad Blocker Detection**: Ensure ad layer isn't easily blocked
2. **Performance**: Lazy load ad units, optimize re-renders
3. **Accessibility**: Ensure keyboard navigation works
4. **Browser Compatibility**: Test across all major browsers
5. **Fallback System**: Keep old system as backup initially

## Timeline Estimate

- **Phase 1-2**: 1 week - Core infrastructure
- **Phase 3-4**: 1 week - UI and removal of old system  
- **Phase 5-6**: 3-4 days - API and integration
- **Phase 7-8**: 3-4 days - Mobile and polish
- **Testing & QA**: 1 week
- **Total**: ~4 weeks for full implementation

## Next Steps

1. Review this plan with stakeholders
2. Create feature flag for gradual rollout
3. Set up A/B testing infrastructure
4. Begin Phase 1 implementation