# UX Design: AI Comic Creator

**Product:** Civitai Comics
**Version:** 1.0
**Last Updated:** January 2026

---

## Table of Contents

1. [Research & Discovery](#1-research--discovery)
2. [Information Architecture](#2-information-architecture)
3. [User Flows](#3-user-flows)
4. [Screen Specifications](#4-screen-specifications)
5. [Interaction Patterns](#5-interaction-patterns)
6. [UX Writing](#6-ux-writing)
7. [Accessibility](#7-accessibility)
8. [Mobile Strategy](#8-mobile-strategy)
9. [Validation Plan](#9-validation-plan)
10. [Hackathon MVP Scope](#10-hackathon-mvp-scope)

---

## 1. Research & Discovery

### 1.1 User Personas

#### Persona 1: Maya - The Writer Who Can't Draw

```
Demographics:
- Age: 28
- Occupation: Aspiring novelist, works in marketing
- Technical Level: Moderate (uses Canva, basic photo editing)
- AI Experience: Has tried Midjourney, frustrated by inconsistency

Goals:
- Visualize the stories in her head
- Create a webcomic to build audience for her writing
- Maintain character consistency (her biggest frustration)

Frustrations:
- "I can see my characters so clearly, but AI gives me different people every time"
- "I spend hours trying to get the same character twice"
- "The backgrounds never match my character's art style"

Quote:
"I just want to tell my story. I shouldn't need to be an artist OR a prompt engineer."

Usage Context:
- Works on comic in evenings and weekends
- Uses laptop at home
- Sessions: 1-2 hours, 2-3x per week
```

#### Persona 2: Kenji - The Indie Webtoon Publisher

```
Demographics:
- Age: 34
- Occupation: Part-time webtoon creator, full-time teacher
- Technical Level: High (uses Clip Studio Paint, Photoshop)
- AI Experience: Uses AI for backgrounds, skeptical of character AI

Goals:
- Speed up production (currently 15-20 hours per episode)
- Maintain quality while increasing output
- Keep his distinctive style

Frustrations:
- "AI backgrounds look good but never match my character style"
- "I lose so much time on backgrounds and establishing shots"
- "Character consistency tools are gimmicks - they don't actually work"

Quote:
"If it can give me 80% quality at 20% of the time, I'll take it.
But 50% quality is worthless - my readers will notice."

Usage Context:
- Integrates into existing workflow (may export to Clip Studio for polish)
- Works on desktop with drawing tablet
- Sessions: 4-6 hours, focused production days
```

#### Persona 3: Alex - The First-Time Creator

```
Demographics:
- Age: 19
- Occupation: College student, anime fan
- Technical Level: Low (uses phone mostly, some laptop)
- AI Experience: Uses free AI generators, shares on social media

Goals:
- Create fan comics and original characters
- Share on social media, get reactions
- Have fun, not create professional work

Frustrations:
- "The good AI tools are too expensive or complicated"
- "I just want something quick and easy"
- "My character never looks the same twice"

Quote:
"I don't need perfect. I need good enough to post and not embarrass myself."

Usage Context:
- Mobile-first (wants to create on phone)
- Short sessions (15-30 min)
- Shares directly to social media
```

### 1.2 Jobs-to-be-Done (JTBD)

#### Primary Jobs

| Job | Importance | Frequency | Current Solutions | Satisfaction |
|-----|------------|-----------|-------------------|--------------|
| **Create consistent character across panels** | CRITICAL | Every session | Manual redrawing, praying | Very Low |
| **Generate backgrounds matching my style** | HIGH | Every panel | Style transfer, manual | Low |
| **Tell my story visually** | HIGH | Every session | Existing tools, drawing | Medium |
| **Save time on production** | HIGH | Every session | Templates, AI assist | Medium |
| **Export for publishing** | MEDIUM | End of chapter | Manual export | High |

#### Job Stories

```
1. Character Consistency (Primary)
When I've designed a character I love,
I want to generate them in any pose or expression,
So I can tell stories without them looking like different people.

2. Style Matching (Primary)
When I have art in a specific style,
I want backgrounds and environments to match automatically,
So I don't have jarring style clashes in my panels.

3. Quick Panel Creation
When I know what scene I want,
I want to describe it and get a panel instantly,
So I can focus on storytelling, not technical art skills.

4. Scene Consistency
When a scene takes place in one location,
I want that location to look the same across panels,
So readers don't get confused about where characters are.

5. Production Efficiency
When I'm creating multiple panels,
I want to batch-generate and iterate quickly,
So I can publish chapters faster.
```

### 1.3 Competitive UX Analysis

| Product | Character Consistency | Learning Curve | Speed | Style Control |
|---------|----------------------|----------------|-------|---------------|
| Midjourney | None (manual workarounds) | Steep | Fast | Good |
| Anifusion | Partial | Medium | Medium | Limited |
| Dashtoon | Good | Low | Medium | Limited |
| Clip Studio + AI | Manual | Steep | Slow | Full |
| **Civitai Comics (Goal)** | **Excellent** | **Low** | **Fast** | **Excellent** |

#### UX Opportunities from Competitors

1. **Midjourney**: Great quality, but requires prompt engineering expertise. We simplify.
2. **Anifusion**: Good UI, but character consistency fails. We solve the core problem.
3. **Dashtoon**: Easy to use, but limited styles. We offer variety via LoRAs.
4. **Manual workflows**: Full control, but slow. We automate the tedious parts.

---

## 2. Information Architecture

### 2.1 App Structure

```
comics.civitai.com
│
├── Landing / Marketing
│   ├── Features
│   ├── Pricing
│   ├── Examples
│   └── Sign In (→ Civitai SSO)
│
├── Dashboard (authenticated)
│   ├── My Projects
│   │   ├── Project Card → Open Project
│   │   └── [+ New Project]
│   ├── Recent Activity
│   └── Quick Actions
│
├── Project Workspace
│   ├── Characters (left panel)
│   │   ├── Character cards
│   │   └── [+ Add Character]
│   ├── Canvas (center)
│   │   ├── Page/Panel view
│   │   └── Generation interface
│   ├── Locations (expandable)
│   │   ├── Saved locations
│   │   └── [+ Add Location]
│   └── Styles (expandable)
│       ├── Project style
│       └── [Import Style]
│
├── Character Setup (modal flow)
│   ├── Upload References
│   ├── Processing
│   ├── Review Anchors
│   └── Confirm
│
├── Panel Generator (in-canvas)
│   ├── Character selector
│   ├── Location selector
│   ├── Description input
│   ├── Options (style, camera, etc.)
│   └── Results
│
├── Export
│   ├── Page/Chapter selection
│   ├── Format options
│   └── Download/Publish
│
└── Settings
    ├── Account (→ Civitai)
    ├── Preferences
    └── Buzz Balance
```

### 2.2 Navigation Model

```
Primary Navigation: Dashboard ↔ Project Workspace ↔ Export

Within Project Workspace:
┌─────────────────────────────────────────────────────────────┐
│  [← Dashboard]  Project Name ▼        [Export] [Settings]   │
├──────────┬──────────────────────────────────────────────────┤
│          │                                                  │
│ ASSETS   │              CANVAS                              │
│          │                                                  │
│ ☐ Chars  │   ┌──────┐ ┌──────┐ ┌──────┐                   │
│   • Char1│   │Panel │ │Panel │ │Panel │                   │
│   • Char2│   │  1   │ │  2   │ │  3   │                   │
│   + Add  │   └──────┘ └──────┘ └──────┘                   │
│          │                                                  │
│ ☐ Locs   │   [+ Add Panel]                                 │
│   • Loc1 │                                                  │
│   + Add  │                                                  │
│          │──────────────────────────────────────────────────│
│ ☐ Style  │              GENERATION                          │
│   Import │   [Generate Panel interface when active]         │
│          │                                                  │
└──────────┴──────────────────────────────────────────────────┘

Collapsible sections for assets
Canvas is always visible
Generation appears contextually
```

### 2.3 Navigation Principles

1. **One workspace, contextual tools**: Don't make users navigate to different pages for character setup, generation, etc. Everything happens in the project workspace.

2. **Assets persist**: Characters, locations, styles are always visible/accessible in left panel.

3. **Canvas-centric**: The comic is always visible. Generation is a tool, not a destination.

4. **Progressive disclosure**: Basic users see simple interface. Power users can expand panels for advanced options.

---

## 3. User Flows

### 3.1 New User: First Comic

```
Flow: First-Time User Creates First Comic Panel

Trigger: User lands on comics.civitai.com for first time

┌─────────────┐
│  Landing    │
│   Page      │
└──────┬──────┘
       │ Click "Start Creating"
       ▼
┌─────────────┐     ┌─────────────┐
│ Civitai SSO │────►│  Onboarding │
│   Login     │     │   (if new)  │
└─────────────┘     └──────┬──────┘
                           │ "Create your first project"
                           ▼
                   ┌─────────────┐
                   │   Name      │
                   │   Project   │
                   └──────┬──────┘
                          │
                          ▼
                   ┌─────────────┐
                   │   Style     │
                   │  Selection  │
                   │ (optional)  │
                   └──────┬──────┘
                          │
                          ▼
          ┌───────────────────────────────┐
          │      CHARACTER SETUP          │
          │  (Guided - most critical)     │
          │                               │
          │  1. Upload 3-5 images         │
          │  2. Wait for processing       │
          │  3. Review anchor poses       │
          │  4. Approve character         │
          │                               │
          └───────────────┬───────────────┘
                          │
                          ▼
          ┌───────────────────────────────┐
          │      FIRST PANEL              │
          │  (Guided generation)          │
          │                               │
          │  1. Pre-filled description    │
          │  2. Click Generate            │
          │  3. See result                │
          │  4. 🎉 Success moment!        │
          │                               │
          └───────────────┬───────────────┘
                          │
                          ▼
          ┌───────────────────────────────┐
          │      PROJECT WORKSPACE        │
          │  (Full interface, unguided)   │
          └───────────────────────────────┘

Key UX Decisions:
- SSO is seamless (user may already be logged into Civitai)
- Character setup is REQUIRED before first panel (enforced)
- First panel is guided to ensure success
- Onboarding is short: we get them to "wow" moment ASAP
```

### 3.2 Character Setup Flow (Critical)

```
Flow: Creating a Character Lock

Trigger: User clicks [+ Add Character] or guided setup

    ┌──────────────────────────────────────────────┐
    │           STEP 1: UPLOAD                      │
    │                                              │
    │   Upload 3-5 reference images                │
    │   ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐  │
    │   │  +  │ │ img │ │ img │ │ img │ │  +  │  │
    │   └─────┘ └─────┘ └─────┘ └─────┘ └─────┘  │
    │                                              │
    │   Tips:                                      │
    │   • Include front-facing view               │
    │   • Different angles help                   │
    │   • Same character, same outfit             │
    │                                              │
    │   [Continue →]  (enabled when 3+ images)    │
    └──────────────────────────────────────────────┘
                          │
                          ▼
    ┌──────────────────────────────────────────────┐
    │           STEP 2: PROCESSING                 │
    │                                              │
    │   ┌────────────────────────────────────┐    │
    │   │                                    │    │
    │   │    [Character Preview Animation]   │    │
    │   │                                    │    │
    │   └────────────────────────────────────┘    │
    │                                              │
    │   ▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░  45%                │
    │                                              │
    │   Analyzing character...                     │
    │   • Detecting face features ✓               │
    │   • Learning body proportions ●             │
    │   • Capturing outfit details                │
    │   • Generating test poses                   │
    │                                              │
    │   This takes about 30-60 seconds            │
    └──────────────────────────────────────────────┘
                          │
                          ▼
    ┌──────────────────────────────────────────────┐
    │           STEP 3: REVIEW ANCHORS            │
    │                                              │
    │   Here's your character in different poses.  │
    │   Check that they look like the same person. │
    │                                              │
    │   ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐  │
    │   │Front│ │ 3/4 │ │Side │ │Happy│ │ Sad │  │
    │   │  ✓  │ │  ✓  │ │  ✓  │ │  ?  │ │  ✓  │  │
    │   └─────┘ └─────┘ └─────┘ └─────┘ └─────┘  │
    │                   [Regenerate]              │
    │                                              │
    │   ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐  │
    │   │Angry│ │Surpr│ │Sit  │ │Run  │ │Think│  │
    │   │  ✓  │ │  ✓  │ │  ✓  │ │  ✓  │ │  ✓  │  │
    │   └─────┘ └─────┘ └─────┘ └─────┘ └─────┘  │
    │                                              │
    │   Looking good?                             │
    │   [← Back]              [Confirm Character] │
    └──────────────────────────────────────────────┘
                          │
                          ▼
    ┌──────────────────────────────────────────────┐
    │           STEP 4: NAME & SAVE               │
    │                                              │
    │   Character name: [Maya_________________]   │
    │                                              │
    │   [Save Character]                          │
    │                                              │
    │   ✓ Character locked! Ready to create.      │
    └──────────────────────────────────────────────┘

UX Considerations:
- Users can click individual anchors to regenerate just that one
- Checkmarks let users approve/flag each anchor
- Processing step shows real progress, not fake
- User doesn't leave workspace (modal or slide-over)
- Character name is last (they've earned naming it)
```

### 3.3 Panel Generation Flow

```
Flow: Generate a Comic Panel

Trigger: User clicks [+ Add Panel] or clicks empty panel slot

State: Character exists, user is in project workspace

    ┌─────────────────────────────────────────────────────────┐
    │                  PANEL GENERATOR                         │
    ├─────────────────────────────────────────────────────────┤
    │                                                          │
    │  CHARACTER                                               │
    │  ┌─────────────────────────────────────────────────────┐│
    │  │ [Maya ▼]  ┌────┐ [+ Add another character]          ││
    │  │           │ 👤 │                                     ││
    │  │           └────┘                                     ││
    │  └─────────────────────────────────────────────────────┘│
    │                                                          │
    │  LOCATION (optional)                                     │
    │  ┌─────────────────────────────────────────────────────┐│
    │  │ [None - describe in prompt ▼]                        ││
    │  │ ────────────────────────────                        ││
    │  │ • Maya's Apartment (saved)                          ││
    │  │ • City Street (saved)                               ││
    │  │ • + Create new location                             ││
    │  └─────────────────────────────────────────────────────┘│
    │                                                          │
    │  DESCRIBE THE SCENE                                      │
    │  ┌─────────────────────────────────────────────────────┐│
    │  │ Maya standing on a rooftop at sunset, wind blowing  ││
    │  │ her hair, looking determined at the horizon         ││
    │  │                                                     ││
    │  └─────────────────────────────────────────────────────┘│
    │                                                          │
    │  ▼ Advanced Options                                      │
    │  ┌─────────────────────────────────────────────────────┐│
    │  │ Pose: [Auto-detect ▼]  Camera: [Medium shot ▼]      ││
    │  │ Expression: [Based on description ▼]                 ││
    │  └─────────────────────────────────────────────────────┘│
    │                                                          │
    │  ┌───────────────────────────────────────────┐          │
    │  │        [Generate Panel]  25 Buzz          │          │
    │  └───────────────────────────────────────────┘          │
    │                                                          │
    └─────────────────────────────────────────────────────────┘
                          │
                          │ Click Generate
                          ▼
    ┌─────────────────────────────────────────────────────────┐
    │                  GENERATING...                           │
    ├─────────────────────────────────────────────────────────┤
    │                                                          │
    │        ┌─────────────────────────────────┐              │
    │        │                                 │              │
    │        │   [Animated placeholder]        │              │
    │        │   or low-res preview            │              │
    │        │                                 │              │
    │        └─────────────────────────────────┘              │
    │                                                          │
    │   Setting up scene...                                    │
    │   ▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░  65%                            │
    │                                                          │
    │   [Cancel]                                               │
    └─────────────────────────────────────────────────────────┘
                          │
                          ▼
    ┌─────────────────────────────────────────────────────────┐
    │                  RESULTS                                 │
    ├─────────────────────────────────────────────────────────┤
    │                                                          │
    │   ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐      │
    │   │  ★ 92%  │ │   88%   │ │   85%   │ │   81%   │      │
    │   │         │ │         │ │         │ │         │      │
    │   │  img 1  │ │  img 2  │ │  img 3  │ │  img 4  │      │
    │   │         │ │         │ │         │ │         │      │
    │   │ [Use]   │ │ [Use]   │ │ [Use]   │ │ [Use]   │      │
    │   └─────────┘ └─────────┘ └─────────┘ └─────────┘      │
    │                                                          │
    │   ★ = Highest consistency score                         │
    │                                                          │
    │   Not quite right?                                       │
    │   [Regenerate] [Edit Description] [Try Different Pose]   │
    │                                                          │
    └─────────────────────────────────────────────────────────┘
                          │
                          │ Click [Use] on preferred result
                          ▼
    ┌─────────────────────────────────────────────────────────┐
    │   Panel added to canvas                                  │
    │   ┌───────────────────────────────────────────────────┐ │
    │   │                                                   │ │
    │   │              [Selected panel image]               │ │
    │   │                                                   │ │
    │   └───────────────────────────────────────────────────┘ │
    │                                                          │
    │   [Edit] [Delete] [Regenerate]                          │
    └─────────────────────────────────────────────────────────┘

UX Considerations:
- Character is pre-selected if only one exists
- Location is OPTIONAL (can describe in prompt)
- Advanced options hidden by default (progressive disclosure)
- Results show consistency scores (transparency)
- Best result is highlighted automatically
- User can click any result to zoom/preview before committing
```

### 3.4 Style Setup Flow

```
Flow: Import or Select Art Style

Trigger: New project OR user wants to change style

    ┌──────────────────────────────────────────────────────┐
    │              CHOOSE YOUR STYLE                        │
    ├──────────────────────────────────────────────────────┤
    │                                                       │
    │  How do you want to set your comic's style?          │
    │                                                       │
    │  ┌────────────────────┐  ┌────────────────────┐     │
    │  │                    │  │                    │     │
    │  │  📚 Browse Styles  │  │  🎨 Import Style   │     │
    │  │                    │  │                    │     │
    │  │  Choose from 50+   │  │  Upload images     │     │
    │  │  curated styles    │  │  you like          │     │
    │  │                    │  │                    │     │
    │  └────────────────────┘  └────────────────────┘     │
    │                                                       │
    │  ┌────────────────────────────────────────────────┐  │
    │  │  💡 From Character                              │  │
    │  │  Match style to your character's art           │  │
    │  │  (Best if character refs have consistent style)│  │
    │  └────────────────────────────────────────────────┘  │
    │                                                       │
    └──────────────────────────────────────────────────────┘

Option A: Browse Styles (Simple)
    ┌──────────────────────────────────────────────────────┐
    │              BROWSE STYLES                            │
    ├──────────────────────────────────────────────────────┤
    │                                                       │
    │  Filter: [All ▼] [Manga] [Manhwa] [Western] [Other]  │
    │                                                       │
    │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐   │
    │  │ Preview │ │ Preview │ │ Preview │ │ Preview │   │
    │  │  img    │ │  img    │ │  img    │ │  img    │   │
    │  │─────────│ │─────────│ │─────────│ │─────────│   │
    │  │Soft     │ │Classic  │ │Manhwa   │ │Sketch   │   │
    │  │Anime    │ │Manga    │ │Style    │ │Style    │   │
    │  │ [Use]   │ │ [Use]   │ │ [Use]   │ │ [Use]   │   │
    │  └─────────┘ └─────────┘ └─────────┘ └─────────┘   │
    │                                                       │
    │  [More from Civitai →]                               │
    └──────────────────────────────────────────────────────┘

Option B: Import Style (Advanced)
    ┌──────────────────────────────────────────────────────┐
    │              IMPORT STYLE                             │
    ├──────────────────────────────────────────────────────┤
    │                                                       │
    │  Upload 1-5 images in the style you want             │
    │                                                       │
    │  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐           │
    │  │ img │ │ img │ │ img │ │  +  │ │     │           │
    │  └─────┘ └─────┘ └─────┘ └─────┘ └─────┘           │
    │                                                       │
    │  [Extract Style]                                     │
    │                                                       │
    │  ↓ After extraction:                                 │
    │                                                       │
    │  Style Analysis:                                     │
    │  • Line work: Soft, flowing                         │
    │  • Coloring: Cel-shaded with gradients              │
    │  • Tone: Warm color palette                         │
    │  • Detail: High background detail                    │
    │                                                       │
    │  Preview:                                            │
    │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐   │
    │  │ Sample  │ │ Sample  │ │ Sample  │ │ Sample  │   │
    │  │ env 1   │ │ env 2   │ │ env 3   │ │ env 4   │   │
    │  └─────────┘ └─────────┘ └─────────┘ └─────────┘   │
    │                                                       │
    │  Does this match what you wanted?                    │
    │  [Yes, use this style] [No, try again]              │
    └──────────────────────────────────────────────────────┘
```

### 3.5 Character From Description Flow (No Existing Art)

```
Flow: Create Character When User Has No Reference Images

Trigger: User clicks [+ Add Character] but has no art

Problem: Maya (writer who can't draw) has a character in her head
but no images. Chicken-and-egg: need images to lock, need lock to generate.

Solution: Generate initial references, let user approve, THEN lock.

    ┌──────────────────────────────────────────────────────┐
    │           HOW DO YOU HAVE YOUR CHARACTER?            │
    ├──────────────────────────────────────────────────────┤
    │                                                       │
    │  ┌────────────────────┐  ┌────────────────────┐     │
    │  │                    │  │                    │     │
    │  │  📷 I have images  │  │  ✏️ Describe them  │     │
    │  │                    │  │                    │     │
    │  │  Upload existing   │  │  We'll generate    │     │
    │  │  reference art     │  │  refs for you      │     │
    │  │                    │  │                    │     │
    │  └────────────────────┘  └────────────────────┘     │
    │                                                       │
    └──────────────────────────────────────────────────────┘
                          │
                          │ Click "Describe them"
                          ▼
    ┌──────────────────────────────────────────────────────┐
    │           DESCRIBE YOUR CHARACTER                     │
    ├──────────────────────────────────────────────────────┤
    │                                                       │
    │  Tell us about your character:                       │
    │  ┌────────────────────────────────────────────────┐  │
    │  │ Young woman, early 20s, long dark hair with    │  │
    │  │ purple highlights, determined eyes, athletic   │  │
    │  │ build, usually wears a leather jacket and      │  │
    │  │ ripped jeans. Has a small scar on left cheek. │  │
    │  └────────────────────────────────────────────────┘  │
    │                                                       │
    │  Art style: [Anime/Manga ▼]                          │
    │                                                       │
    │  [Generate Character Ideas]                          │
    │                                                       │
    └──────────────────────────────────────────────────────┘
                          │
                          ▼
    ┌──────────────────────────────────────────────────────┐
    │           CHOOSE YOUR CHARACTER                       │
    ├──────────────────────────────────────────────────────┤
    │                                                       │
    │  We generated some options. Pick one to refine:      │
    │                                                       │
    │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐   │
    │  │         │ │         │ │         │ │         │   │
    │  │ Option  │ │ Option  │ │ Option  │ │ Option  │   │
    │  │   A     │ │   B     │ │   C     │ │   D     │   │
    │  │         │ │         │ │         │ │         │   │
    │  │ [Pick]  │ │ [Pick]  │ │ [Pick]  │ │ [Pick]  │   │
    │  └─────────┘ └─────────┘ └─────────┘ └─────────┘   │
    │                                                       │
    │  None of these right?                                │
    │  [Regenerate All] [Adjust Description]               │
    │                                                       │
    └──────────────────────────────────────────────────────┘
                          │
                          │ Click [Pick] on preferred
                          ▼
    ┌──────────────────────────────────────────────────────┐
    │           REFINE YOUR CHARACTER                       │
    ├──────────────────────────────────────────────────────┤
    │                                                       │
    │  Great choice! Let's generate some variations:       │
    │                                                       │
    │  ┌─────────────────────────────────────────────────┐ │
    │  │                                                 │ │
    │  │        [Selected character - large]            │ │
    │  │                                                 │ │
    │  └─────────────────────────────────────────────────┘ │
    │                                                       │
    │  We'll generate different angles and expressions.    │
    │  These become your character's reference images.     │
    │                                                       │
    │  [Generate Variations]                               │
    │                                                       │
    └──────────────────────────────────────────────────────┘
                          │
                          ▼
          (Proceeds to normal anchor review flow)

Key UX Decisions:
- Two entry paths: have images vs. describe
- Generate initial concepts FIRST, then refine
- User picks ONE concept to develop
- Generated variations become the "reference images"
- Then proceeds to normal character lock flow
```

### 3.6 Character Editing & Variants Flow

```
Flow: Edit Existing Character or Create Costume Variant

Trigger: Click character in Assets panel → [Edit] or [Add Variant]

    ┌──────────────────────────────────────────────────────┐
    │           CHARACTER: MAYA                             │
    ├──────────────────────────────────────────────────────┤
    │                                                       │
    │  ┌─────────────────────┐  Name: [Maya___________]   │
    │  │                     │                             │
    │  │   [Main Avatar]     │  Created: Jan 15, 2026     │
    │  │                     │  Panels: 47                 │
    │  │                     │                             │
    │  └─────────────────────┘                             │
    │                                                       │
    │  REFERENCE IMAGES                                    │
    │  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐           │
    │  │ ref │ │ ref │ │ ref │ │ ref │ │ +   │           │
    │  │  1  │ │  2  │ │  3  │ │  4  │ │ add │           │
    │  └─────┘ └─────┘ └─────┘ └─────┘ └─────┘           │
    │                                                       │
    │  ANCHOR POSES                           [Regenerate] │
    │  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐           │
    │  │Front│ │ 3/4 │ │Side │ │Happy│ │ Sad │           │
    │  └─────┘ └─────┘ └─────┘ └─────┘ └─────┘           │
    │                                                       │
    │  COSTUME VARIANTS                                    │
    │  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐   │
    │  │  Default    │ │  School     │ │    +        │   │
    │  │  (Jacket)   │ │  Uniform    │ │ Add Variant │   │
    │  │   active    │ │             │ │             │   │
    │  └─────────────┘ └─────────────┘ └─────────────┘   │
    │                                                       │
    │  [Delete Character]                [Save Changes]   │
    │                                                       │
    └──────────────────────────────────────────────────────┘

ADDING A COSTUME VARIANT:
    ┌──────────────────────────────────────────────────────┐
    │           ADD COSTUME VARIANT                         │
    ├──────────────────────────────────────────────────────┤
    │                                                       │
    │  Same character, different outfit.                   │
    │  Maya in a school uniform, formal dress, etc.        │
    │                                                       │
    │  Variant name: [School Uniform______________]       │
    │                                                       │
    │  Describe the outfit:                                │
    │  ┌────────────────────────────────────────────────┐  │
    │  │ Traditional Japanese school uniform - white    │  │
    │  │ blouse, navy pleated skirt, red ribbon tie    │  │
    │  └────────────────────────────────────────────────┘  │
    │                                                       │
    │  Or upload reference: [+ Upload outfit reference]    │
    │                                                       │
    │  [Generate Variant]                                  │
    │                                                       │
    └──────────────────────────────────────────────────────┘

In panel generator, user can select variant:
    ┌──────────────────────────────────────────────────────┐
    │  CHARACTER                                           │
    │  ┌────────────────────────────────────────────────┐  │
    │  │  [Maya ▼]                                      │  │
    │  │  ─────────────────────────────                 │  │
    │  │  Outfit: [Default (Jacket) ▼]                  │  │
    │  │          ─────────────────────                 │  │
    │  │          ○ Default (Jacket)                    │  │
    │  │          ○ School Uniform                      │  │
    │  └────────────────────────────────────────────────┘  │
    └──────────────────────────────────────────────────────┘
```

### 3.7 Batch Generation Flow

```
Flow: Generate Multiple Panels at Once

Trigger: User clicks [Batch Generate] or queues multiple panels

Use Case: Kenji wants to generate 6 panels for a page and review them all together.

    ┌──────────────────────────────────────────────────────┐
    │           BATCH GENERATE                              │
    ├──────────────────────────────────────────────────────┤
    │                                                       │
    │  Generate multiple panels at once. Describe each:    │
    │                                                       │
    │  Panel 1: ┌────────────────────────────────────────┐ │
    │           │ Maya entering the classroom, nervous   │ │
    │           └────────────────────────────────────────┘ │
    │                                                       │
    │  Panel 2: ┌────────────────────────────────────────┐ │
    │           │ Close-up of Maya's surprised face      │ │
    │           └────────────────────────────────────────┘ │
    │                                                       │
    │  Panel 3: ┌────────────────────────────────────────┐ │
    │           │ Wide shot of the empty classroom       │ │
    │           └────────────────────────────────────────┘ │
    │                                                       │
    │  [+ Add Panel]                                       │
    │                                                       │
    │  Character: [Maya ▼]    Location: [Classroom ▼]     │
    │                                                       │
    │  Total cost: 75 ⚡ (3 panels × 25)                   │
    │                                                       │
    │  [Generate All]                                      │
    │                                                       │
    └──────────────────────────────────────────────────────┘
                          │
                          ▼
    ┌──────────────────────────────────────────────────────┐
    │           GENERATING... (3 panels)                    │
    ├──────────────────────────────────────────────────────┤
    │                                                       │
    │  Panel 1: ✓ Complete                                 │
    │  Panel 2: ▓▓▓▓▓▓▓▓░░░░░ 65%                         │
    │  Panel 3: Queued                                     │
    │                                                       │
    │  ┌─────────┐ ┌─────────┐ ┌─────────┐               │
    │  │ ✓ Done  │ │ Loading │ │ Waiting │               │
    │  │ [View]  │ │   ...   │ │   ...   │               │
    │  └─────────┘ └─────────┘ └─────────┘               │
    │                                                       │
    │  You can close this and continue working.            │
    │  We'll notify you when all panels are ready.         │
    │                                                       │
    │  [View Completed] [Cancel Remaining]                 │
    │                                                       │
    └──────────────────────────────────────────────────────┘
                          │
                          ▼ When all complete (or partial)
    ┌──────────────────────────────────────────────────────┐
    │           BATCH RESULTS                               │
    ├──────────────────────────────────────────────────────┤
    │                                                       │
    │  3 of 3 panels generated                             │
    │                                                       │
    │  ┌─────────┐ ┌─────────┐ ┌─────────┐               │
    │  │  ★ 94%  │ │  ★ 88%  │ │  ★ 91%  │               │
    │  │         │ │         │ │         │               │
    │  │ Panel 1 │ │ Panel 2 │ │ Panel 3 │               │
    │  │         │ │         │ │         │               │
    │  │[✓ Use]  │ │[Regen]  │ │[✓ Use]  │               │
    │  └─────────┘ └─────────┘ └─────────┘               │
    │                                                       │
    │  [Add All to Page]  [Regenerate Selected]            │
    │                                                       │
    └──────────────────────────────────────────────────────┘

PARTIAL FAILURE HANDLING:
    ┌──────────────────────────────────────────────────────┐
    │  ⚠️  2 of 3 panels generated                         │
    │                                                       │
    │  Panel 2 failed: "Generation timed out"              │
    │  Your Buzz was NOT charged for failed panels.        │
    │                                                       │
    │  ┌─────────┐ ┌─────────┐ ┌─────────┐               │
    │  │  ★ 94%  │ │  ❌ Fail │ │  ★ 91%  │               │
    │  │ Panel 1 │ │ [Retry] │ │ Panel 3 │               │
    │  └─────────┘ └─────────┘ └─────────┘               │
    │                                                       │
    │  [Use Successful Panels]  [Retry Failed]             │
    └──────────────────────────────────────────────────────┘
```

### 3.8 Location Creation Flow

```
Flow: Create and Lock a Location

Trigger: User clicks [+ Create new location] in panel generator

    ┌──────────────────────────────────────────────────────┐
    │              CREATE LOCATION                          │
    ├──────────────────────────────────────────────────────┤
    │                                                       │
    │  Location name: [Maya's Apartment_______________]    │
    │                                                       │
    │  Describe the location:                              │
    │  ┌────────────────────────────────────────────────┐  │
    │  │ Small Japanese apartment, evening light coming  │  │
    │  │ through window, cozy clutter, bookshelf,       │  │
    │  │ small desk with laptop                         │  │
    │  └────────────────────────────────────────────────┘  │
    │                                                       │
    │  [Generate Location]                                 │
    │                                                       │
    └──────────────────────────────────────────────────────┘
                          │
                          ▼
    ┌──────────────────────────────────────────────────────┐
    │              LOCATION PREVIEW                         │
    ├──────────────────────────────────────────────────────┤
    │                                                       │
    │  ┌─────────────────────────────────────────────────┐ │
    │  │                                                 │ │
    │  │           [Generated location image]            │ │
    │  │                                                 │ │
    │  └─────────────────────────────────────────────────┘ │
    │                                                       │
    │  [Regenerate] [Accept & Lock]                        │
    │                                                       │
    │  ▼ Preview variations (generated on lock):           │
    │                                                       │
    │  Camera Angles:                                      │
    │  ┌─────────┐ ┌─────────┐ ┌─────────┐               │
    │  │Standard │ │Dramatic │ │Overhead │               │
    │  └─────────┘ └─────────┘ └─────────┘               │
    │                                                       │
    │  Lighting:                                           │
    │  ┌─────────┐ ┌─────────┐                            │
    │  │   Day   │ │  Night  │                            │
    │  └─────────┘ └─────────┘                            │
    │                                                       │
    └──────────────────────────────────────────────────────┘
                          │
                          │ [Accept & Lock]
                          ▼
    ┌──────────────────────────────────────────────────────┐
    │   Location saved!                                     │
    │                                                       │
    │   You can now use "Maya's Apartment" in any panel.   │
    │   It will look consistent every time.                │
    │                                                       │
    │   [Use in current panel] [Done]                      │
    └──────────────────────────────────────────────────────┘
```

---

## 4. Screen Specifications

### 4.1 Dashboard

```
┌─────────────────────────────────────────────────────────────────┐
│  ┌────┐  Civitai Comics                      🔔  [👤 User ▼]   │
│  │logo│                                                         │
├──┴────┴─────────────────────────────────────────────────────────┤
│                                                                  │
│  Welcome back, Maya!                              Buzz: ⚡ 2,450 │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ [+ New Project]                                             ││
│  │                                                             ││
│  │ Create a new comic project                                  ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│  MY PROJECTS                                          [View All]│
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐            │
│  │  ┌────────┐  │ │  ┌────────┐  │ │  ┌────────┐  │            │
│  │  │ cover  │  │ │  │ cover  │  │ │  │ cover  │  │            │
│  │  │  img   │  │ │  │  img   │  │ │  │  img   │  │            │
│  │  └────────┘  │ │  └────────┘  │ │  └────────┘  │            │
│  │  Night City  │ │  My Hero     │ │  Test Proj   │            │
│  │  Ch 3 • 12p  │ │  Ch 1 • 4p   │ │  Draft       │            │
│  │  2 days ago  │ │  1 week ago  │ │  Just now    │            │
│  │  [Open] [⋮]  │ │  [Open] [⋮]  │ │  [Open] [⋮]  │            │
│  └──────────────┘ └──────────────┘ └──────────────┘            │
│                                                                  │
│  QUICK ACTIONS                                                  │
│  ┌────────────────┐ ┌────────────────┐ ┌────────────────┐      │
│  │ 📖 Continue    │ │ 🎨 Browse      │ │ 💡 Tutorial    │      │
│  │ "Night City"   │ │ Styles         │ │                │      │
│  └────────────────┘ └────────────────┘ └────────────────┘      │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘

Components:
- Header with logo, notifications, user menu
- Buzz balance always visible (top right)
- New Project CTA is prominent
- Project cards show: cover, title, progress, last edited
- Quick actions for common tasks
```

### 4.2 Project Workspace

```
┌─────────────────────────────────────────────────────────────────┐
│  [←] Night City Chapter 3 ▼                   ⚡ 2,450 [Export] │
├─────────┬───────────────────────────────────────────────────────┤
│         │  Page 1 of 5                    [< Page] [Page >]     │
│ ASSETS  │───────────────────────────────────────────────────────│
│         │                                                       │
│ ▼ Chars │   ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐   │
│ ┌─────┐ │   │         │ │         │ │         │ │         │   │
│ │Maya │ │   │ Panel 1 │ │ Panel 2 │ │ Panel 3 │ │ Panel 4 │   │
│ └─────┘ │   │         │ │         │ │         │ │         │   │
│ ┌─────┐ │   └─────────┘ └─────────┘ └─────────┘ └─────────┘   │
│ │Kai  │ │                                                       │
│ └─────┘ │   ┌─────────┐ ┌─────────┐                            │
│ [+ Add] │   │         │ │         │                            │
│         │   │ Panel 5 │ │ Panel 6 │   [+ Add Panel]            │
│ ▶ Locs  │   │         │ │         │                            │
│         │   └─────────┘ └─────────┘                            │
│ ▶ Style │                                                       │
│         │───────────────────────────────────────────────────────│
│         │                                                       │
│         │  Click a panel to edit, or [+ Add Panel] to generate │
│         │                                                       │
└─────────┴───────────────────────────────────────────────────────┘

States:
- Empty panel: Dashed border, click to generate
- Filled panel: Shows image, hover for actions
- Selected panel: Highlighted border, shows edit toolbar
- Assets panel: Collapsible sections

Interactions:
- Click panel → Select (shows toolbar: Edit, Delete, Regenerate)
- Double-click panel → Open in generator for editing
- Drag panel → Reorder
- Click [+ Add Panel] → Opens generator at that position
- Click character in Assets → Highlights panels using that character
```

### 4.3 Panel Generator (Expanded)

```
┌─────────────────────────────────────────────────────────────────┐
│  GENERATE PANEL                                          [✕]   │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  CHARACTER ──────────────────────────────────────────────────── │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  ┌─────┐                                                 │  │
│  │  │Maya │  Maya                               [Change ▼]  │  │
│  │  └─────┘  Main character • 23 panels created            │  │
│  │                                                          │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                  │
│  LOCATION ─────────────────────────────────────────────────────│
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  ☐ No location (describe in prompt)                      │  │
│  │  ─────────────────────────────────────                   │  │
│  │  ○ Maya's Apartment                    [Preview]         │  │
│  │  ○ City Street - Night                 [Preview]         │  │
│  │  ○ School Rooftop                      [Preview]         │  │
│  │  ─────────────────────────────────────                   │  │
│  │  [+ Create new location]                                 │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                  │
│  DESCRIBE THE SCENE ────────────────────────────────────────── │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Maya standing on the rooftop, wind blowing her hair,     │  │
│  │ looking at the sunset with a determined expression.      │  │
│  │ She's wearing her school uniform.                        │  │
│  │                                                          │  │
│  │                                                   0/500  │  │
│  └──────────────────────────────────────────────────────────┘  │
│  💡 Tip: Describe emotion, action, and key visual details     │
│                                                                  │
│  SHOT & CAMERA ─────────────────────────────────────────────── │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Shot:   [Close-up] [Medium ●] [Wide] [Establishing]     │  │
│  │  Angle:  [Eye level ●] [Low] [High] [Dutch]              │  │
│  └──────────────────────────────────────────────────────────┘  │
│  (Shot type dramatically affects results - always visible)     │
│                                                                  │
│  ▼ ADVANCED OPTIONS ────────────────────────────────────────── │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Expression:   [From description ▼]                       │  │
│  │  Pose hint:    [None ▼]                                   │  │
│  │                                                          │  │
│  │  ☐ Use specific anchor as reference                      │  │
│  │    ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐             │  │
│  │    │Front│ │ 3/4 │ │Side │ │Happy│ │Action│             │  │
│  │    └─────┘ └─────┘ └─────┘ └─────┘ └─────┘             │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌────────────────────────────────────────────────────────┐    │
│  │                   [Generate]  25 ⚡                     │    │
│  └────────────────────────────────────────────────────────┘    │
│                                                                  │
│  Your balance: 2,450 ⚡  [Get more Buzz]                        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘

Component Details:

1. CHARACTER SELECTOR
   - Shows current character with thumbnail
   - Quick stats (# panels created)
   - Dropdown to change character
   - If no character: CTA to create one

2. LOCATION SELECTOR
   - Default: "No location" (most flexible)
   - Saved locations with preview option
   - Create new location inline
   - Location selection is OPTIONAL

3. DESCRIPTION INPUT
   - Large text area (primary input)
   - Character counter
   - Contextual tips
   - Could add prompt suggestions

4. ADVANCED OPTIONS
   - Collapsed by default
   - Shot type: Close-up, Medium, Wide, Establishing
   - Camera angle: Eye level, Low, High, Dutch
   - Expression override
   - Anchor reference (power user feature)

5. GENERATE BUTTON
   - Shows Buzz cost clearly
   - Disabled if no character or empty description
   - Balance shown for transparency
```

---

## 5. Interaction Patterns

### 5.1 Progressive Disclosure Levels

```
Level 1: Essential (Always Visible)
├── Character selector
├── Scene description
└── Generate button

Level 2: Common (One Click to Expand)
├── Location selector
├── Shot type
└── Camera angle

Level 3: Advanced (Hidden by Default)
├── Expression override
├── Pose anchor selection
├── Style strength sliders
└── Seed control

Level 4: Expert (Settings/Preferences)
├── Custom LoRA weights
├── Negative prompts
├── Advanced composition controls
└── Raw parameter editing
```

### 5.2 Loading & Progress States

```
PANEL GENERATION PROGRESS

State 1: Initiated (0-5%)
┌────────────────────────────────┐
│   Starting generation...       │
│   ░░░░░░░░░░░░░░░░░░░░  0%    │
└────────────────────────────────┘

State 2: Character Lock (5-25%)
┌────────────────────────────────┐
│   Applying character lock...   │
│   ▓▓▓▓░░░░░░░░░░░░░░░░  20%   │
└────────────────────────────────┘

State 3: Scene Setup (25-50%)
┌────────────────────────────────┐
│   Setting up scene...          │
│   ▓▓▓▓▓▓▓▓▓░░░░░░░░░░░  40%   │
└────────────────────────────────┘

State 4: Generation (50-85%)
┌────────────────────────────────┐
│   Generating panel...          │
│   ▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░  70%   │
│                                │
│   [Low-res preview appears]    │
└────────────────────────────────┘

State 5: Finishing (85-100%)
┌────────────────────────────────┐
│   Finalizing...                │
│   ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░  95%   │
└────────────────────────────────┘

State 6: Complete
┌────────────────────────────────┐
│   ✓ Done!                      │
│   [Show results]               │
└────────────────────────────────┘
```

### 5.3 Error States

```
ERROR: Insufficient Buzz
┌────────────────────────────────────────────────────┐
│  ⚠️  Not enough Buzz                               │
│                                                    │
│  This generation costs 25 ⚡                       │
│  Your balance: 10 ⚡                               │
│                                                    │
│  [Get more Buzz]  [Cancel]                         │
└────────────────────────────────────────────────────┘

ERROR: Character Not Locked
┌────────────────────────────────────────────────────┐
│  ⚠️  No character selected                         │
│                                                    │
│  You need to create a character before generating  │
│  panels. This ensures your character looks         │
│  consistent across all panels.                     │
│                                                    │
│  [Create Character]  [Cancel]                      │
└────────────────────────────────────────────────────┘

ERROR: Generation Failed
┌────────────────────────────────────────────────────┐
│  ❌  Generation failed                             │
│                                                    │
│  Something went wrong. Your Buzz was not charged.  │
│                                                    │
│  [Try Again]  [Change Description]  [Contact Support] │
└────────────────────────────────────────────────────┘

ERROR: Low Consistency Score
┌────────────────────────────────────────────────────┐
│  ⚠️  Consistency check                             │
│                                                    │
│  These results scored lower than usual on          │
│  character consistency (68%). The character may    │
│  look slightly different.                          │
│                                                    │
│  [Use anyway]  [Regenerate (free)]                 │
└────────────────────────────────────────────────────┘
```

### 5.4 Empty States

```
EMPTY: No Projects
┌────────────────────────────────────────────────────┐
│                                                    │
│        📚                                          │
│                                                    │
│   No projects yet                                  │
│                                                    │
│   Create your first comic project and bring       │
│   your characters to life.                        │
│                                                    │
│   [+ Create Project]                               │
│                                                    │
│   Need inspiration? [Browse examples]              │
│                                                    │
└────────────────────────────────────────────────────┘

EMPTY: No Characters in Project
┌────────────────────────────────────────────────────┐
│                                                    │
│   CHARACTERS                                       │
│   ─────────                                        │
│                                                    │
│   👤                                               │
│                                                    │
│   No characters yet                                │
│                                                    │
│   Add a character to start creating panels.       │
│   Your character will look consistent in          │
│   every panel you generate.                       │
│                                                    │
│   [+ Add Character]                                │
│                                                    │
└────────────────────────────────────────────────────┘

EMPTY: No Panels on Page
┌────────────────────────────────────────────────────┐
│                                                    │
│   ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐   │
│   │                                           │   │
│   │         This page is empty                │   │
│   │                                           │   │
│   │    Click to add your first panel          │   │
│   │                                           │   │
│   │            [+ Add Panel]                  │   │
│   │                                           │   │
│   └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘   │
│                                                    │
└────────────────────────────────────────────────────┘
```

### 5.5 Auto-Save & Recovery

```
AUTO-SAVE BEHAVIOR:

When:
- Every 30 seconds if changes exist
- Immediately after panel is added
- Immediately after character is locked
- Before browser tab closes (beforeunload)

Indicator:
┌────────────────────────────────────────┐
│ Project Name        Saved ✓  |  ⚡ 500 │
│                    Saving... |         │
│                    Offline ⚠ |         │
└────────────────────────────────────────┘

Recovery (after crash/close):
┌────────────────────────────────────────────────────────┐
│                                                        │
│  📄 Recovered unsaved changes                          │
│                                                        │
│  We found changes from your last session:              │
│  • 2 panels generated but not saved                   │
│  • Project "Night City" - 15 minutes ago              │
│                                                        │
│  [Restore Changes]  [Discard]                          │
│                                                        │
└────────────────────────────────────────────────────────┘
```

### 5.6 Undo/History System

```
PANEL-LEVEL HISTORY:

Each panel maintains history of:
- Last 5 generations
- Current state

Access via panel menu:
┌─────────────────────────────────────┐
│ Panel Options                   [✕] │
├─────────────────────────────────────┤
│                                     │
│  Current                            │
│  ┌───────────────────────────────┐  │
│  │    [Current panel image]     │  │
│  └───────────────────────────────┘  │
│                                     │
│  History (click to restore)         │
│  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐  │
│  │ v4  │ │ v3  │ │ v2  │ │ v1  │  │
│  │ 2m  │ │ 5m  │ │ 8m  │ │ 12m │  │
│  └─────┘ └─────┘ └─────┘ └─────┘  │
│                                     │
│  [Delete Panel]                     │
│                                     │
└─────────────────────────────────────┘

Keyboard shortcuts:
- Ctrl/Cmd + Z: Undo last action (panel delete, etc.)
- No redo (simplifies implementation)

Note: Generation cannot be undone (Buzz is spent),
but previous versions can be restored from history.
```

### 5.7 Buzz Purchase Flow

```
TRIGGER: User attempts action with insufficient Buzz

┌────────────────────────────────────────────────────────┐
│                                                        │
│  ⚠️  Not enough Buzz                                   │
│                                                        │
│  This generation costs 25 ⚡                           │
│  Your balance: 10 ⚡                                   │
│                                                        │
│  ┌──────────────────────────────────────────────────┐ │
│  │  Get more Buzz                                    │ │
│  │                                                   │ │
│  │  100 ⚡   $5      [Buy]                          │ │
│  │  500 ⚡   $20     [Buy]  ← Best value            │ │
│  │  1000 ⚡  $35     [Buy]                          │ │
│  │                                                   │ │
│  │  Or get unlimited with Civitai Supporter         │ │
│  │  [Learn more →]                                  │ │
│  └──────────────────────────────────────────────────┘ │
│                                                        │
│  [Cancel]                                              │
│                                                        │
└────────────────────────────────────────────────────────┘

After purchase:
┌────────────────────────────────────────────────────────┐
│                                                        │
│  ✓ Buzz added!                                         │
│                                                        │
│  500 ⚡ added to your account                          │
│  New balance: 510 ⚡                                   │
│                                                        │
│  [Continue Generating]                                 │
│                                                        │
└────────────────────────────────────────────────────────┘

Low balance warning (proactive):
- When balance < 50 Buzz, show subtle warning in header
- "Running low on Buzz" with link to purchase
```

### 5.8 Success States

```
SUCCESS: Character Created
┌────────────────────────────────────────────────────┐
│                                                    │
│   ✓ Character created!                             │
│                                                    │
│   ┌─────┐                                          │
│   │Maya │  Maya is ready to star in your comic.   │
│   └─────┘                                          │
│                                                    │
│   [Generate First Panel]  [Add Another Character]  │
│                                                    │
└────────────────────────────────────────────────────┘

SUCCESS: Panel Generated
┌────────────────────────────────────────────────────┐
│                                                    │
│   ✓ Panel added!                                   │
│                                                    │
│   [View in Canvas]  [Generate Another]             │
│                                                    │
└────────────────────────────────────────────────────┘

SUCCESS: First Comic Completed (Celebration)
┌────────────────────────────────────────────────────┐
│                                                    │
│   🎉 Congratulations!                              │
│                                                    │
│   You've created your first comic page!           │
│                                                    │
│   [Export]  [Share Preview]  [Keep Creating]       │
│                                                    │
└────────────────────────────────────────────────────┘
```

---

## 6. UX Writing

### 6.1 Button Labels

| Action | Label | NOT |
|--------|-------|-----|
| Create panel | Generate Panel | Submit, Go, Create |
| Save character | Save Character | Confirm, OK |
| Start project | Create Project | New, Start |
| Choose style | Use This Style | Select, Apply |
| Export comic | Export | Download, Save |
| Add character | Add Character | New Character, + |
| Continue editing | Continue | Resume, Open |

### 6.2 Error Messages

| Error | Message |
|-------|---------|
| No character | "Add a character first. This ensures they look the same in every panel." |
| Empty description | "Describe what's happening in the panel. Include who, what, and where." |
| Insufficient Buzz | "You need 25 Buzz for this. [Get more Buzz]" |
| Generation failed | "Something went wrong. Your Buzz wasn't charged. [Try again]" |
| Upload failed | "Upload failed. Check your connection and try again." |
| Face not detected | "We couldn't detect a face. Try a clearer, front-facing image." |
| Style mismatch | "This style may not work well with your character. [Continue anyway] [Try different style]" |

### 6.3 Onboarding Copy

```
Welcome Screen:
"Create comics with consistent characters.
No drawing skills required."

Character Setup:
"Let's create your character.
Upload 3-5 reference images - the more angles, the better."

First Generation:
"Describe your first panel.
Be specific: who's there, what they're doing, and the mood."

Success:
"Nice! That's your character in your style.
Now let's make some more panels."
```

### 6.4 Tooltip Text

| Element | Tooltip |
|---------|---------|
| Consistency score | "How closely this matches your character. Higher is better." |
| Buzz cost | "Generation costs Buzz. You have 2,450 remaining." |
| Location lock | "Save this location to reuse it in other panels." |
| Anchor images | "Pre-generated poses help maintain consistency." |
| Style import | "Upload images in the style you want. We'll match it." |

---

## 7. Accessibility

### 7.1 Keyboard Navigation

```
Tab Order (Panel Generator):
1. Character selector
2. Location selector
3. Description textarea
4. Advanced options toggle
5. Generate button

Shortcuts:
- Ctrl/Cmd + Enter: Generate
- Escape: Close modal/cancel
- Ctrl/Cmd + S: Save project
- Arrow keys: Navigate panels in canvas
```

### 7.2 Screen Reader Considerations

```
Image Descriptions:
- Character thumbnail: "Maya, main character, 23 panels created"
- Generated panel: "Panel 1: Maya on rooftop at sunset, looking determined"
- Anchor image: "Front view anchor for Maya, approved"

Status Announcements:
- "Generation started, 0%"
- "Generation complete, 4 results ready"
- "Character saved successfully"
- "Error: insufficient Buzz balance"

Focus Management:
- After generation: Focus moves to first result
- After error: Focus moves to error message
- After modal close: Focus returns to trigger element
```

### 7.3 Color & Contrast

```
Requirements:
- All text: 4.5:1 contrast ratio minimum
- Interactive elements: 3:1 contrast ratio
- Focus indicators: Visible, high contrast

Don't rely on color alone:
- Error states: Red + icon + text
- Success states: Green + icon + text
- Warnings: Yellow + icon + text
- Selected items: Color + border + icon
```

---

## 8. Mobile Strategy

### 8.1 Mobile User (Alex) Needs

Alex is 1/3 of our personas - mobile-first, short sessions, social sharing focus.

**Alex's Context:**
- Uses phone 90% of the time
- Sessions: 15-30 minutes
- Goal: Quick creation, immediate sharing
- Tolerance for complexity: Low

### 8.2 Mobile Strategy: Progressive Enhancement

```
Strategy: "Create anywhere, refine on desktop"

Mobile (Essential):
├── View/browse projects
├── View completed pages
├── Generate single panels
├── Simple character selection
├── Quick export/share
└── Push notifications

Desktop (Full Experience):
├── Everything above, plus:
├── Multi-panel batch generation
├── Character creation/editing
├── Location management
├── Canvas editing/reordering
├── Advanced options
└── Full export controls
```

### 8.3 Mobile Layout

```
MOBILE DASHBOARD (< 640px)
┌─────────────────────────┐
│ ☰  Civitai Comics   ⚡  │
├─────────────────────────┤
│                         │
│  MY PROJECTS            │
│  ┌───────────────────┐  │
│  │ Night City Ch3    │  │
│  │ 12 pages • 2d ago │  │
│  └───────────────────┘  │
│  ┌───────────────────┐  │
│  │ My Hero Ch1       │  │
│  │ 4 pages • 1w ago  │  │
│  └───────────────────┘  │
│                         │
│  ┌───────────────────┐  │
│  │   + New Project   │  │
│  └───────────────────┘  │
│                         │
└─────────────────────────┘


MOBILE PROJECT VIEW
┌─────────────────────────┐
│ ← Night City      ⚡ ⋮  │
├─────────────────────────┤
│                         │
│  Page 3 of 12           │
│  ┌───────────────────┐  │
│  │                   │  │
│  │    Panel View     │  │
│  │  (swipe to nav)   │  │
│  │                   │  │
│  └───────────────────┘  │
│                         │
│  ┌───┐┌───┐┌───┐┌───┐  │
│  │ 1 ││ 2 ││ 3 ││ 4 │  │  ← Thumbnail strip
│  └───┘└───┘└───┘└───┘  │
│                         │
├─────────────────────────┤
│  [+ Generate Panel]     │
└─────────────────────────┘


MOBILE PANEL GENERATOR
┌─────────────────────────┐
│ ← Generate Panel        │
├─────────────────────────┤
│                         │
│  Character              │
│  ┌───────────────────┐  │
│  │ 👤 Maya       ▼   │  │
│  └───────────────────┘  │
│                         │
│  Describe the scene     │
│  ┌───────────────────┐  │
│  │                   │  │
│  │ Maya looking out  │  │
│  │ the window...     │  │
│  │                   │  │
│  └───────────────────┘  │
│                         │
│  Shot: [Medium ▼]       │
│                         │
│  ┌───────────────────┐  │
│  │  Generate  25 ⚡  │  │
│  └───────────────────┘  │
│                         │
└─────────────────────────┘
```

### 8.4 Mobile-Specific Features

| Feature | Mobile Behavior |
|---------|----------------|
| **Character creation** | "Continue on desktop" prompt for full flow; allow simple description-only creation |
| **Panel generation** | Full support, single result (not 4 variations) |
| **Canvas editing** | View-only; can delete panels but not reorder |
| **Export** | Quick share to social (Instagram, Twitter dimensions) |
| **Notifications** | "Your panel is ready" when generation completes |
| **Offline** | View saved projects, queue generations for when online |

### 8.5 Breakpoints

| Width | Layout | Features |
|-------|--------|----------|
| < 640px | Mobile | Single column, bottom nav, simplified generation |
| 640-1024px | Tablet | Two column, collapsible assets, full generation |
| > 1024px | Desktop | Three column workspace, all features |

### 8.6 Touch Interactions

```
Swipe left/right: Navigate between panels
Swipe up: Open generation drawer
Long press panel: Show context menu (delete, regenerate)
Pinch: Zoom on panel preview
Double tap: Full-screen panel view
```

---

## 9. Validation Plan

### 8.1 Usability Testing

```
Task 1: Create First Character
- Scenario: "Upload images of your character and set them up"
- Success: Character is locked, anchors are approved
- Metrics: Time, errors, satisfaction

Task 2: Generate a Panel
- Scenario: "Create a panel of your character in a specific scene"
- Success: Panel is generated and added to canvas
- Metrics: Time, prompt iterations, result satisfaction

Task 3: Create Consistent Comic Page
- Scenario: "Create a page with 4 panels, same character throughout"
- Success: 4 panels completed, character looks consistent
- Metrics: Time, consistency rating, user satisfaction

Task 4: Use a Saved Location
- Scenario: "Create two panels in the same room"
- Success: Location is saved and reused, looks consistent
- Metrics: Discoverability, time, satisfaction
```

### 8.2 Metrics to Track

```
Activation:
- % users who create first character
- % users who generate first panel
- Time from signup to first panel

Engagement:
- Panels per session
- Sessions per week
- Project completion rate

Quality:
- Average consistency score (system)
- User satisfaction rating (thumbs up/down)
- Regeneration rate (lower = better)

Retention:
- Day 1, 7, 30 retention
- Paid conversion rate
- Buzz depletion → purchase rate
```

### 8.3 A/B Tests to Consider

```
1. Onboarding Flow
   A: Guided character setup first
   B: Style selection first
   Metric: First panel completion rate

2. Generation Results
   A: Show 4 results
   B: Show 2 results + regenerate option
   Metric: Selection time, satisfaction

3. Location Feature
   A: Optional (describe in prompt)
   B: Required for second panel
   Metric: Location adoption, consistency ratings

4. Pricing Display
   A: Show Buzz cost on button
   B: Show cost after clicking
   Metric: Generation rate, user feedback
```

---

## 10. Hackathon MVP Scope

**See standalone document:** [`docs/plan-webtoon-hackathon-mvp.md`](./plan-webtoon-hackathon-mvp.md)

The hackathon MVP plan has been extracted to a comprehensive standalone document that includes:

- Pipeline dependency checklist
- Two paths: Magic Moment Demo (8-16h) vs Working Prototype (3-5 days)
- Complete technical architecture and database schema
- API endpoints (internal and external)
- Detailed wireframes for all 6 screens
- Day-by-day development schedule
- Demo script with fallback procedures
- Pre-hackathon and demo day checklists
- Error handling and Buzz pricing

### Quick Summary

**The Core Loop:**
```
Upload character → Save character → Describe scene → Generate →
"Holy shit, that's actually the same person!"
```

**Critical Blocker:** Verify all pipelines work BEFORE starting frontend development. See Appendix C for pipeline requirements.

---

## Next Steps

1. **Pipeline Verification (FIRST):**
   - Verify all pipelines in Appendix C exist and work
   - Create test character via API, verify output quality
   - Generate 10+ test panels, measure consistency
   - **Decision point:** Path A (demo) or Path B (prototype)?

2. **Hackathon Prep:**
   - See [`docs/plan-webtoon-hackathon-mvp.md`](./plan-webtoon-hackathon-mvp.md) for complete hackathon plan
   - Follow pre-hackathon checklist in that document
   - Prepare fallback demo materials regardless of path

3. **Post-Hackathon:**
   - User testing with the MVP (or demo feedback)
   - Gather feedback on character consistency quality
   - Prioritize V2 features based on user demand

4. **Full Product:**
   - Review this UX doc with stakeholders
   - Create interactive Figma prototype
   - Validate flows with target users
   - Iterate before full development

---

## Appendices

### Appendix A: Complete Buzz Pricing Table

| Operation | Buzz Cost | Notes |
|-----------|-----------|-------|
| **Account** | | |
| New account starting balance | 100 free | One-time welcome bonus |
| **Character Operations** | | |
| Character creation (from images) | 50 | Includes embedding + 10 reference poses |
| Character creation (from description) | 75 | Includes 4 concepts + selected char setup |
| Add costume variant | 30 | Per variant |
| Regenerate single reference pose | 5 | Fix individual poses |
| Regenerate all reference poses | 25 | Full re-generation |
| **Panel Generation** | | |
| Generate panel (single result) | 20 | Default for MVP |
| Regenerate panel | 20 | Same cost as new |
| **Locations** | | |
| Create location | 30 | Includes 6 variants (angles + lighting) |
| Use saved location | Free | Encourage reuse |
| **Batch Operations** | | |
| Batch generation | (panels × 20) | No volume discount for MVP |
| **Style** | | |
| Import style (from images) | 20 | One-time per style |
| Use curated style | Free | Included styles |
| **Export** | | |
| PNG export | Free | Standard quality |
| High-res export | 10/page | Optional upgrade |

**Context for users:** 100 Buzz ≈ 5 panels, 500 Buzz ≈ 25 panels

---

### Appendix B: Content Policy

**Allowed Content:**
- Original characters (user-created or AI-generated)
- Fan art with clear transformative purpose
- All ages content (default)
- Mature content with age gate (if enabled in settings)

**Prohibited Content:**
- Real people without consent
- Copyrighted characters (exact replicas)
- CSAM (zero tolerance, immediate ban)
- Hate speech or harassment
- Illegal content in any jurisdiction

**Enforcement:**
1. **Automated:** NSFW classifier on all generations
2. **User reports:** Flag button on all content
3. **Review queue:** Flagged content reviewed within 24h
4. **Actions:** Warning → 24h suspension → permanent ban

**User Responsibilities:**
- Users confirm they have rights to reference images
- Users agree content complies with Civitai Terms of Service
- NSFW toggle must be enabled for mature content generation

---

### Appendix C: Pipeline Requirements (Pre-Development Blockers)

**Required APIs (Must Exist Before Development):**

| Pipeline | Status | Endpoint | Notes |
|----------|--------|----------|-------|
| **Face Embedding** | ⬜ TBD | `POST /api/face/embed` | Input: images, Output: embedding vector |
| **Character Creation** | ⬜ TBD | `POST /api/character/create` | Uses IP-Adapter or equivalent |
| **Panel Generation** | ⬜ TBD | `POST /api/generate/panel` | Input: character_id + prompt, Output: image |
| **Civitai SSO** | ⬜ TBD | OAuth2 flow | Standard Civitai auth |
| **Buzz API** | ⬜ TBD | `GET/POST /api/buzz` | Balance check, charge |

**Performance Requirements:**

| Operation | Target | Maximum | Notes |
|-----------|--------|---------|-------|
| Face embedding | <5s | 10s | Per image |
| Character creation | <30s | 60s | Full pipeline |
| Panel generation | <15s | 30s | Critical for UX |
| Page load | <2s | 3s | Dashboard, workspace |

**Pre-Hackathon Verification Checklist:**
- [ ] Character creation pipeline returns consistent results (test with 10 different characters)
- [ ] Generation with character reference produces recognizable character (>80% of the time)
- [ ] SSO flow works end-to-end in test environment
- [ ] Buzz balance can be read (even if charges are disabled for demo)
- [ ] All endpoints have error responses documented

**BLOCKER:** Do not start frontend development until all pipelines are verified working.

---

### Appendix D: Character Creation Failure Handling

**Failure: Face Not Detected**
```
┌────────────────────────────────────────────────────────────┐
│  ⚠️  We couldn't detect a face                             │
│                                                            │
│  We need clear, front-facing images to create your         │
│  character. Try images where:                              │
│  • Face is clearly visible                                 │
│  • Not too far away or blurry                             │
│  • At least one front-facing view                         │
│                                                            │
│  ┌─────┐ ┌─────┐ ┌─────┐                                  │
│  │ ❌  │ │ ❌  │ │ ✓   │  ← Shows which images failed     │
│  │img 1│ │img 2│ │img 3│                                  │
│  └─────┘ └─────┘ └─────┘                                  │
│                                                            │
│  [Replace Failed Images]  [Try Different Character]        │
└────────────────────────────────────────────────────────────┘
```

**Failure: Inconsistent References**
```
┌────────────────────────────────────────────────────────────┐
│  ⚠️  These look like different characters                  │
│                                                            │
│  We detected multiple different faces in your images.      │
│  For best results, upload images of the SAME character.    │
│                                                            │
│  ┌─────┐ ┌─────┐ ┌─────┐                                  │
│  │Group│ │Group│ │Group│  ← System groups similar faces   │
│  │  A  │ │  A  │ │  B  │                                  │
│  └─────┘ └─────┘ └─────┘                                  │
│                                                            │
│  Which character do you want to create?                    │
│  [Use Group A (2 images)]  [Use Group B (1 image)]        │
│                                                            │
│  Or: [Start Over with New Images]                          │
└────────────────────────────────────────────────────────────┘
```

**Failure: Server Error**
```
┌────────────────────────────────────────────────────────────┐
│  ❌  Character creation failed                             │
│                                                            │
│  Something went wrong on our end. Your Buzz was NOT        │
│  charged.                                                  │
│                                                            │
│  [Try Again]  [Contact Support]                            │
└────────────────────────────────────────────────────────────┘
```

**Warning: Low Quality Result**
```
┌────────────────────────────────────────────────────────────┐
│  ⚠️  Character quality check                               │
│                                                            │
│  We created your character, but the reference poses        │
│  look inconsistent. This may affect panel quality.         │
│                                                            │
│  Options:                                                  │
│  [Use Anyway] - may have inconsistency issues             │
│  [Add More Reference Images] - improve quality            │
│  [Start Over] - refund: 40 Buzz                           │
└────────────────────────────────────────────────────────────┘
```

---

### Appendix E: Terminology Guide

**User-Facing Terms (Use These):**

| Internal Term | User-Facing Term | Reason |
|---------------|------------------|--------|
| Character Lock | **Save Character** | "Lock" is jargon |
| Anchor Poses | **Reference Poses** | Users know "references" |
| Embedding | (Don't expose) | Too technical |
| IP-Adapter | (Don't expose) | Implementation detail |
| LoRA | **Style** | Unless power user |
| Consistency Score | **Match** or **%** | More intuitive |
| Location Lock | **Save Location** | Consistent naming |

**Example Copy Changes:**
```
Before: "Locking your character..."
After:  "Creating your character..."

Before: "Generating anchor poses..."
After:  "Creating reference poses..."

Before: "Character lock complete"
After:  "Character saved! Ready to create panels."

Before: "Consistency score: 92%"
After:  "92% match"
```

---

### Appendix F: Component Library Notes

**Required Components:**

| Component | Mantine Equivalent | Customization Needed |
|-----------|-------------------|---------------------|
| File Upload | Dropzone | Custom preview, validation |
| Character Card | Card | Custom layout, states |
| Panel Grid | SimpleGrid | Drag-drop, selection |
| Progress | Progress | Custom stages, labels |
| Modal | Modal | Large size, custom header |
| Tooltip | Tooltip | Consistent styling |
| Button | Button | Buzz icon, loading state |
| Select | Select | Image previews |
| Textarea | Textarea | Character count, tips |
| Tabs | Tabs | Asset panel sections |

**Animation Specs:**

| Animation | Duration | Easing | Trigger |
|-----------|----------|--------|---------|
| Modal open | 200ms | ease-out | Open modal |
| Panel appear | 300ms | ease-out | Generation complete |
| Progress bar | continuous | linear | During generation |
| Success flash | 400ms | ease-in-out | Task complete |
| Error shake | 300ms | ease-in-out | Validation error |
