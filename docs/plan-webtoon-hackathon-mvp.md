# Civitai Comics - Hackathon MVP Plan

**Date:** January 2026
**Goal:** Demonstrate character consistency across multiple comic panels
**Domain:** comics.civitai.com (prototype)

---

## Executive Summary

Build a minimal working prototype that demonstrates the core magic of Civitai Comics:

> **Upload a character → Lock their appearance → Generate panels → Same character every time**

This hackathon is about proving the concept works, not building a full product.

### Important Context

- **Path A (Magic Moment Demo)** is the **baseline deliverable** - guaranteed achievable
- **Path B (Working Prototype)** is a **stretch goal** - requires all pipelines verified AND favorable conditions
- The full product plan estimates 36-41 weeks; this hackathon is a focused proof-of-concept
- Hackathon code is **throwaway/demo quality** - production will be rebuilt properly

---

## ⚠️ CRITICAL: Pipeline Dependencies

**Before writing ANY frontend code, verify these pipelines exist and work:**

| Pipeline | Required | Status | Endpoint (Confirm with Backend) | Notes |
|----------|----------|--------|--------------------------------|-------|
| Face embedding extraction | YES | ⬜ TBD | TBD - may be `POST /api/face/embed` or part of character creation | Input: images, Output: embedding vector |
| Character creation | YES | ⬜ TBD | TBD - may be `POST /lora/train` or `POST /api/character/create` | Core magic - must produce consistent results |
| Panel generation with character ref | YES | ⬜ TBD | TBD - may be `POST /generation/create` or `POST /api/generate/panel` | Input: character_id + prompt, Output: image |
| Civitai SSO (test environment) | YES | ⬜ TBD | OAuth2 flow | Standard Civitai auth |
| Buzz reservation (if charging) | CONDITIONAL | ⬜ TBD | `POST /buzz/reserve`, `POST /buzz/commit` | Required for atomic transactions |
| Buzz balance read | NICE TO HAVE | ⬜ TBD | `GET /users/{id}/buzz` | For display only |

**⚠️ API ENDPOINT WARNING:** The endpoint names above are placeholders. **GET EXACT SPECS FROM CIVITAI BACKEND TEAM BEFORE STARTING.** The product plan uses different naming (`/lora/train`, `/generation/create`). Don't assume - verify.

### Pipeline Verification Checklist

Before Day 1, complete ALL of these:

- [ ] **Get written API specs from backend team** - exact endpoints, request/response formats
- [ ] Character creation pipeline returns consistent results (test with 5+ different characters)
- [ ] Generation with character reference produces recognizable character (>80% of the time)
- [ ] **Measure actual latency**: Character creation may be 30s (embedding only) or 5-10min (with LoRA training)
- [ ] SSO flow works end-to-end in test environment
- [ ] **SSO token refresh works** - test with expired token
- [ ] All endpoints have documented error responses
- [ ] Have API credentials/tokens ready (service token vs user token distinction)
- [ ] **Pre-create demo characters** via API before hackathon starts

### Latency Reality Check

| Operation | Optimistic | Realistic | If Slow... |
|-----------|------------|-----------|------------|
| Character creation | 30-60s | 2-10 min | Pre-create characters before demo |
| Panel generation | 10-15s | 15-30s | Show progress, have pre-generated fallback |
| SSO flow | 2-3s | 5-10s | Have "already logged in" fallback state |

**BLOCKER:** If ANY "YES" pipeline is not verified working, do NOT start frontend development. Switch to Path A (Magic Moment Demo).

---

## Choose Your Path

Based on pipeline readiness and time available, pick ONE approach:

| Path | Pipelines Ready? | Time | Screens | Outcome |
|------|------------------|------|---------|---------|
| **A: Magic Moment Demo** | ⬜ No | 8-16 hours | 2-3 | Shows the vision with pre-generated content |
| **B: Working Prototype** | ✅ All verified | 5 days (optimistic) | 6 | Actually works end-to-end |

### Realistic Expectations

**Path A** is your **baseline deliverable**. You can always fall back to this.

**Path B** is a **stretch goal**. The product plan estimates:
- SSO integration alone: 5 weeks (we're doing a minimal happy-path-only version)
- Character system: 4 weeks (we're doing the simplest possible version)
- Full composition: 5 weeks (we're skipping this entirely)

**What Path B actually proves:** That the core loop CAN work. It won't be production-quality - it's throwaway demo code.

**If Path B hits blockers:** Fall back to Path A with whatever pieces are working.

---

## PATH A: Magic Moment Demo (No Pipelines)

**When to use:** Pipelines aren't ready, or time is extremely limited.

**Goal:** Show the VISION, not a working product. Prove the concept is compelling even if the tech isn't ready.

### Demo Script (Path A)

```
"Comics have a character problem.

[Show: Midjourney generating 'anime girl, city street' 3x - different each time]

Every generation gives you a different person.
You can't tell a story if your character changes every panel.

We fixed that.

[Show pre-generated panels of Maya - same character, different scenes]

Same person. Every scene. That's the magic.

[Show static mockup of the UI]

Imagine uploading your character, clicking 'lock', and getting this consistency.
That's Civitai Comics."
```

### What You Need (Path A)

- [ ] 1 well-chosen character with 4-5 reference images (ideally anime/comic style)
- [ ] 5-6 pre-generated panels showing that character in different scenes
  - Standing pose
  - Sitting pose
  - Action pose
  - Different lighting (day/night)
  - Different background
- [ ] 3 comparison images showing Midjourney inconsistency
- [ ] Click-through mockup (Figma or static HTML)

### Screens to Build (Path A)

```
1. LANDING PAGE
   - "Civitai Comics" branding
   - Value prop headline
   - Show the problem (inconsistency)
   - Show the solution (consistent panels)
   - "Coming Soon" or "Sign up for beta"

2. FAKE WORKSPACE
   - Shows a project with pre-made character
   - Shows 4-6 pre-generated panels
   - Clicking doesn't do anything (or shows tooltip "Demo mode")

3. (Optional) FAKE GENERATOR MODAL
   - Shows the UI: character selector, prompt input, generate button
   - Button shows "This is a demo" tooltip
```

### Effort Estimate (Path A)

- Landing page with comparison: 4-6 hours
- Fake workspace with pre-made content: 4-6 hours
- Polish and demo prep: 2-4 hours
- **Total: 8-16 hours**

---

## PATH B: Working Prototype (Pipelines Ready)

**When to use:** ALL pipelines verified working in test environment. 3-5 days of focused work available.

### The Core Loop

```
THE MAGIC MOMENT:

Select/Create character → Describe scene → Generate →
"Holy shit, that's actually the same person!"

Everything else is polish. Ship the loop. Nail the magic.
```

### Character Creation: Two Paths

The MVP supports two ways to add a character to a project:

#### Path 1: Select Existing LoRA (Recommended for Testing)
- User searches/browses their existing character LoRAs on Civitai
- Or selects any public character LoRA
- Instant - no waiting for training
- Great for testing and users who already have character models

#### Path 2: Upload Images → Train LoRA
- User uploads 3-5 reference images
- System auto-triggers LoRA training with pre-configured settings
- Training takes 5-10 minutes
- Good for new characters, but slower

**For hackathon demo:** Use Path 1 with pre-trained LoRAs for reliability.

### Feature Matrix

| Feature | In MVP? | Rationale |
|---------|---------|-----------|
| **Authentication (Civitai SSO)** | ✅ YES | Need user accounts |
| **Dashboard (project list)** | ✅ YES | Need entry point |
| **Create project (name only)** | ✅ YES | Need container |
| **Character from existing LoRA** | ✅ YES | Core - instant, testable |
| **Character from images (train)** | ✅ YES | Core value prop for new users |
| **Single panel generation** | ✅ YES | Core loop |
| **Scene description input** | ✅ YES | Primary interaction |
| **Buzz balance display** | ✅ YES | Cost awareness |
| **Save panel to project** | ✅ YES | Need persistence |
| --- | --- | --- |
| Multiple results (4 variations) | ⚠️ MAYBE | Nice but adds complexity |
| Shot type selector | ⚠️ MAYBE | Could hardcode "medium shot" |
| --- | --- | --- |
| Location lock | ❌ CUT | Describe in prompt |
| Style selection | ❌ CUT | Use default style |
| Style import | ❌ CUT | Too complex |
| Onboarding flow | ❌ CUT | Manual walkthrough |
| Export options | ❌ CUT | Screenshot works |
| Multi-character panels | ❌ CUT | V2 feature |
| Batch generation | ❌ CUT | V2 feature |
| Character variants | ❌ CUT | V2 feature |
| Mobile responsive | ❌ CUT | Desktop only |
| Character from description | ❌ CUT | Requires existing refs |
| Panel reordering | ❌ CUT | Delete and regenerate |
| Advanced options | ❌ CUT | Hardcode sensible defaults |
| Consistency scores | ❌ CUT | Trust the system |

### What's Simplified vs Full Product

| Full Product | Hackathon Version | Impact |
|--------------|-------------------|--------|
| 10-15 reference images | 3-5 images OR existing LoRA | Flexibility over quality |
| Custom training config | Pre-baked training settings | Less control, faster setup |
| 20-30 anchor poses generated | No anchors | Missing core quality feature |
| Composition layer (lighting, shadows) | Raw generation only | "Paper doll" look possible |
| Buzz reservation pattern | Simple balance check | Race conditions possible |
| Full error contract | Basic error messages | Less graceful failures |

**Be honest in demo:** "This shows the core concept. Production will include [anchors, composition, style matching]."

---

## Fallback Chain (Path B)

If Path B hits blockers, fall back gracefully:

```
PRIMARY: Full Path B working prototype
    ↓ (if character pipeline broken by Day 2)
FALLBACK 1: Use pre-created characters (skip upload UI)
    ↓ (if generation pipeline broken by Day 3)
FALLBACK 2: Show UI + pre-generated panels (fake the generation)
    ↓ (if SSO broken on Day 1)
FALLBACK 3: Hardcoded test user (skip auth entirely)
    ↓ (if everything broken)
FALLBACK 4: Path A (click-through demo with slides)
    ↓ (if even that fails)
FALLBACK 5: Video recording of working version + slides
```

**Rule:** At each checkpoint, if the day's goal isn't working, immediately drop to the next fallback. Don't spend Day 3 debugging Day 1 problems.

---

## Technical Architecture (MVP)

### Tech Stack

| Layer | Technology | Notes |
|-------|------------|-------|
| **Frontend** | Next.js 14, React, TypeScript | Same as main Civitai |
| **UI Components** | Mantine v7, Tailwind | Same as main Civitai |
| **State** | Zustand, React Query | Same patterns |
| **API** | tRPC or REST | Keep it simple |
| **Database** | PostgreSQL + Prisma | Minimal schema |
| **Storage** | S3-compatible | For character refs and panels |
| **Auth** | NextAuth (SSO mode) | Civitai as provider |

### MVP Database Schema

**Note:** This is a simplified schema for hackathon speed. Production schema (in `plan-webtoon-comic-creator.md`) is more complete with proper state machines, soft deletes, and audit tables.

```sql
-- Minimal schema for hackathon MVP
-- NOT production-ready - see product plan for full schema

-- Projects (containers for comics)
CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    civitai_user_id INTEGER NOT NULL,
    name VARCHAR(255) NOT NULL,
    status VARCHAR(20) DEFAULT 'active',    -- active, deleted (simplified)
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Characters (one per project for MVP)
-- Supports two creation paths:
--   1. From existing LoRA: model_id is set, status='Ready' immediately
--   2. From images: reference_images set, triggers training, status='Pending'→'Processing'→'Ready'
CREATE TABLE characters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',   -- pending, processing, ready, failed
    source_type VARCHAR(20) DEFAULT 'upload', -- 'upload' or 'existing_model'
    -- For existing LoRA path:
    model_id INTEGER,                        -- Reference to Civitai Model
    model_version_id INTEGER,                -- Reference to specific ModelVersion
    -- For upload/train path:
    reference_images JSONB,                  -- Array of S3 URLs
    training_job_id VARCHAR(100),            -- Training job reference
    trained_model_id INTEGER,                -- Model ID after training completes
    trained_model_version_id INTEGER,        -- ModelVersion ID after training
    -- Common fields:
    error_message TEXT,                      -- If status=failed
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Panels (generated images)
CREATE TABLE panels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    character_id UUID REFERENCES characters(id),
    prompt TEXT NOT NULL,
    image_url VARCHAR(500),
    position INTEGER DEFAULT 0,
    buzz_cost INTEGER DEFAULT 25,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_projects_user ON projects(civitai_user_id);
CREATE INDEX idx_characters_project ON characters(project_id);
CREATE INDEX idx_panels_project ON panels(project_id, position);
```

### API Endpoints (MVP)

#### Internal APIs (Comics App)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/auth/sso` | Initiate Civitai SSO |
| `GET` | `/api/auth/callback` | SSO callback |
| `GET` | `/api/projects` | List user's projects |
| `POST` | `/api/projects` | Create new project |
| `GET` | `/api/projects/:id` | Get project details |
| `POST` | `/api/projects/:id/character` | Upload character refs |
| `POST` | `/api/projects/:id/character/lock` | Start character creation |
| `GET` | `/api/projects/:id/character/status` | Check creation status |
| `POST` | `/api/projects/:id/panels` | Generate new panel |
| `GET` | `/api/projects/:id/panels` | List project panels |
| `GET` | `/api/buzz/balance` | Get user Buzz balance |

#### External APIs (Civitai - Must Exist)

| Method | Endpoint | Description | Priority |
|--------|----------|-------------|----------|
| `POST` | `/auth/sso/authorize` | SSO authorization | REQUIRED |
| `POST` | `/auth/sso/token` | Exchange code for token | REQUIRED |
| `POST` | `/api/face/embed` | Extract face embedding | REQUIRED |
| `POST` | `/api/character/create` | Create character lock | REQUIRED |
| `POST` | `/api/generate/panel` | Generate panel with character | REQUIRED |
| `GET` | `/api/buzz/balance` | Get Buzz balance | NICE TO HAVE |

### File Structure (MVP)

```
src/
├── app/
│   ├── page.tsx                    # Landing/Login
│   ├── dashboard/
│   │   └── page.tsx                # Project list
│   ├── project/
│   │   └── [id]/
│   │       ├── page.tsx            # Workspace
│   │       └── character/
│   │           └── page.tsx        # Character upload
│   └── api/
│       ├── auth/
│       │   ├── [...nextauth].ts
│       │   └── callback.ts
│       ├── projects/
│       │   └── route.ts
│       └── generate/
│           └── route.ts
├── components/
│   ├── CharacterUpload.tsx
│   ├── PanelGenerator.tsx
│   ├── PanelGrid.tsx
│   ├── ProjectCard.tsx
│   └── BuzzBalance.tsx
├── lib/
│   ├── civitai-api.ts              # Civitai API client
│   ├── db.ts                       # Prisma client
│   └── auth.ts                     # NextAuth config
└── types/
    └── index.ts
```

---

## Wireframes

### Screen 1: Login

```
┌─────────────────────────────────────────┐
│                                         │
│         🎨 Civitai Comics               │
│                                         │
│    Create comics with consistent        │
│    characters. No drawing required.     │
│                                         │
│    ┌─────────────────────────────────┐  │
│    │   Sign in with Civitai          │  │
│    └─────────────────────────────────┘  │
│                                         │
└─────────────────────────────────────────┘
```

### Screen 2: Dashboard

```
┌─────────────────────────────────────────┐
│  Civitai Comics                 ⚡ 500   │
├─────────────────────────────────────────┤
│                                         │
│  MY PROJECTS                            │
│                                         │
│  ┌─────────────┐  ┌─────────────┐      │
│  │             │  │             │      │
│  │ + New       │  │ My Project  │      │
│  │ Project     │  │ 2 panels    │      │
│  │             │  │             │      │
│  └─────────────┘  └─────────────┘      │
│                                         │
└─────────────────────────────────────────┘
```

### Screen 3: New Project (Modal)

```
┌─────────────────────────────────────────┐
│  New Project                      [✕]   │
├─────────────────────────────────────────┤
│                                         │
│  Project name:                          │
│  ┌─────────────────────────────────────┐│
│  │ My First Comic                      ││
│  └─────────────────────────────────────┘│
│                                         │
│  ┌─────────────────────────────────────┐│
│  │           [Create Project]          ││
│  └─────────────────────────────────────┘│
│                                         │
└─────────────────────────────────────────┘
```

### Screen 4: Character Upload

```
┌─────────────────────────────────────────┐
│  ← My First Comic                       │
├─────────────────────────────────────────┤
│                                         │
│  ADD YOUR CHARACTER                     │
│                                         │
│  Upload 3-5 reference images.           │
│  Same character, different angles.      │
│                                         │
│  ┌─────────────────────────────────────┐│
│  │                                     ││
│  │    📷 Drop images here              ││
│  │    or click to browse               ││
│  │                                     ││
│  └─────────────────────────────────────┘│
│                                         │
│  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐      │
│  │ img │ │ img │ │ img │ │     │      │
│  └─────┘ └─────┘ └─────┘ └─────┘      │
│                                         │
│  TIPS FOR GOOD REFERENCES:              │
│  • Clear, front-facing view             │
│  • Same character in all images         │
│  • Different angles help                │
│                                         │
│  ┌─────────────────────────────────────┐│
│  │     [Create Character] 50 ⚡        ││
│  └─────────────────────────────────────┘│
│                                         │
└─────────────────────────────────────────┘
```

### Screen 4b: Character Processing

```
┌─────────────────────────────────────────┐
│  ← My First Comic                       │
├─────────────────────────────────────────┤
│                                         │
│  CREATING YOUR CHARACTER                │
│                                         │
│  ┌─────────────────────────────────────┐│
│  │                                     ││
│  │       [Character preview]           ││
│  │                                     ││
│  └─────────────────────────────────────┘│
│                                         │
│  ▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░  55%             │
│                                         │
│  Creating your character...             │
│  • Analyzing face ✓                    │
│  • Learning features ●                 │
│  • Finishing up                        │
│                                         │
│  This takes about 30 seconds.          │
│                                         │
└─────────────────────────────────────────┘
```

### Screen 5: Workspace

```
┌─────────────────────────────────────────┐
│  ← My First Comic              ⚡ 500    │
├─────────────────────────────────────────┤
│                                         │
│  CHARACTER                              │
│  ┌─────┐ Maya ✓ Ready                  │
│  │ 👤  │                               │
│  └─────┘                                │
│                                         │
│  PANELS                                 │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐  │
│  │         │ │         │ │         │  │
│  │ Panel 1 │ │ Panel 2 │ │    +    │  │
│  │         │ │         │ │  Add    │  │
│  │         │ │         │ │  Panel  │  │
│  └─────────┘ └─────────┘ └─────────┘  │
│                                         │
└─────────────────────────────────────────┘
```

### Screen 6: Panel Generator (Modal)

```
┌─────────────────────────────────────────┐
│  Generate Panel                   [✕]   │
├─────────────────────────────────────────┤
│                                         │
│  CHARACTER: Maya ✓                      │
│                                         │
│  DESCRIBE THE SCENE:                    │
│  ┌─────────────────────────────────────┐│
│  │ Maya standing on a rooftop at      ││
│  │ sunset, wind blowing her hair,     ││
│  │ looking determined                  ││
│  │                                     ││
│  └─────────────────────────────────────┘│
│                                         │
│  ┌─────────────────────────────────────┐│
│  │      [Generate]  25 ⚡              ││
│  └─────────────────────────────────────┘│
│                                         │
│  Your balance: 500 ⚡                   │
│                                         │
└─────────────────────────────────────────┘
```

### Screen 6b: Generation Result

```
┌─────────────────────────────────────────┐
│  Generate Panel                   [✕]   │
├─────────────────────────────────────────┤
│                                         │
│  ┌─────────────────────────────────────┐│
│  │                                     ││
│  │                                     ││
│  │       [Generated Panel]             ││
│  │                                     ││
│  │                                     ││
│  └─────────────────────────────────────┘│
│                                         │
│  ┌──────────────┐ ┌──────────────┐     │
│  │ [Regenerate] │ │ [Use This]   │     │
│  │    25 ⚡     │ │              │     │
│  └──────────────┘ └──────────────┘     │
│                                         │
└─────────────────────────────────────────┘
```

---

## Development Sequence (Path B)

### Prerequisites (Before Day 1)

- [ ] All pipelines verified working (see checklist above)
- [ ] Test character created via API (proves it works)
- [ ] SSO test account working
- [ ] Development environment ready
- [ ] Database provisioned
- [ ] S3 bucket ready

**If prerequisites not met → Switch to Path A (Magic Moment Demo)**

### Day-by-Day Schedule

```
DAY 1 (Setup + Auth) - ~8 hours
├── Project setup (Next.js, Prisma, basic routing)
├── Civitai SSO integration
├── Dashboard page (static)
├── Basic project CRUD (create, list, get)
└── ⚠️ CHECKPOINT (by hour 6): Can user sign in and see dashboard?
    └── IF NO by hour 4: Use hardcoded test user, skip SSO
    └── IF NO by hour 6: Fall back to Path A

DAY 2 (Character System) - ~10 hours
├── Character upload UI (dropzone, preview)
├── Upload to S3
├── Connect to character creation pipeline
├── Processing state UI (progress bar)
├── Store character data
└── ⚠️ CHECKPOINT (by hour 8): Can user upload and create character?
    └── IF NO by hour 6: Use pre-created characters (skip upload)
    └── IF NO by hour 8: Fall back to showing UI only with fake data

DAY 3 (Generation) - ~10 hours
├── Panel generator modal UI
├── Connect to generation pipeline
├── Loading/processing states
├── Display generated result
├── Save panel to project
└── ⚠️ CHECKPOINT (by hour 8): Can user generate panel with their character?
    └── IF NO by hour 6: Use pre-generated panels, fake the generation
    └── IF NO by hour 8: Fall back to Path A with working UI screenshots

DAY 4 (Integration + Debug) - ~8 hours
├── Workspace view with saved panels
├── Panel grid layout
├── End-to-end testing
├── Bug fixes
├── Error states and edge cases
└── ⚠️ CHECKPOINT: Full flow works reliably?

DAY 5 (Demo Prep) - ~4 hours
├── Final testing
├── Demo script walkthrough
├── Prepare backup examples (pre-generated)
├── Practice demo 3x
└── Identify potential failure points
```

**Total: 5 days (~40 hours of focused work)**

**Fallback at any checkpoint:** If blocked, switch to Path A with whatever is working.

---

## Success Criteria

### MUST WORK (Demo Blockers)

- [ ] User can sign in with Civitai
- [ ] User can create a project
- [ ] User can upload 3+ character images
- [ ] Character creation completes (may take ~30-60 sec)
- [ ] User can describe a scene
- [ ] Panel generates with the character reference
- [ ] **Character looks recognizably the same across 2+ panels**
- [ ] Panel saves to project

### NICE TO HAVE

- [ ] Buzz balance display
- [ ] 4 result variations instead of 1
- [ ] Regenerate option
- [ ] Multiple panels visible in grid

### NOT IN MVP

- [ ] Mobile responsiveness
- [ ] Location/background locking
- [ ] Style selection
- [ ] Export to PNG/PDF
- [ ] Multi-character panels
- [ ] Anything not listed above

---

## Demo Script (Both Paths)

```
"Comics have a character problem.

[Show: Midjourney generating 'anime girl, city street' 3x - different each time]

Every generation gives you a different person.
You can't tell a story if your character changes every panel.

We fixed that.

[Open Civitai Comics, create project]

First, I upload images of my character - Maya.

[Upload 4 reference images]

Now we lock her appearance. This takes about 30 seconds.

[Show processing]

Done. Now watch this.

[Type: 'Maya standing on rooftop at sunset, determined expression']
[Generate]

That's Maya. Now let's try a completely different scene.

[Type: 'Maya sitting in a cafe, looking thoughtful']
[Generate]

[Show both panels side by side]

Same person. Different scenes.
That's the magic - consistent characters, any scenario.

[Type: 'Maya running through rain, worried expression']
[Generate]

Three panels. One character. One story.

That's Civitai Comics."
```

### Fallback (If Live Generation Fails)

Always have these ready, even if prototype works:
- Pre-generated panels for demo character (5-6 panels, different scenes)
- Screenshots of each UI screen
- Script that works with static images

If generation fails during demo:
1. "Let me show you what this would look like..."
2. Switch to pre-generated examples
3. Continue with the same script

**Never let the demo die. Always have a backup.**

---

## Error Handling (MVP)

### Character Creation Failures

| Error | User Message | Action |
|-------|--------------|--------|
| Face not detected | "We couldn't detect a face. Try clearer images." | Let user re-upload |
| API timeout | "Taking longer than expected. Please wait..." | Retry with backoff |
| Server error | "Something went wrong. Please try again." | Show retry button |

### Generation Failures

| Error | User Message | Action |
|-------|--------------|--------|
| Insufficient Buzz | "Not enough Buzz. Need 25, you have X." | Link to get more |
| API timeout | "Generation is taking a while. Still working..." | Show progress |
| Server error | "Generation failed. Not charged." | Show retry button |

### SSO Failures

| Error | User Message | Action |
|-------|--------------|--------|
| Auth failed | "Couldn't sign in. Please try again." | Retry SSO flow |
| Token expired | (Silent) | Auto-refresh token |

---

## Buzz Pricing (MVP)

| Operation | Buzz Cost | Notes |
|-----------|-----------|-------|
| Character creation | 50 | One-time per character |
| Panel generation | 25 | Per panel |
| Regenerate panel | 25 | Same cost |

**Demo Account:** Ensure demo account has 500+ Buzz for uninterrupted demo.

---

## Pre-Hackathon Checklist

### MUST DO: API Verification (Before Anything Else)

**This is the #1 risk. Do not skip.**

- [ ] **Get written API specs from Civitai backend team**
  - Exact endpoint URLs (not assumptions!)
  - Request/response formats with examples
  - Authentication requirements (service token vs user token)
  - Rate limits
- [ ] **Curl test each endpoint** - don't proceed until all return expected responses
- [ ] **Confirm character creation latency** - is it 30s or 5-10min? Plan accordingly
- [ ] **Confirm Buzz handling** - do we need reservation pattern or just balance check?

### Week Before

- [ ] Get SSO working in test environment BEFORE hackathon
- [ ] Create 3 demo accounts with Buzz pre-loaded (500+ each)
- [ ] Test token refresh flow (not just login)
- [ ] Create 5 test characters via API, verify output quality
- [ ] Generate 20+ test panels, measure consistency rate
- [ ] Identify which prompts produce best results (curate for demo)
- [ ] Measure actual latencies (character creation, generation)
- [ ] Pre-generate fallback demo materials (5-6 panels for demo character)
- [ ] Set up dev environment completely
- [ ] Provision database and S3 bucket
- [ ] Record video of working generation flow as ultimate fallback

### Day Before

- [ ] Final pipeline health check
- [ ] Pre-generate backup demo panels (5-6 different scenes)
- [ ] Take screenshots of UI at each step
- [ ] Practice demo script 2x
- [ ] Verify backup laptop/setup
- [ ] Ensure demo account has enough Buzz

### Demo Day

- [ ] Network connectivity test
- [ ] Quick generation test (1 panel)
- [ ] Verify fallback materials are accessible
- [ ] Demo script printed/accessible
- [ ] Water bottle ready 😅

---

## Post-Hackathon

### If Demo Succeeds

1. Gather feedback on character consistency quality
2. Note which prompts worked best
3. Document any edge cases or failures
4. Discuss timeline for full product development

### If Demo Fails

1. Document what broke and why
2. Identify which pipelines need work
3. Gather feedback on the vision (Path A demo)
4. Adjust technical approach for next iteration

---

## Related Documents

- **Full Product Plan:** `docs/plan-webtoon-comic-creator.md`
- **UX Design:** `docs/ux-design-comic-creator.md`
- **Pipeline Requirements:** UX doc, Appendix C

---

## Quick Reference

### Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| One character per project | YES | Simplify for MVP |
| No style selection | YES | Use default, reduce complexity |
| No mobile | YES | Desktop-only for demo |
| No export | YES | Screenshot works |
| Auto-approve character | YES | Skip anchor review for MVP |

### Hardcoded Defaults (MVP)

| Setting | Hardcoded Value |
|---------|-----------------|
| Style | Default/anime |
| Shot type | Medium shot |
| Aspect ratio | 3:4 (portrait) |
| Generation count | 1 (not 4) |
| Max character refs | 5 images |
| Min character refs | 3 images |

### API Response Times (Target)

| Operation | Target | Maximum |
|-----------|--------|---------|
| SSO flow | <3s | 5s |
| Character creation | <30s | 60s |
| Panel generation | <15s | 30s |
| Page load | <2s | 3s |

---

## Known Discrepancies with Product Plan

These are intentional simplifications for hackathon speed. Production must address them.

| Area | Hackathon | Product Plan | Resolution |
|------|-----------|--------------|------------|
| **Reference images** | 3-5 | 10-15 | Production uses more for quality |
| **Character creation** | IP-Adapter embedding only (~30s) | LoRA training + anchors (5-10 min) | Different approaches - verify which backend provides |
| **Anchor generation** | Skipped | 20-30 anchors required | Core quality feature missing in hackathon |
| **Composition layer** | Raw generation | Lighting, depth, shadows | Hackathon will look "paper doll" compared to production |
| **Buzz handling** | Simple balance check | Reserve/commit/release pattern | Race conditions possible in hackathon |
| **Database schema** | Minimal | Full with soft deletes, audit | Hackathon schema is throwaway |
| **API endpoints** | Assumed names | May differ | VERIFY BEFORE STARTING |
| **SSO integration** | Happy path only | Full with refresh, logout sync | Hackathon will break on edge cases |

**These are acceptable tradeoffs for a hackathon demo.** The goal is to prove the concept works, not build production code.
