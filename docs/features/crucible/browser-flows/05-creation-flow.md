# Crucible Creation Page Flow

**Tested**: 2026-01-17
**URL**: http://localhost:3000/crucibles/create
**Profile**: member

## Summary

This flow documents the 4-step crucible creation wizard, including all form fields, options, and cost breakdowns.

## Screenshots

| Step | Description | Screenshot |
|------|-------------|------------|
| Step 1 | Basic Info - Cover image & title | [05-01-step1-basic-info.png](screenshots/05-01-step1-basic-info.png) |
| Step 1 | Duration & content level options | [05-02-step1-duration-content.png](screenshots/05-02-step1-duration-content.png) |
| Step 2 | Entry Rules | [05-03-step2-entry-rules.png](screenshots/05-03-step2-entry-rules.png) |
| Step 3 | Prize Distribution | [05-04-step3-prizes.png](screenshots/05-04-step3-prizes.png) |
| Step 3 | Prize Customization UI | [05-05-step3-prize-customization.png](screenshots/05-05-step3-prize-customization.png) |
| Step 4 | Review (top) | [05-06-step4-review.png](screenshots/05-06-step4-review.png) |
| Step 4 | Review (full) | [05-07-step4-review-full.png](screenshots/05-07-step4-review-full.png) |

## Step-by-Step Flow

### Step 1: Basic Info

**Elements captured:**
- Page header: "Create Crucible - Set up a new creative competition"
- Stepper showing: Step 1 Basic Info, Step 2 Entry Rules, Step 3 Prizes, Step 4 Review
- Cover Image upload zone (16:9 aspect ratio recommended)
  - Accepts: .png, .jpeg, .webp
  - Max size: 50 MB
  - Supports up to 10 files
- Crucible Name input (required, max 100 characters)
- Description textarea (optional, max 500 characters)
- **Duration options with Buzz costs:**
  - 8 hours: FREE (default)
  - 24 hours: +500 Buzz
  - 3 days: +1,000 Buzz
  - 7 days: +2,000 Buzz
- **Allowed Content Levels:** PG (default), PG-13, R, X, XXX
- Preview card showing: Name, Entry count, Duration, Entries count
- Cost Breakdown sidebar

**Reproduction steps:**
1. Navigate to `/crucibles/create`
2. Screenshot shows initial state with empty form
3. Scroll to 400px to see duration and content level options

### Step 2: Entry Rules

**Elements captured:**
- Section header: "Entry Rules"
- **Entry Fee per User** (default: 100 Buzz)
  - Input field with lightning bolt icon
  - "100 Buzz entry fee" helper text
- **Entry Limit per User** (required)
  - Dropdown: 1 entry, 2 entries, 3 entries, 5 entries, 10 entries
  - Default: 1 entry
- **Maximum Total Entries** (optional)
  - Placeholder: "No limit"
- **Resource Requirements** (Premium feature)
  - Search field: "Search models, LoRAs..."
  - Note: "Require specific models or LoRAs for entries"
- Previous/Next navigation buttons

**Reproduction steps:**
1. Complete Step 1 with cover image and name
2. Click "Next" button
3. Screenshot at scroll position 0

### Step 3: Prizes

**Elements captured:**
- Section header: "Prizes" with trophy icon
- **Default Distribution** visualization bar:
  - 1st: 50% (blue)
  - 2nd: 30% (green)
  - 3rd: 20% (yellow)
- Prize cards showing individual percentages
- **"Customize Distribution"** button (+1,000 Buzz)

**Prize Customization UI (when expanded):**
- "Editing Prize Distribution" header
- Slider controls for each position:
  - 1st Place slider (blue)
  - 2nd Place slider (green)
  - 3rd Place slider (yellow)
- "+ Add Prize Position" button
- "Total Distribution: 100%" indicator
- "Reset to Default" button
- "Done Editing" button
- Cost updates to show +1,000 Buzz for customization

**Reproduction steps:**
1. Complete Steps 1-2
2. Click "Next" button
3. Screenshot shows default distribution
4. Click "Customize Distribution" to see slider UI

### Step 4: Review

**Elements captured:**
- Section header: "Review Your Crucible"
- **Estimated Schedule:**
  - Starts: Date/time (Immediately)
  - Ends: Date/time (based on duration)
- **Basic Information:**
  - Name
  - Duration
  - Description (or "None")
- **Entry Settings:**
  - Entry Fee (with Buzz badge)
  - Entry Limit per User
  - Max Total Entries
- **Prize Distribution:**
  - 1st Place: 50%
  - 2nd Place: 30%
  - 3rd Place: 20%
- **Preview card** with cover image
- **"Create Crucible - [Cost]"** button (yellow/gold)
  - Shows "Free" when using defaults
  - Shows Buzz cost when premium options selected
- **Cost Breakdown** sidebar showing itemized costs

**Reproduction steps:**
1. Complete Steps 1-3
2. Click "Next" button
3. Scroll through to see all review sections

## Cost Breakdown

The sidebar shows real-time cost calculations:

| Feature | Free Option | Paid Option |
|---------|-------------|-------------|
| Duration | 8 hours | 24h (+500), 3d (+1,000), 7d (+2,000) |
| Entry Limit | Standard limits | - |
| Prize Customization | Default 50/30/20 | Custom (+1,000 Buzz) |

## Notes

- Cover image and Crucible Name are required to proceed from Step 1
- Next button remains disabled until required fields are completed
- Preview card updates in real-time as form is filled
- All costs are in Buzz currency
- The creation process can be cancelled at any time without creating the crucible
- Stepper tabs are not directly clickable - use Previous/Next buttons to navigate
