# User-Managed Ads UI Design

## User Experience Flow

### First-Time User Experience

1. **Initial Load**
   - User sees 2-3 default ad blocks in predefined positions
   - Subtle animation draws attention to "Customize Ads" button
   - Tooltip: "You can move these ads anywhere you want!"

2. **Discovery**
   - Hovering over ad blocks shows drag cursor
   - First drag triggers brief tutorial overlay
   - Shows available actions: drag, minimize, reset

### Ad Management Interface

## Component Designs

### 1. Ad Control Button (Fixed Position)
```
┌─────────────────────────┐
│ 🎯 Manage Ads (3 active)│  <- Floating button, bottom-right
└─────────────────────────┘
```

**States:**
- Default: Semi-transparent background
- Hover: Full opacity, slight scale
- Active: Highlighted border
- Members: Green accent "Optional Ads Available"

### 2. Ad Management Panel (Modal/Sidebar)
```
┌──────────────────────────────────────┐
│ Ad Layout Manager                  X │
├──────────────────────────────────────┤
│ Active Ad Blocks (3/3)               │
│                                       │
│ ┌─────────────────┐                  │
│ │ □ Banner Ad     │ [Minimize] [×]   │
│ │   Position: Top │                  │
│ └─────────────────┘                  │
│                                       │
│ ┌─────────────────┐                  │
│ │ □ Square Ad     │ [Minimize] [×]   │
│ │   Position: Right│                  │
│ └─────────────────┘                  │
│                                       │
│ ┌─────────────────┐                  │
│ │ □ Video Ad      │ [Minimize] [×]   │
│ │   Position: Left │                  │
│ └─────────────────┘                  │
│                                       │
│ ─────────────────────────────────     │
│                                       │
│ Add Optional Ads (Members Only)      │
│ [+ Add Banner] [+ Add Square]        │
│                                       │
│ ─────────────────────────────────     │
│                                       │
│ Quick Actions:                       │
│ [Reset Layout] [Save Preferences]    │
│                                       │
│ □ Lock positions (prevent dragging)  │
│ □ Auto-hide minimized after 5s       │
└──────────────────────────────────────┘
```

### 3. Draggable Ad Block Design
```
┌─────────────────────────────┐
│ ≡  [Sponsored]          [−] │ <- Drag handle, label, minimize
├─────────────────────────────┤
│                              │
│     Ad Content Here         │
│                              │
└─────────────────────────────┘

Minimized State:
┌────────────┐
│ Ad [+]     │ <- Compact bar with expand button
└────────────┘
```

### 4. Edit Mode Overlay
When entering "Edit Ad Layout" mode:
```
┌─────────────────────────────────────────┐
│                                         │
│  ┌──────────┐     Grid overlay         │
│  │ Ad Block │     appears with         │
│  │ [Drag me]│     10px snapping        │
│  └──────────┘                          │
│                                         │
│         ┌──────────┐                   │
│         │ Ad Block │                   │
│         │ [Drag me]│                   │
│         └──────────┘                   │
│                                         │
│ [Exit Edit Mode] [Save Layout]         │
└─────────────────────────────────────────┘
```

## Interaction Patterns

### Drag and Drop
1. **Drag Start**
   - Ad block lifts with shadow
   - Other content dims slightly
   - Grid lines appear for alignment

2. **During Drag**
   - Collision zones highlighted in red
   - Valid drop zones in green
   - Snap indicators when near grid points

3. **Drop**
   - Smooth animation to snapped position
   - Save position to local state
   - Debounced save to server (2s delay)

### Mobile Experience

#### Bottom Sheet Design
```
┌─────────────────────────────┐
│        ═══════              │ <- Swipe indicator
│      Ad Settings            │
├─────────────────────────────┤
│                             │
│ Your Ads (Required: 2)      │
│                             │
│ [Banner Ad] [ON/OFF]        │
│ Position: Bottom            │
│                             │
│ [Square Ad] [ON/OFF]        │
│ Position: Top               │
│                             │
│ [+ Add Optional Ad]         │
│                             │
└─────────────────────────────┘
```

## Visual Indicators

### Ad Block States
- **Active**: Normal appearance with subtle border
- **Dragging**: Elevated shadow, 0.9 opacity
- **Minimized**: Compact bar, muted colors
- **Loading**: Skeleton animation
- **Error**: Red border with retry button

### User Feedback
- **Position Saved**: Green checkmark animation
- **Invalid Position**: Red shake animation
- **Network Error**: Toast notification
- **Tutorial Tips**: Blue pulsing dots on first use

## Accessibility Features

1. **Keyboard Navigation**
   - Tab through ad blocks
   - Arrow keys to move (10px increments)
   - Shift+Arrows for fine movement (1px)
   - Enter to toggle minimize
   - Delete to remove (optional ads only)

2. **Screen Reader Support**
   - Announce ad block positions
   - Describe available actions
   - Confirm position changes

3. **High Contrast Mode**
   - Strong borders on ad blocks
   - Clear focus indicators
   - Improved drag handle visibility

## User Preferences Storage

### Local Storage (Immediate)
```javascript
{
  adLayout: {
    version: 1,
    blocks: [
      {
        id: 'ad_1',
        type: 'banner',
        position: { x: 100, y: 200 },
        minimized: false,
        lastUpdated: '2024-01-01T00:00:00Z'
      }
    ],
    locked: false,
    editMode: false
  }
}
```

### Database (Synced)
- Save after 2 seconds of inactivity
- Sync across devices for logged-in users
- Fall back to defaults on error

## Implementation Components

### React Components Structure
```
AdLayer/
├── AdLayer.tsx              // Main container
├── AdControlButton.tsx      // Floating control button
├── AdManagementPanel.tsx    // Settings modal/sidebar
├── DraggableAdBlock.tsx     // Individual ad wrapper
├── AdBlockList.tsx          // List in management panel
├── AdLayoutGrid.tsx         // Grid overlay for edit mode
├── MobileAdManager.tsx      // Mobile-specific UI
└── hooks/
    ├── useAdDrag.ts         // Drag logic
    ├── useAdCollision.ts    // Collision detection
    └── useAdPersistence.ts  // Save/load positions
```

## Animation Specifications

### Transitions
- **Drag Start**: 150ms ease-out scale(1.05)
- **Position Change**: 200ms ease-in-out
- **Minimize/Expand**: 300ms ease-in-out
- **Panel Open/Close**: 250ms slide + fade

### Micro-interactions
- **Hover Ad Block**: Subtle lift (translateY(-2px))
- **Click Feedback**: Quick scale(0.98) → scale(1)
- **Save Success**: Checkmark fade-in 400ms
- **Grid Snap**: Haptic feedback on mobile

## Color Scheme
```css
/* Light Mode */
--ad-border: #e5e7eb;
--ad-bg: #ffffff;
--ad-handle: #6b7280;
--ad-minimize: #3b82f6;
--drag-valid: #10b981;
--drag-invalid: #ef4444;

/* Dark Mode */
--ad-border: #374151;
--ad-bg: #1f2937;
--ad-handle: #9ca3af;
--ad-minimize: #60a5fa;
--drag-valid: #34d399;
--drag-invalid: #f87171;
```

## Member Benefits UI

### Free Users
- Badge: "2 Required Ads"
- Cannot remove default ads
- Can reposition anywhere
- Access to basic layouts

### Paid Members
- Badge: "Ad-Free Member"
- Option to enable revenue-sharing ads
- Green accent on optional ads
- "Support Civitai" toggle with explanation

## Error Handling UI

1. **Connection Lost**
   - Banner: "Changes saved locally, will sync when online"
   
2. **Invalid Position**
   - Toast: "Ad cannot be placed there"
   - Auto-return to previous position

3. **Save Failed**
   - Modal: "Failed to save layout [Retry] [Dismiss]"
   - Keep local changes intact

## Success Metrics UI

Dashboard for users to see:
- "Your ad layout is 95% less annoying!"
- "You've moved ads 12 times"
- "Preferred position: Top-right"