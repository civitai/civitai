**Ad System Redesign Proposal**

**Current Issues**: Our existing in-feed and image detail ads are underperforming due to poor viewability and impression quality.

**Proposed Solution**: Replace current ad placements with user-controlled, draggable ad blocks on a dedicated ad layer.

**Technical Implementation**:
- Create an absolute-positioned ad layer (z-index: 9999) over the main UI
- Users can spawn ad blocks (banner/square/video formats) and drag them anywhere on screen
- Position data persisted per-user/device in database
- Ad refresh on 60-90 second intervals instead of loading new ads on scroll
- Free users: 2-3 required ad blocks (with repositioning rights)
- Paid users: Optional ad blocks for additional revenue

**Key Benefits**:
- 100% viewability for all ad impressions
- Higher CPMs due to guaranteed view time
- Users control placement = reduced ad blindness/frustration
- Simplified ad operations (fixed slots vs dynamic insertion)
- Unique differentiator: "You control where ads appear"

**Technical Considerations**:
- Implement collision detection between ad blocks
- Constrain dragging to viewport bounds
- Grid snapping for cleaner layouts (10px grid)
- Different positioning strategy for mobile (possibly fixed positions)
- Include minimize/expand functionality
- "Reset layout" option for recovery

**Expected Outcome**: Higher revenue through better CPMs despite potentially fewer total impressions, plus improved user satisfaction through control over their ad experience.

## Actions
Please review the current implementation of ads to identify how ads are placed and all of the locations that will need to be modified if we were to take out the current ad system. Then, prepare a plan for implementing this ad layer as described here, along with the ability for users to spawn ad blocks. Additionally, look for how user ad settings are managed so that we can make it so that paid users can optionally turn on or off those blocks. Then, plan a simple UI experience that allows users to easily manage adding and removing ad blocks.
