# User-Managed Ads Mockup Implementation Outline

## Overview
Create a fully interactive mockup of the draggable ad layer system without backend integration. All data stored in localStorage for persistence across sessions.

## Component Structure

### 1. Core Components to Create

#### `/src/components/Ads/AdLayerMockup/`
- `AdLayerMockup.tsx` - Main container component
- `DraggableAdBlock.tsx` - Individual draggable ad wrapper
- `AdManagementPanel.tsx` - Control panel for managing ads
- `AdControlButton.tsx` - Floating button to open management panel
- `GridOverlay.tsx` - Visual grid for snapping
- `mockAdData.ts` - Fake ad content generators
- `useAdLayerStore.ts` - Zustand store for state management
- `types.ts` - TypeScript interfaces

### 2. Features to Implement

#### Phase 1: Basic Draggable Ads
- Create ad layer with absolute positioning
- Implement draggable ad blocks using react-draggable
- Use placeholder images (via placeholder.com or similar)
- Support 3 ad formats: banner (728x90), square (300x250), video (400x225)

#### Phase 2: Ad Management
- Floating control button (bottom-right corner)
- Management panel with:
  - List of active ad blocks
  - Add new ad block buttons
  - Remove ad block functionality
  - Reset layout button

#### Phase 3: Advanced Interactions
- Minimize/expand functionality for each ad
- Grid snapping (10px grid)
- Collision detection between ad blocks
- Visual feedback during drag operations

#### Phase 4: Persistence
- Save positions to localStorage
- Save minimized states
- Save which ads are active
- Auto-restore on page load

#### Phase 5: Polish
- Smooth animations for all transitions
- Different visual states (normal, dragging, minimized)
- Dark mode support
- Mobile responsive design (fixed positions on mobile)

## Implementation Details

### Ad Block Data Structure
```typescript
interface AdBlock {
  id: string;
  type: 'banner' | 'square' | 'video';
  position: { x: number; y: number };
  size: { width: number; height: number };
  minimized: boolean;
  zIndex: number;
  content: {
    imageUrl: string;
    title: string;
  };
}
```

### Local Storage Schema
```typescript
interface AdLayerState {
  blocks: AdBlock[];
  isEditMode: boolean;
  showGrid: boolean;
  isPanelOpen: boolean;
  lastSaved: string;
}
```

### Mock Ad Content
- Banner ads: "Special Offer", "New Product", "Limited Time"
- Square ads: "Featured Item", "Trending Now", "Hot Deal"
- Video ads: "Watch Now", "Video Ad", "Featured Content"
- Use placeholder.com API for images with text overlay

### User Interactions
1. **Adding Ads**: Click "Add Banner/Square/Video" in panel
2. **Dragging**: Click and hold to drag, release to drop
3. **Minimizing**: Click minimize button on ad block
4. **Removing**: Click X button (with confirmation)
5. **Resetting**: One-click reset to default layout

### Visual Design
- Semi-transparent background for ad layer during edit mode
- Blue outline for draggable areas
- Red zones for collision detection
- Green zones for valid drop areas
- Smooth transitions (200ms) for all movements

## File Structure
```
src/components/Ads/AdLayerMockup/
├── AdLayerMockup.tsx           # Main container
├── DraggableAdBlock.tsx        # Draggable wrapper
├── AdManagementPanel.tsx       # Settings panel
├── AdControlButton.tsx         # Floating trigger
├── GridOverlay.tsx            # Snap grid visual
├── components/
│   ├── AdContent.tsx          # Renders ad content
│   ├── MinimizedAdBar.tsx     # Minimized state UI
│   └── AdBlockControls.tsx    # Min/close buttons
├── hooks/
│   ├── useAdLayerStore.ts     # Zustand store
│   ├── useLocalStorage.ts     # localStorage sync
│   └── useCollisionDetection.ts # Collision logic
├── utils/
│   ├── mockAdData.ts          # Generate fake ads
│   ├── gridSnapping.ts        # Snap calculations
│   └── constants.ts           # Sizes, defaults
└── types.ts                   # TypeScript types
```

## Demo Page Setup
Create a demo page at `/pages/demo/ad-layer.tsx` that:
1. Shows a typical Civitai page layout
2. Overlays the ad layer mockup
3. Includes instructions for users
4. Has preset scenarios (mobile, desktop, member view)

## Dependencies to Add
```json
{
  "react-draggable": "^4.4.6",
  "zustand": "^4.4.7",
  "clsx": "^2.1.0"
}
```

## Success Criteria
- [ ] Users can drag ads anywhere on screen
- [ ] Positions persist across page refreshes
- [ ] Ads can be minimized and expanded
- [ ] New ads can be added up to a limit
- [ ] Grid snapping works smoothly
- [ ] Collision detection prevents overlaps
- [ ] Mobile view shows fixed positions
- [ ] All interactions have visual feedback
- [ ] Dark mode is fully supported
- [ ] Performance is smooth (60 FPS during drags)

## Next Steps
1. Install required dependencies
2. Create base component structure
3. Implement basic dragging functionality
4. Add management panel
5. Implement persistence
6. Polish with animations
7. Create demo page
8. Test on various screen sizes