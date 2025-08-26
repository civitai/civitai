# Page-Specific Ad Layout Overrides - Implementation Plan

## Overview
Enable users to customize ad placements differently for various page types/routes, allowing optimal ad positioning based on page layout and content type. Users can save different configurations for feeds, detail pages, and other routes, or completely hide ads on specific pages.

## Core Requirements

### 1. Route Pattern Matching
- Support for exact path matching (`/models`)
- Support for dynamic route patterns (`/models/[id]`, `/images/[id]`)
- Support for wildcard patterns (`/user/*`)
- Priority system for overlapping patterns (most specific wins)

### 2. Layout Configuration Per Route
- Independent ad block positions for each route pattern
- Option to hide/show ad layer entirely per route
- Inherit from default layout when no override exists
- Quick switching between layouts when navigating

### 3. User Experience
- Visual indicator showing which layout is active
- Easy way to save current layout for current route
- Ability to manage saved layouts from settings panel
- Preview different layouts without navigation

## Technical Architecture

### Data Structure

```typescript
interface RouteLayout {
  id: string;
  name: string; // User-friendly name like "Model Details" 
  routePattern: string; // e.g., "/models/[id]"
  priority: number; // For resolving conflicts (higher = more specific)
  enabled: boolean; // Whether ads show on this route
  blocks: AdBlock[]; // Ad configuration for this route
  createdAt: number;
  updatedAt: number;
}

interface AdLayerState {
  // Existing fields...
  blocks: AdBlock[]; // Default/current layout
  
  // New fields for route-specific layouts
  routeLayouts: RouteLayout[];
  activeLayoutId: string | null; // Currently active layout
  currentRoute: string; // Current page route
}
```

### Route Pattern Matching System

```typescript
// Priority levels (higher number = higher priority)
const ROUTE_PRIORITY = {
  EXACT: 1000,        // /models
  DYNAMIC: 100,       // /models/[id]
  NESTED_DYNAMIC: 50, // /models/[id]/edit
  WILDCARD: 10,       // /models/*
  DEFAULT: 0,         // Fallback
};

function matchRoute(currentPath: string, patterns: RouteLayout[]): RouteLayout | null {
  // Sort by priority (highest first)
  const sorted = patterns.sort((a, b) => b.priority - a.priority);
  
  for (const layout of sorted) {
    if (matchesPattern(currentPath, layout.routePattern)) {
      return layout;
    }
  }
  
  return null; // Use default layout
}

function matchesPattern(path: string, pattern: string): boolean {
  // Convert route pattern to regex
  // /models/[id] => /models/([^/]+)
  // /user/* => /user/.*
  const regex = pattern
    .replace(/\[([^\]]+)\]/g, '([^/]+)') // Dynamic segments
    .replace(/\*/g, '.*') // Wildcards
    .replace(/\//g, '\\/'); // Escape slashes
    
  return new RegExp(`^${regex}$`).test(path);
}
```

## Implementation Phases

### Phase 1: Core Route Detection & Storage
1. **Route Detection Hook**
   ```typescript
   // hooks/useRouteLayout.ts
   export function useRouteLayout() {
     const router = useRouter();
     const { routeLayouts, setActiveLayout } = useAdLayerStore();
     
     useEffect(() => {
       const matched = matchRoute(router.pathname, routeLayouts);
       setActiveLayout(matched?.id || null);
     }, [router.pathname]);
   }
   ```

2. **Extended Store**
   ```typescript
   // Add to useAdLayerStore.ts
   interface AdLayerStore {
     // New methods
     saveLayoutForRoute: (pattern: string, name: string) => void;
     deleteRouteLayout: (id: string) => void;
     updateRouteLayout: (id: string, updates: Partial<RouteLayout>) => void;
     setActiveLayout: (layoutId: string | null) => void;
     applyLayout: (layout: RouteLayout) => void;
   }
   ```

3. **Persistence Updates**
   - Store route layouts in localStorage separately
   - Key: `ad-layer-route-layouts`
   - Migrate existing data to support new structure

### Phase 2: UI Components

1. **Route Layout Indicator**
   ```tsx
   // Show current active layout in manager panel
   <Alert icon={<IconRoute />} variant="light">
     Active Layout: {activeLayout?.name || 'Default'}
     <Text size="xs" c="dimmed">
       Route: {currentRoute}
     </Text>
   </Alert>
   ```

2. **Save Current Layout Dialog**
   ```tsx
   // Quick save button in edit mode
   <Button onClick={openSaveDialog}>
     Save Layout for This Page
   </Button>
   
   // Dialog for saving
   <Modal title="Save Layout for Route">
     <TextInput 
       label="Layout Name" 
       placeholder="e.g., Model Details Page"
     />
     <Select
       label="Route Pattern"
       data={[
         { value: router.pathname, label: `Exact: ${router.pathname}` },
         { value: getDynamicPattern(router.pathname), label: `Pattern: ${pattern}` },
         { value: getWildcardPattern(router.pathname), label: `Wildcard: ${wildcard}` },
       ]}
     />
   </Modal>
   ```

3. **Layout Management Panel**
   ```tsx
   // New tab in AdManager component
   <Tabs.Panel value="layouts">
     <Stack>
       {routeLayouts.map(layout => (
         <Card key={layout.id}>
           <Group justify="space-between">
             <div>
               <Text fw={600}>{layout.name}</Text>
               <Text size="xs" c="dimmed">
                 Pattern: {layout.routePattern}
               </Text>
               <Badge>{layout.blocks.length} ads</Badge>
             </div>
             <Group>
               <ActionIcon onClick={() => applyLayout(layout)}>
                 <IconEye />
               </ActionIcon>
               <ActionIcon onClick={() => editLayout(layout)}>
                 <IconEdit />
               </ActionIcon>
               <ActionIcon color="red" onClick={() => deleteLayout(layout.id)}>
                 <IconTrash />
               </ActionIcon>
             </Group>
           </Group>
         </Card>
       ))}
     </Stack>
   </Tabs.Panel>
   ```

### Phase 3: Advanced Features

1. **Layout Templates**
   - Predefined layouts for common page types
   - "Feed Layout" - optimized for grid views
   - "Article Layout" - sidebar and inline positions
   - "Gallery Layout" - minimal, corner positions

2. **Bulk Operations**
   - Copy layout to multiple routes
   - Export/import layout configurations
   - Reset all routes to default

3. **Smart Suggestions**
   - Detect page type automatically
   - Suggest optimal ad positions based on content
   - A/B testing different layouts

## User Workflow

### Creating a Route-Specific Layout

1. **Navigate to target page** (e.g., `/models/123`)
2. **Open ad manager** (Ctrl+M)
3. **Enable edit mode** and position ads optimally
4. **Click "Save for This Page"**
5. **Choose route pattern**:
   - Exact: `/models/123` (only this page)
   - Dynamic: `/models/[id]` (all model detail pages)
   - Wildcard: `/models/*` (all model pages)
6. **Name the layout** (e.g., "Model Details")
7. **Save**

### Managing Layouts

1. **Open ad manager**
2. **Go to "Layouts" tab**
3. **View all saved layouts** with their patterns
4. **Actions available**:
   - Preview (temporarily apply)
   - Edit (modify positions)
   - Duplicate (create variant)
   - Delete (remove layout)
   - Toggle enabled/disabled

### Route Navigation Behavior

When user navigates to a new page:
1. System checks current route against saved patterns
2. Finds highest priority matching layout
3. Smoothly transitions ad positions (with animation)
4. Shows indicator of active layout
5. Falls back to default if no match

## Configuration Examples

```javascript
// Example saved configurations
const exampleLayouts = [
  {
    name: "Homepage",
    routePattern: "/",
    priority: 1000,
    enabled: true,
    blocks: [
      // Large banner at top
      { type: 'banner', position: { fromTop: 100, fromLeft: 'center' } },
      // Square in sidebar
      { type: 'square', position: { fromRight: 20, fromTop: 200 } },
    ]
  },
  {
    name: "Model Details",
    routePattern: "/models/[id]",
    priority: 100,
    enabled: true,
    blocks: [
      // Floating square bottom-right
      { type: 'square', position: { fromBottom: 20, fromRight: 20 } },
      // Banner below header
      { type: 'banner', position: { fromTop: 80, fromLeft: 'center' } },
    ]
  },
  {
    name: "Image Feeds",
    routePattern: "/images",
    priority: 1000,
    enabled: true,
    blocks: [
      // Multiple squares in corners
      { type: 'square', position: { fromTop: 20, fromLeft: 20 } },
      { type: 'square', position: { fromBottom: 20, fromRight: 20 } },
    ]
  },
  {
    name: "User Profiles",
    routePattern: "/user/*",
    priority: 10,
    enabled: false, // No ads on user profiles
    blocks: []
  }
];
```

## Benefits

### For Users
- **Optimal viewing experience** per page type
- **Reduce ad interference** on specific pages
- **Personalized layouts** for different content
- **Quick switching** between configurations
- **Full control** over where ads appear

### For Publishers
- **Higher engagement** with context-aware placement
- **Better viewability** on different page layouts
- **Increased CPM** from optimal positioning
- **User satisfaction** from less intrusive ads

## Technical Considerations

### Performance
- Layouts cached in memory after first load
- Smooth CSS transitions between layouts
- Debounced route change detection
- Lazy load layout configurations

### Storage
- localStorage limit considerations (5-10MB)
- Compress layout data if needed
- Option to sync with server (future)
- Export/import for backup

### Edge Cases
- Handle deleted routes gracefully
- Validate patterns before saving
- Prevent circular dependencies
- Handle layout conflicts

## Future Enhancements

1. **Server Sync**
   - Save layouts to user account
   - Sync across devices
   - Share layouts with others

2. **Analytics Integration**
   - Track performance per layout
   - Auto-optimize based on engagement
   - A/B test different configurations

3. **Smart Defaults**
   - ML-based position suggestions
   - Auto-detect optimal positions
   - Crowd-sourced best practices

4. **Advanced Patterns**
   - Query parameter matching
   - Time-based layouts
   - Device-specific layouts
   - User role-based layouts

## Implementation Timeline

- **Week 1**: Core route detection and storage
- **Week 2**: UI for saving/managing layouts
- **Week 3**: Layout switching and animations
- **Week 4**: Testing and edge cases
- **Week 5**: Advanced features and polish

## Success Metrics

- User adoption rate of custom layouts
- Average number of layouts per user
- Reduction in ad-blocking attempts
- Increase in ad viewability
- User satisfaction scores
- CPM improvements per layout type