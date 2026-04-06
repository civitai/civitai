# Product Plan: AI Webtoon/Comic Creator

**Date:** January 2026
**Status:** Draft v4.1 - Hybrid Architecture Hardened (Post-Review)
**Product Name:** Civitai Comics
**Domain:** comics.civitai.com (separate app, shared services)

---

## Executive Summary

Build an AI-powered webtoon/comic creation platform that enables anyone to create professional-quality comics using Civitai's community models. The core differentiators are:

1. **Character Consistency** - Import or create a main character that remains visually consistent across all panels
2. **Environment Creation with Style Matching** - Generate backgrounds that automatically match your character's art style

These solve the two biggest pain points in AI comic generation: characters that look different in every panel, and environments that clash with character art styles.

**Architecture:** Hybrid approach - separate frontend application at `comics.civitai.com` with shared Civitai backend services (auth, Buzz, generation, models).

**Target Launch:** Q4 2026 / Q1 2027 (revised from Q3/Q4 2026)
**MVP Timeline:** 36-41 weeks (includes 5 weeks for SSO/Buzz integration + testing)
**Critical Milestone:** 6-week technical validation sprint before full development commitment

---

## Revision Notes

### v4.1 Changes (Post-Review - Hybrid Architecture Hardening)

| Area | v4 | v4.1 | Rationale |
|------|-----|------|-----------|
| MVP Timeline | 28-32 weeks | 36-41 weeks | SSO/Buzz integration underestimated, composition layer needs more time |
| SSO Integration | 2 weeks | 5 weeks | Token refresh, cross-domain cookies, logout sync, browser testing |
| Buzz Integration | Included in SSO | Explicit reservation system | Need atomic transactions with generation pipeline |
| Backend Engineers | 1 | 2 | Hybrid architecture requires integration + app development in parallel |
| Database Schema | Basic | Complete with junction tables, indexes | Review identified missing tables and referential integrity gaps |
| API Contracts | Partial | Full with error handling | Missing webhooks, rate limits, error contracts |
| Hybrid Risks | None | 10+ identified | Service boundaries, data drift, auth compromise |

### v4 Changes (Hybrid Architecture)

| Area | v3 | v4 | Rationale |
|------|-----|-----|-----------|
| Architecture | Unspecified | Hybrid (separate app, shared services) | Best of both worlds - dedicated UI, shared ecosystem |
| Domain | N/A | comics.civitai.com | Clear branding, separate deployment |
| MVP Timeline | 26-30 weeks | 28-32 weeks | Added 2 weeks for SSO/Buzz integration |
| Auth | N/A | SSO with Civitai | Single account for users |
| Database | N/A | Separate DB for comics, shared for users/models | Clean separation of concerns |

### v3 Changes (Environment System)

| Area | v2 | v3 | Rationale |
|------|-----|-----|-----------|
| MVP Timeline | 20-24 weeks | 22-26 weeks | Added environment system |
| Scope | Character-only | Character + Environment | Users struggle to create matching backgrounds |
| Style System | Style selection only | Style extraction + matching | Let users import styles they already like |
| Location Lock | Phase 2 | MVP | Critical for scene continuity |

### v2 Changes (Post-Review)

This plan has been revised based on critical feedback from external agent reviews. Key changes:

| Area | Original | Revised | Rationale |
|------|----------|---------|-----------|
| MVP Timeline | 10-12 weeks | 20-24 weeks | Character consistency is harder than initially estimated |
| Revenue Projections | $3M-$48M Y1 | $100K-$1.2M Y1 | Original projections were unrealistic |
| Technical Approach | IP-Adapter focused | Hybrid multi-model | No single approach solves consistency |
| MVP Scope | Full comic editor | Core character + basic panels | De-risk before building full product |
| Free Tier | 10 panels/month | 50 panels/month | Original too restrictive to demonstrate value |
| Pre-Development | None | 6-week validation sprint | Must validate tech + market before committing |

---

## Market Opportunity

### Market Size

| Metric | Value | Source |
|--------|-------|--------|
| Webtoons Market (2025) | $9-11B | Mordor Intelligence, IMARC |
| Projected (2030-33) | $48-97B | Multiple sources |
| CAGR | 28-35% | Fastest growing content format |
| AI Comic Generator Market | Growing rapidly | Technavio |

### Market Dynamics

- **APAC Leadership**: South Korea and Japan lead adoption; studios report 30% output increase with AI tools
- **Global Expansion**: Webtoons expanding beyond Asia into Western markets
- **Creator Economy**: Platforms like Webtoon, Tapas, Lezhin paying creators based on readership
- **Investment Signal**: GeneraToon raised $50M Series B (Feb 2025) for manga/webtoon AI

### Target Users (Revised - Focus on Prosumers)

| Segment | Size | Pain Level | Value | MVP Priority |
|---------|------|------------|-------|--------------|
| **Regular Webtoon Publishers** | 100K+ | VERY HIGH | HIGH | PRIMARY |
| **Indie Comic Creators** | 500K+ | HIGH | HIGH | PRIMARY |
| **Content Agencies** | 50K+ | MEDIUM | VERY HIGH | SECONDARY |
| **Writers Who Can't Draw** | 50M+ | VERY HIGH | Medium | SECONDARY |
| **Aspiring Creators** | 10M+ | HIGH | Low | TERTIARY |

**Positioning Shift**: Focus on "serious creators ship faster" not "anyone can make comics."

### Pain Points

1. **Can't Draw**: Writers have stories but no art skills
2. **Cost Prohibitive**: Professional webtoon art costs $50-200+ per panel
3. **Character Inconsistency**: Current AI can't maintain character appearance across panels (THE #1 PROBLEM)
4. **Environment Style Mismatch**: Users have characters they like but can't create backgrounds that match the style (THE #2 PROBLEM)
5. **Time Intensive**: Manual comic creation takes weeks/months per chapter
6. **Style Limitations**: Generic AI outputs don't match specific manga/manhwa aesthetics
7. **Location Inconsistency**: The same room looks different in every panel

---

## Competitive Analysis

### Direct Competitors (Expanded)

| Competitor | Funding | Strengths | Weaknesses | Pricing |
|------------|---------|-----------|------------|---------|
| **Anifusion** | Unknown | Manga-focused, panel layouts | Limited styles, weak consistency | ~$20/mo |
| **KomikoAI** | Unknown | OC creation, anime focus | Early stage, basic | Freemium |
| **Dashtoon** | $5M | Working character consistency, publishing | Limited style variety | Varies |
| **LlamaGen** | Unknown | Story-to-comic pipeline | Generic, inconsistent | Varies |
| **ComicsMaker.AI** | Unknown | Consistency focus | Gaining traction | Varies |
| **Canva (AI Comics)** | Well-funded | Massive distribution | Generic, not specialized | $13/mo |
| **Midjourney + Manual** | Well-funded | High quality | No comic workflow | $10-30/mo |

### The Core Problem: Character Consistency

**No tool reliably maintains character appearance across multiple panels/pages.**

Why it's hard:
- Character appearance changes with pose/angle
- Style LoRAs fight against character embeddings
- Face vs full-body consistency require different approaches
- Clothing/accessories drift across generations
- Background elements can override character features

**Current solutions and their limitations:**

| Approach | Consistency | Speed | Flexibility | Real-World Quality |
|----------|-------------|-------|-------------|-------------------|
| IP-Adapter | 60-70% | Fast | High | Faces good, bodies drift |
| InstantID | 75-85% faces | Fast | Medium | Excellent faces, no body |
| Character LoRA | 80-90% | Slow (training) | Low | Best quality, slow iteration |
| Reference Injection | 50-65% | Fast | High | Highly variable |
| Manual Editing | 95%+ | Very Slow | Low | Professional but defeats purpose |

**Civitai's Opportunity**: Hybrid approach using multiple techniques + existing LoRA infrastructure.

### Why Civitai Can Win (Realistic Assessment)

| Advantage | Strength | Notes |
|-----------|----------|-------|
| **Style Library** | MEDIUM | Many models, but few are comic-optimized |
| **Character LoRA Infrastructure** | STRONG | Real technical advantage |
| **Community Creators** | MEDIUM | Need to recruit comic-specific creators |
| **Technical Foundation** | STRONG | Generation pipeline ready |
| **User Base** | MEDIUM | 10M users, but ~1-2% want comics |

**True Moat**: If we solve character consistency well, THAT is the moat.

---

## Product Vision

### Core Value Proposition

> "Turn your story into a webtoon. Import your character, write your script, and let AI create consistent, professional panels in any style - manga, manhwa, Western comics, or your own."

### Key Differentiators

1. **Character Lock System**: Import/create a character that stays consistent across ALL panels (85%+ target)
2. **Environment System with Style Matching**: Create backgrounds that automatically match your character's art style
3. **Style Import**: Upload images you like → system extracts and applies that style to everything
4. **Location Lock**: Save and reuse consistent locations across your comic
5. **Creator Economy**: Style creators earn when their models are used

---

## System Architecture (Hybrid Approach)

### Architecture Decision

**Decision:** Build Civitai Comics as a **separate frontend application** with **shared Civitai backend services**.

**Why not fully integrated into Civitai?**
- Comic creation needs dedicated UI (panels, timelines, layers) that doesn't fit existing navigation
- Would add significant complexity to main codebase
- Risk to main platform if comic features have issues
- Different user journey than model browsing

**Why not 100% separate?**
- Would lose Civitai ecosystem benefits (Buzz, models, auth, community)
- Users would need two accounts
- Would rebuild infrastructure that already exists
- Disconnected from Civitai brand and trust

**Hybrid gives us:**
- Dedicated comic creation UI at `comics.civitai.com`
- Single user account (SSO with Civitai)
- Shared Buzz economy
- Access to all community models/LoRAs
- Risk isolation (if comics fails, main site unaffected)
- Faster iteration without affecting main platform

### System Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         USER EXPERIENCE                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌───────────────────────┐              ┌───────────────────────┐       │
│  │    civitai.com        │              │  comics.civitai.com   │       │
│  │    (Main Site)        │◄────────────►│   (Comic Creator)     │       │
│  │                       │    Shared    │                       │       │
│  │  • Browse models      │    Login     │  • Create projects    │       │
│  │  • Upload images      │    Shared    │  • Build characters   │       │
│  │  • Community          │    Buzz      │  • Design panels      │       │
│  │  • Creator dashboard  │              │  • Export comics      │       │
│  └───────────────────────┘              └───────────────────────┘       │
│              │                                      │                    │
│              │         Cross-linking                │                    │
│              │    "Use this LoRA in Comics" ───────►│                    │
│              │◄─── "Browse more styles"             │                    │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                         BACKEND SERVICES                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  SHARED SERVICES (Civitai Core)        COMICS-SPECIFIC SERVICES         │
│  ┌─────────────────────────┐          ┌─────────────────────────┐      │
│  │                         │          │                         │      │
│  │  Authentication (SSO)   │          │  Comic Projects DB      │      │
│  │  ├─ User accounts       │          │  ├─ Projects            │      │
│  │  ├─ Sessions            │          │  ├─ Characters          │      │
│  │  └─ Permissions         │          │  ├─ Locations           │      │
│  │                         │          │  ├─ Panels/Pages        │      │
│  │  Buzz Economy           │◄────────►│  └─ Style presets       │      │
│  │  ├─ Balance             │          │                         │      │
│  │  ├─ Transactions        │          │  Comic Generation       │      │
│  │  └─ Creator earnings    │          │  ├─ Character lock      │      │
│  │                         │          │  ├─ Style extraction    │      │
│  │  Generation Services    │◄────────►│  ├─ Composition layer   │      │
│  │  ├─ NanoBanana          │          │  └─ Quality scoring     │      │
│  │  ├─ Orchestration       │          │                         │      │
│  │  └─ Queue management    │          │  Export Services        │      │
│  │                         │          │  ├─ PNG/PDF export      │      │
│  │  Model/LoRA Database    │◄────────►│  ├─ Webtoon format      │      │
│  │  ├─ Community models    │          │  └─ Publishing APIs     │      │
│  │  ├─ Style LoRAs         │          │                         │      │
│  │  └─ Character LoRAs     │          └─────────────────────────┘      │
│  │                         │                                            │
│  │  Content Moderation     │                                            │
│  │  ├─ NSFW detection      │                                            │
│  │  ├─ Copyright check     │                                            │
│  │  └─ Moderation queue    │                                            │
│  │                         │                                            │
│  └─────────────────────────┘                                            │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### What's Shared vs. Separate

| Component | Shared (Civitai Core) | Separate (Comics App) |
|-----------|----------------------|----------------------|
| **Authentication** | ✓ SSO provider | Uses SSO client |
| **User Profiles** | ✓ Master record | Read-only access |
| **Buzz Economy** | ✓ Balance & transactions | Charges via API |
| **Models/LoRAs** | ✓ Database & files | Browse via API |
| **Generation** | ✓ NanoBanana, GPU pool | Custom pipelines on top |
| **Content Moderation** | ✓ Shared queue | Submits for review |
| **Frontend** | Main Civitai UI | ✓ Dedicated comic editor |
| **Projects Database** | - | ✓ Own PostgreSQL |
| **Character/Location Data** | - | ✓ Own storage |
| **Panel/Page Storage** | - | ✓ Own S3 bucket |
| **Comic-specific APIs** | - | ✓ Own API routes |
| **Export System** | - | ✓ Own service |

### Database Schema (Comics-Specific)

```sql
-- Comics app has its own database, separate from main Civitai
-- Note: All civitai_* fields reference external IDs - no foreign key enforcement

-- ============================================================
-- CORE TABLES
-- ============================================================

-- Projects table
CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    civitai_user_id INTEGER NOT NULL,       -- References Civitai user (external)
    name VARCHAR(255) NOT NULL,
    description TEXT,
    status VARCHAR(20) DEFAULT 'active',    -- draft, active, archived, deleted
    style_embedding JSONB,                  -- Extracted/imported style
    project_style_lora_id INTEGER,          -- References Civitai LoRA (external)
    last_generation_at TIMESTAMP,           -- For usage tracking, cleanup
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    deleted_at TIMESTAMP                    -- Soft delete
);

-- Characters (locked to project)
CREATE TABLE characters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    status VARCHAR(20) DEFAULT 'active',    -- active, training, failed, archived
    reference_images JSONB,                 -- S3 URLs of uploaded refs
    civitai_lora_id INTEGER,                -- Civitai LoRA if trained (external)
    civitai_training_job_id VARCHAR(100),   -- Link to training status
    face_embedding JSONB,
    body_embedding JSONB,
    outfit_embedding JSONB,
    anchor_images JSONB,                    -- Pre-generated anchors
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    deleted_at TIMESTAMP
);

-- Locations (locked to project)
CREATE TABLE locations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    style_embedding JSONB,                  -- Can override project style
    depth_map_url VARCHAR(500),
    lighting_presets JSONB,                 -- Day, night, etc.
    camera_presets JSONB,                   -- Standard, dramatic, overhead
    anchor_images JSONB,                    -- Pre-generated variants
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    deleted_at TIMESTAMP
);

-- Pages/Chapters
CREATE TABLE pages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    chapter_number INTEGER DEFAULT 1,
    page_number INTEGER NOT NULL,
    status VARCHAR(20) DEFAULT 'draft',     -- draft, complete, exported
    layout_template VARCHAR(50),            -- 4-panel, 6-panel, etc.
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Individual panels
CREATE TABLE panels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,              -- Order on page
    location_id UUID REFERENCES locations(id) ON DELETE SET NULL,
    prompt TEXT,
    image_url VARCHAR(500),
    thumbnail_url VARCHAR(500),
    consistency_score FLOAT,
    buzz_cost INTEGER,                      -- Actual cost incurred
    generation_params JSONB,                -- Seeds, settings, etc.
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Junction table: Characters in panels (replaces UUID[] array)
CREATE TABLE panel_characters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    panel_id UUID NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
    character_id UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    position_x FLOAT DEFAULT 0.5,           -- 0-1 normalized position
    position_y FLOAT DEFAULT 0.5,
    scale FLOAT DEFAULT 1.0,
    z_index INTEGER DEFAULT 0,              -- Layering order
    UNIQUE (panel_id, character_id)
);

-- Style imports
CREATE TABLE imported_styles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name VARCHAR(255),
    source_images JSONB,                    -- Reference images used
    style_embedding JSONB,
    civitai_matched_lora_id INTEGER,        -- Civitai LoRA if matched (external)
    preview_images JSONB,                   -- Generated previews
    created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- TRACKING & AUDIT TABLES
-- ============================================================

-- Generation jobs (all generation attempts)
CREATE TABLE generations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    panel_id UUID REFERENCES panels(id) ON DELETE SET NULL,
    civitai_job_id VARCHAR(100),            -- Civitai generation job ID
    buzz_reservation_id VARCHAR(100),       -- For atomic Buzz handling
    status VARCHAR(20) DEFAULT 'pending',   -- pending, processing, completed, failed
    type VARCHAR(30) NOT NULL,              -- panel, character_anchor, location_anchor, style_preview
    prompt TEXT,
    params JSONB,
    result_urls JSONB,                      -- Array of generated image URLs
    consistency_scores JSONB,               -- Scores for each result
    buzz_cost INTEGER,
    error_message TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    completed_at TIMESTAMP
);

-- Buzz transaction log (local record for reconciliation)
CREATE TABLE buzz_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    civitai_user_id INTEGER NOT NULL,
    generation_id UUID REFERENCES generations(id) ON DELETE SET NULL,
    civitai_transaction_id VARCHAR(100),    -- Civitai's transaction ID
    type VARCHAR(20) NOT NULL,              -- reserve, commit, release, refund
    amount INTEGER NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',   -- pending, completed, failed
    created_at TIMESTAMP DEFAULT NOW(),
    completed_at TIMESTAMP
);

-- Export jobs
CREATE TABLE export_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    civitai_user_id INTEGER NOT NULL,
    format VARCHAR(20) NOT NULL,            -- png, pdf, webtoon
    pages UUID[],                           -- Specific pages or null for all
    status VARCHAR(20) DEFAULT 'pending',   -- pending, processing, completed, failed
    result_url VARCHAR(500),
    error_message TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    completed_at TIMESTAMP
);

-- User preferences (comics-specific settings)
CREATE TABLE user_preferences (
    civitai_user_id INTEGER PRIMARY KEY,
    default_style_id UUID REFERENCES imported_styles(id) ON DELETE SET NULL,
    ui_preferences JSONB,                   -- Theme, layout, shortcuts
    generation_preferences JSONB,           -- Default params
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Style classifier cache
CREATE TABLE style_analysis_cache (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    image_hash VARCHAR(64) NOT NULL UNIQUE, -- SHA-256 of image
    style_embedding JSONB,
    style_tags JSONB,                       -- Taxonomy classification
    matched_lora_ids INTEGER[],             -- Top matching Civitai LoRAs
    match_scores FLOAT[],
    created_at TIMESTAMP DEFAULT NOW()
);

-- Panel version history (for undo/redo)
CREATE TABLE panel_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    panel_id UUID NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    image_url VARCHAR(500),
    thumbnail_url VARCHAR(500),
    generation_id UUID REFERENCES generations(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE (panel_id, version_number)
);

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX idx_projects_user ON projects(civitai_user_id);
CREATE INDEX idx_projects_status ON projects(status) WHERE deleted_at IS NULL;
CREATE INDEX idx_characters_project ON characters(project_id);
CREATE INDEX idx_characters_lora ON characters(civitai_lora_id) WHERE civitai_lora_id IS NOT NULL;
CREATE INDEX idx_locations_project ON locations(project_id);
CREATE INDEX idx_pages_project ON pages(project_id, chapter_number, page_number);
CREATE INDEX idx_panels_page ON panels(page_id, position);
CREATE INDEX idx_panels_location ON panels(location_id) WHERE location_id IS NOT NULL;
CREATE INDEX idx_panel_characters_panel ON panel_characters(panel_id);
CREATE INDEX idx_panel_characters_character ON panel_characters(character_id);
CREATE INDEX idx_generations_project ON generations(project_id);
CREATE INDEX idx_generations_status ON generations(status) WHERE status IN ('pending', 'processing');
CREATE INDEX idx_buzz_transactions_user ON buzz_transactions(civitai_user_id);
CREATE INDEX idx_export_jobs_user ON export_jobs(civitai_user_id);
CREATE INDEX idx_style_cache_hash ON style_analysis_cache(image_hash);

-- ============================================================
-- DATA SYNCHRONIZATION
-- ============================================================

-- Track external Civitai resources for orphan detection
CREATE TABLE civitai_resource_refs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    resource_type VARCHAR(20) NOT NULL,     -- user, lora
    civitai_id INTEGER NOT NULL,
    last_verified_at TIMESTAMP DEFAULT NOW(),
    is_orphaned BOOLEAN DEFAULT FALSE,
    orphaned_at TIMESTAMP,
    UNIQUE (resource_type, civitai_id)
);

-- Scheduled job should:
-- 1. On user.deleted webhook: Mark all user projects as deleted, set orphaned
-- 2. On lora.deleted webhook: Mark characters using it as orphaned
-- 3. Daily reconciliation: Verify active resources still exist in Civitai
```

### API Integration Points

#### Authentication APIs

| Civitai API | Comics Usage | Auth | Notes |
|-------------|--------------|------|-------|
| `POST /auth/sso/authorize` | Initiate SSO login | Public | Returns auth code |
| `POST /auth/sso/token` | Exchange code for tokens | Public | Returns access + refresh tokens |
| `POST /auth/sso/refresh` | Refresh expired access token | Refresh Token | **Critical for session continuity** |
| `POST /auth/sso/validate` | Validate token is still valid | Access Token | Call before sensitive operations |
| `POST /auth/sso/revoke` | Logout / invalidate tokens | Access Token | Sync logout across platforms |
| `POST /webhooks/subscribe` | Register for user events | Service Token | User deletion, permission changes |

**SSO Implementation Requirements:**
- Token refresh must happen automatically before expiry (use 80% of TTL as trigger)
- Cross-domain cookies: Use `SameSite=None; Secure` with CORS allow-credentials
- Logout sync: Civitai calls webhook when user logs out, comics invalidates local session
- Session storage: Store tokens in httpOnly cookies, not localStorage

#### Buzz Economy APIs (Reservation Pattern)

| Civitai API | Comics Usage | Auth | Notes |
|-------------|--------------|------|-------|
| `GET /users/{id}/buzz` | Check Buzz balance | Access Token | Real-time balance |
| `POST /buzz/reserve` | Reserve Buzz before generation | Service Token | Returns `reservation_id`, holds for 5 min |
| `POST /buzz/commit` | Confirm charge after success | Service Token | Requires `reservation_id` |
| `POST /buzz/release` | Cancel reservation (on failure) | Service Token | Auto-releases after timeout |
| `GET /buzz/transactions` | Get transaction history | Access Token | For user dashboard |

**Why Reservation Pattern:**
```
Without reservation (PROBLEM):
1. Generation starts (costs 25 Buzz)
2. Generation succeeds
3. Buzz charge fails (user now has 0 balance)
4. User got free generation OR generation orphaned

With reservation (SOLUTION):
1. POST /buzz/reserve (25 Buzz) → reservation_id
2. If reserve fails → show "insufficient Buzz" immediately
3. Generation starts with reservation_id
4. On success: POST /buzz/commit → charge confirmed
5. On failure: POST /buzz/release → Buzz returned
6. Timeout: auto-release after 5 minutes
```

#### Generation & Model APIs

| Civitai API | Comics Usage | Auth | Notes |
|-------------|--------------|------|-------|
| `GET /models` | Browse available models | Access Token | Filter: `?type=lora&tags=comic` |
| `GET /models/{id}` | Get model details | Access Token | Includes download URL |
| `POST /lora/train` | Train character LoRA | Service Token | **Critical for character lock** |
| `GET /lora/train/{id}/status` | Training progress | Service Token | Poll or webhook |
| `POST /generation/create` | Submit generation job | Service Token | Include `reservation_id` |
| `GET /generation/{id}/status` | Check job status | Service Token | Poll-based |
| `WS /generation/subscribe` | Real-time gen updates | Access Token | **Preferred over polling** |
| `POST /generation/batch` | Multiple panels at once | Service Token | Efficiency for page generation |

#### Content & Storage APIs

| Civitai API | Comics Usage | Auth | Notes |
|-------------|--------------|------|-------|
| `POST /images/upload` | Upload reference images | Access Token | Returns image_id |
| `GET /images/{id}` | Retrieve uploaded images | Access Token | Signed URL |
| `POST /moderation/submit` | Submit for content review | Service Token | Returns moderation_id |
| `GET /moderation/{id}/status` | Check moderation result | Service Token | Or webhook callback |

#### Webhook Events (Civitai → Comics)

| Event | Payload | Comics Action |
|-------|---------|---------------|
| `user.deleted` | `{user_id}` | Soft-delete all user projects, schedule cleanup |
| `user.permissions_changed` | `{user_id, permissions}` | Update local permission cache |
| `lora.deleted` | `{lora_id}` | Mark characters using this LoRA as "orphaned" |
| `generation.completed` | `{job_id, result}` | Update panel, release Buzz reservation |
| `generation.failed` | `{job_id, error}` | Show error, release Buzz reservation |
| `moderation.completed` | `{moderation_id, result}` | Update content visibility |

#### Error Contract

All APIs return errors in consistent format:
```json
{
  "error": {
    "code": "INSUFFICIENT_BUZZ",
    "message": "User has 15 Buzz, operation requires 25",
    "details": { "balance": 15, "required": 25 }
  }
}
```

| HTTP Status | Meaning | Comics Action |
|-------------|---------|---------------|
| 400 | Bad request | Show validation error |
| 401 | Token invalid/expired | Trigger token refresh, retry |
| 403 | Permission denied | Show upgrade prompt |
| 404 | Resource not found | Handle gracefully |
| 429 | Rate limited | Exponential backoff, show "please wait" |
| 500+ | Server error | Circuit breaker, retry with backoff |

### Deployment Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        INFRASTRUCTURE                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  DNS                                                             │
│  ├─ civitai.com         → Main Civitai (existing)               │
│  ├─ comics.civitai.com  → Comics App (new)                      │
│  └─ api.civitai.com     → Shared API Gateway                    │
│                                                                  │
│  Comics App Stack                                                │
│  ├─ Frontend: Next.js 14 (Vercel or similar)                    │
│  ├─ API: tRPC routes (same patterns as main Civitai)            │
│  ├─ Database: PostgreSQL (separate instance)                    │
│  ├─ Storage: S3 bucket for panels/exports                       │
│  └─ Cache: Redis for session/generation status                  │
│                                                                  │
│  Shared Infrastructure (Civitai)                                 │
│  ├─ Auth: Civitai OAuth2/SSO                                    │
│  ├─ Generation: NanoBanana GPU cluster                          │
│  ├─ Models: Existing model storage                              │
│  └─ CDN: Shared for generated images                            │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Tech Stack (Comics App)

| Layer | Technology | Notes |
|-------|------------|-------|
| **Frontend** | Next.js 14, React, TypeScript | Same as main Civitai |
| **UI Components** | Mantine v7, Tailwind | Same as main Civitai |
| **State** | Zustand, React Query | Same patterns |
| **API** | tRPC | Same patterns |
| **Database** | PostgreSQL + Prisma | Separate instance |
| **Storage** | S3-compatible | Separate bucket |
| **Auth** | NextAuth (SSO mode) | Civitai as provider |
| **Canvas/Editor** | Fabric.js or Konva | For panel manipulation |

### Cross-Platform Features

**From Civitai → Comics:**
- "Use in Comics" button on model/LoRA pages
- "Create Comic" CTA on image posts
- Link user's Civitai creations to import as character refs

**From Comics → Civitai:**
- "Browse More Styles" links to Civitai model browser
- "Train Custom LoRA" redirects to Civitai training
- Published comics can display on Civitai profile
- Creator earnings appear in Civitai dashboard

---

## Technical Approach (Revised)

### Character Consistency System - Hybrid Architecture

**Key Insight from Reviews**: No single approach works. Need multi-model hybrid.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    CHARACTER LOCK PIPELINE (HYBRID)                      │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  SETUP PHASE (One-time per character)                                   │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐              │
│  │  10-15 Ref   │───▶│   Extract    │───▶│   Create     │              │
│  │   Images     │    │  Face +      │    │  Lightweight │              │
│  │  (various    │    │  Body +      │    │  Character   │              │
│  │   angles)    │    │  Outfit      │    │  LoRA        │              │
│  └──────────────┘    │  Embeddings  │    │  (5-10 min)  │              │
│                      └──────────────┘    └──────────────┘              │
│                                                   │                     │
│  ┌──────────────────────────────────────────────┘                      │
│  │                                                                      │
│  │  PRE-GENERATE ANCHOR LIBRARY                                        │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐       │
│  │  │ Front   │ │ 3/4     │ │ Side    │ │ Back    │ │ Action  │       │
│  │  │ View    │ │ View    │ │ Profile │ │ View    │ │ Poses   │       │
│  │  └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘       │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐       │
│  │  │ Happy   │ │ Sad     │ │ Angry   │ │ Surprise│ │ Neutral │       │
│  │  └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘       │
│  │                                                                      │
├──┴──────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  GENERATION PHASE (Per panel)                                           │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐              │
│  │  Panel       │───▶│  Select Best │───▶│  Apply       │              │
│  │  Description │    │  Anchor +    │    │  Style LoRA  │              │
│  │  + Pose      │    │  ControlNet  │    │  + Char LoRA │              │
│  └──────────────┘    │  Pose Guide  │    │  (weighted)  │              │
│                      └──────────────┘    └──────────────┘              │
│                                                   │                     │
│                                                   ▼                     │
│                      ┌──────────────┐    ┌──────────────┐              │
│                      │  Quality     │───▶│  Output 4    │              │
│                      │  Scoring     │    │  Variations  │              │
│                      │  (auto)      │    │  + Scores    │              │
│                      └──────────────┘    └──────────────┘              │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Technical Approach Details

| Component | Technology | Purpose | Phase |
|-----------|------------|---------|-------|
| **Face Consistency** | InstantID / PhotoMaker | Preserve facial features | MVP |
| **Body Consistency** | ControlNet + Reference | Maintain proportions | MVP |
| **Clothing Lock** | Outfit-specific embedding | Prevent clothing drift | MVP |
| **Pose Control** | ControlNet Pose | Match requested poses | MVP |
| **Character LoRA** | Lightweight training (10-20 epochs) | Overall consistency boost | MVP |
| **Style Application** | Community LoRAs (weighted blend) | Apply art style | MVP |
| **Quality Scoring** | Face similarity + clothing match | Auto-rate generations | MVP |
| **Inpainting** | Fix consistency errors | Manual correction fallback | MVP |

### Anchor Library System (Critical Feature)

**Problem**: Character consistency degrades with novel poses/expressions.

**Solution**: Pre-generate character in common configurations during setup.

```
On Character Import:
1. User uploads 10-15 reference images
2. System generates 20-30 "anchor" images:
   - 6 angles: front, 3/4 left, 3/4 right, side left, side right, back
   - 5 expressions: neutral, happy, sad, angry, surprised
   - 3 poses: standing, sitting, action
3. User reviews/approves anchors (can regenerate any)
4. Anchors become reference pool for all future generations
5. System selects nearest anchor for each panel request
```

### Quality Control System

| Check | Method | Threshold | Action if Fail |
|-------|--------|-----------|----------------|
| Face match | Embedding similarity | 0.85 | Auto-regenerate |
| Body proportions | Pose estimation | 0.80 | Auto-regenerate |
| Clothing match | CLIP similarity | 0.75 | Flag for user |
| Style consistency | Style embedding | 0.80 | Auto-regenerate |
| Overall score | Weighted average | 0.80 | Show all 4, highlight best |

---

## Environment Creation System (NEW in v3)

### The Problem

Users often have characters they love (from existing art, commissions, or AI generation) but struggle to create environments/backgrounds that:
- Match the character's art style
- Look consistent across multiple panels
- Don't require complex prompt engineering

**Current pain**: User has a beautiful anime character → tries to generate a "city street background" → gets photorealistic or wrong-style result that clashes with character.

### Solution: Style Extraction + Environment Generation

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    ENVIRONMENT SYSTEM PIPELINE                           │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  STYLE EXTRACTION (from user's existing images)                         │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐              │
│  │  User's      │───▶│   Style      │───▶│   Style      │              │
│  │  Character   │    │  Analysis    │    │  Embedding   │              │
│  │  Images      │    │  (CLIP +     │    │  (reusable)  │              │
│  │              │    │   custom)    │    │              │              │
│  └──────────────┘    └──────────────┘    └──────────────┘              │
│         │                                        │                      │
│         │  OR: Import any image you like         │                      │
│         │                                        │                      │
│  ┌──────────────┐                               │                      │
│  │  Reference   │───────────────────────────────┘                      │
│  │  Image       │   "I want this style"                                │
│  │  (any style) │                                                      │
│  └──────────────┘                                                      │
│                                                                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ENVIRONMENT GENERATION                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐              │
│  │  Location    │───▶│  Style       │───▶│  Environment │              │
│  │  Description │    │  Embedding + │    │  Output      │              │
│  │  "cozy cafe" │    │  ControlNet  │    │  (matched)   │              │
│  └──────────────┘    └──────────────┘    └──────────────┘              │
│                             │                                           │
│                             ▼                                           │
│                      ┌──────────────┐                                  │
│                      │  Location    │  Save for reuse                  │
│                      │  Lock        │  across panels                   │
│                      │  (optional)  │                                  │
│                      └──────────────┘                                  │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Style Extraction Approaches

| Method | Input | Output | Quality | Speed |
|--------|-------|--------|---------|-------|
| **CLIP Style Embedding** | Any image | Style vector | Medium | Fast |
| **Custom Style Classifier** | Any image | Style taxonomy tags | Good | Fast |
| **IP-Adapter Style** | Reference image | Style conditioning | Good | Fast |
| **Style LoRA Matching** | Character images | Best-matching community LoRA | Very Good | Fast |
| **Custom Style LoRA** | 10-20 images | Trained style model | Excellent | Slow (5-10 min) |

**Important Note from Review**: CLIP alone is insufficient for fine-grained style discrimination (can't distinguish soft vs hard cel-shading, warm vs cool color palettes). Need custom style classifier trained on art style taxonomy.

**Recommended MVP Approach**: Hybrid with Fallback Chain
```
Style Extraction Pipeline:
1. Run custom style classifier → get style taxonomy (line weight, coloring, shading)
2. Run CLIP style embedding → get general style vector
3. Match to community LoRAs using combined score

Fallback Chain (based on LoRA match confidence):
- Match >0.85 → Use matched LoRA automatically
- Match 0.70-0.85 → Show user top 3 LoRAs, let them pick
- Match <0.70 → Use IP-Adapter style mode + warn user about limitations
- No match → Fall back to curated style selection

4. Store extracted style as PROJECT-LEVEL STYLE LOCK
5. Apply automatically to all future generations in project
```

### Style Preview (Critical - Added from Review)

**Before applying extracted style to project:**
```
Style Preview Flow:
1. User uploads reference images for style import
2. System extracts style (shows progress)
3. System generates 4 sample environments in extracted style:
   - Indoor scene (e.g., bedroom)
   - Outdoor scene (e.g., street)
   - Close-up background
   - Wide establishing shot
4. User reviews: "Does this match what you wanted?"
   - Yes → Save style to project
   - No → Adjust (show sliders for line weight, color warmth, detail level)
   - Try again → Upload different references
```

### Style Import Feature

**Use Case**: User has images they like (from Pinterest, other artists, etc.) and wants that style.

```
User Flow:
1. Upload 1-5 reference images ("I want this style")
2. System extracts style characteristics:
   - Color palette
   - Line weight/quality
   - Shading style (cel-shaded, soft, etc.)
   - Level of detail
   - Artistic movement (anime, manhwa, western, etc.)
3. System either:
   a) Matches to existing community LoRA (fast, free)
   b) Creates style embedding for IP-Adapter (fast, small cost)
   c) Offers to train custom style LoRA (slow, higher cost)
4. Style is saved to project, applied to all future generations
```

### Location Lock System

**Problem**: Same location (e.g., "hero's bedroom") looks completely different each time.

**Solution**: Location anchors (similar to character anchors)

```
Creating a Location Lock:
1. User describes location: "Small Japanese apartment, evening light"
2. System generates location with matched style
3. User approves or regenerates
4. System creates location embedding + depth map
5. Future uses of this location maintain consistency

Location Anchor Library:
┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐
│ Wide    │ │ Medium  │ │ Close   │ │ Detail  │
│ Shot    │ │ Shot    │ │ Shot    │ │ Shot    │
└─────────┘ └─────────┘ └─────────┘ └─────────┘
┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐
│ Day     │ │ Night   │ │ Morning │ │ Dramatic│
│ Light   │ │ Light   │ │ Light   │ │ Light   │
└─────────┘ └─────────┘ └─────────┘ └─────────┘
```

### Technical Components for Environment System

| Component | Technology | Purpose | Phase |
|-----------|------------|---------|-------|
| **Style Extraction** | CLIP + custom classifier | Analyze user's character style | MVP |
| **Style Matching** | Embedding similarity search | Find matching community LoRAs | MVP |
| **IP-Adapter Style** | IP-Adapter (style mode) | Apply style to environments | MVP |
| **Location Depth** | ControlNet Depth | Maintain location structure | MVP |
| **Location Embedding** | Custom storage | Save/recall location state | MVP |
| **Style LoRA Training** | Existing infrastructure | Custom style creation | Phase 2 |
| **Lighting Variants** | ControlNet + prompts | Same location, different lighting | Phase 2 |

### Character-Environment Composition Layer (Critical - Added from Review)

**The Problem Identified in Review**: The plan treated character and environment as independent pipelines that get "composed" at the end. Without proper composition:
- Characters look like "paper dolls pasted on backgrounds"
- No shadows cast by character
- Lighting on character doesn't match scene
- Character may float or clip through environment

**Composition Pipeline:**
```
┌─────────────────────────────────────────────────────────────────────────┐
│                    CHARACTER-ENVIRONMENT COMPOSITION                     │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  1. GENERATE LAYERS SEPARATELY                                          │
│  ┌──────────────┐         ┌──────────────┐                             │
│  │  Environment │         │  Character   │                             │
│  │  (background │         │  (with alpha │                             │
│  │   + depth)   │         │   channel)   │                             │
│  └──────────────┘         └──────────────┘                             │
│         │                        │                                      │
│         ▼                        ▼                                      │
│  2. LIGHTING HARMONIZATION                                              │
│  ┌─────────────────────────────────────────────────────────┐           │
│  │  Analyze environment lighting (direction, color, intensity)         │
│  │  Adjust character lighting to match scene                           │
│  │  - Color temperature alignment                                       │
│  │  - Shadow direction matching                                         │
│  │  - Ambient light matching                                            │
│  └─────────────────────────────────────────────────────────┘           │
│                          │                                              │
│                          ▼                                              │
│  3. DEPTH-AWARE COMPOSITING                                             │
│  ┌─────────────────────────────────────────────────────────┐           │
│  │  Use environment depth map to:                                       │
│  │  - Place character at correct depth                                  │
│  │  - Handle occlusion (character behind furniture, etc.)               │
│  │  - Scale character to match perspective                              │
│  └─────────────────────────────────────────────────────────┘           │
│                          │                                              │
│                          ▼                                              │
│  4. SHADOW GENERATION                                                   │
│  ┌─────────────────────────────────────────────────────────┐           │
│  │  Generate character shadow based on:                                 │
│  │  - Environment light source direction                                │
│  │  - Character pose and position                                       │
│  │  - Ground plane estimation                                           │
│  └─────────────────────────────────────────────────────────┘           │
│                          │                                              │
│                          ▼                                              │
│  5. FINAL COMPOSITE                                                     │
│  ┌──────────────┐                                                      │
│  │  Panel Output │                                                      │
│  │  (seamless    │                                                      │
│  │   integration)│                                                      │
│  └──────────────┘                                                      │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

**Technical Components for Composition:**

| Component | Technology | Purpose | Phase |
|-----------|------------|---------|-------|
| **Depth Estimation** | Depth Anything / MiDaS | Get environment depth map | MVP |
| **Lighting Analysis** | Custom CNN | Detect light direction/color | MVP |
| **Lighting Transfer** | IC-Light / Relighting models | Match char lighting to scene | MVP |
| **Shadow Generation** | ControlNet + depth | Cast realistic shadows | MVP |
| **Alpha Compositing** | Standard blend modes | Layer combination | MVP |
| **Occlusion Handling** | Depth-based masking | Behind/in-front sorting | MVP |

### Camera/Perspective System (Added from Review)

**Problem**: "Medium shot of cafe" looks different every time because camera parameters aren't locked.

**Solution**: Camera presets per location

```
Location Lock now includes:
┌─────────────────────────────────────────────────────────────┐
│  LOCATION: "Hero's Apartment"                               │
├─────────────────────────────────────────────────────────────┤
│  Camera Presets (MVP - 3 per location):                     │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐                       │
│  │Standard │ │Dramatic │ │ Overhead│                       │
│  │Eye-level│ │Low angle│ │Bird's eye│                       │
│  └─────────┘ └─────────┘ └─────────┘                       │
│                                                             │
│  Shot Types (MVP - 2 per camera):                          │
│  ┌─────────┐ ┌─────────┐                                   │
│  │  Wide   │ │ Medium  │  (Close-up = Phase 2)             │
│  └─────────┘ └─────────┘                                   │
│                                                             │
│  Lighting Variants (MVP - 2):                              │
│  ┌─────────┐ ┌─────────┐                                   │
│  │   Day   │ │  Night  │  (Morning/dramatic = Phase 2)     │
│  └─────────┘ └─────────┘                                   │
│                                                             │
│  Total MVP variants: 3 cameras × 2 shots × 2 lights = 12   │
│  (Reduced from 16 based on review feedback)                │
└─────────────────────────────────────────────────────────────┘
```

### Environment Generation Quality Checks (Thresholds Raised per Review)

| Check | Method | Threshold | Action |
|-------|--------|-----------|--------|
| Style match to character | CLIP + custom classifier | **0.82** | Auto-regenerate |
| Location consistency | Depth map + structure | **0.80** | Flag for user |
| Lighting consistency | Color histogram | **0.78** | Offer variants |
| Composition quality | Lighting harmony score | **0.80** | Re-composite |

### User Experience: Environment Creation

```
Creating Environment for Panel:

Option A: Quick (Matched Style)
1. User types: "rainy city street at night"
2. System auto-applies character's extracted style
3. Generates 4 variations
4. User picks best

Option B: Import Style
1. User clicks "Import Style"
2. Uploads reference image(s)
3. System shows style analysis: "Detected: Soft anime, warm colors, detailed backgrounds"
4. User confirms or adjusts
5. Style saved for project

Option C: Location Lock
1. User creates environment as above
2. Clicks "Save as Location"
3. Names it: "Main Street"
4. Future panels: Select "Main Street" from location library
5. Optionally adjust: time of day, weather, camera angle
```

### Pricing for Environment Features (Revised per Review)

| Action | Buzz Cost | Notes |
|--------|-----------|-------|
| Style extraction (from character) | Free | Included with character setup |
| Style preview (4 sample environments) | Free | Shows extracted style before committing |
| Style import (from reference) | 20 Buzz | One-time per style |
| Environment generation (4 variations) | 20 Buzz | Per generation |
| Location lock creation | 30 Buzz | Includes 12 variants (reduced scope) |
| Use saved location | **Free** | Encourage reuse (review feedback) |
| Location pack (5 locations) | 120 Buzz | 20% discount vs individual |
| Custom style LoRA training | 300 Buzz | Phase 2 premium feature |

**Pricing Philosophy Change (from Review)**: Location reuse is now FREE after creation. We want users to reuse locations consistently, not avoid the feature due to cost.

---

## Feature Specification (Revised MVP)

### MVP Scope (Revised for Character + Environment)

**MVP Goal**: Prove character consistency AND style-matched environments work together.

#### Core Features (MVP)

| Feature | Description | Priority |
|---------|-------------|----------|
| **Character Import** | Upload 10-15 images, create character lock | CRITICAL |
| **Character Anchor Generation** | Pre-generate poses/expressions library | CRITICAL |
| **Style Extraction** | Auto-extract style from character images | CRITICAL |
| **Environment Generation** | Generate backgrounds matching character style | CRITICAL |
| **Style Import** | Upload reference images to define style | HIGH |
| **Location Lock** | Save and reuse consistent locations | HIGH |
| **Single Panel Generation** | Describe scene, get 4 variations with scores | CRITICAL |
| **Inpainting/Fixing** | Fix consistency errors manually | CRITICAL |
| **Style Selection** | 50 curated comic styles (fallback option) | MEDIUM |
| **Basic Layout** | 4-6 panel templates, drag-drop | HIGH |
| **Export** | PNG export only | MEDIUM |

#### Cut from MVP (Move to Phase 2+)

| Feature | Original Phase | Reason for Cut |
|---------|----------------|----------------|
| Script parsing (AI) | MVP | Too complex, add later |
| Multi-character interaction | MVP | Very hard, de-risk first |
| PDF/Webtoon export | MVP | PNG sufficient for validation |
| Speech bubbles editor | MVP | Can use external tools |
| Publishing integrations | Phase 3 | Validate product first |
| Animation/Motion | Phase 2 | Gimmick, not core |
| AI Script Assistant | Phase 2 | Nice-to-have |
| Custom Style LoRA Training | Phase 2 | Style extraction/matching sufficient for MVP |

### Phase 2 Features (Post-MVP Validation)

| Feature | Description | Trigger |
|---------|-------------|---------|
| Multi-character (2 chars) | Two locked characters in same panel | MVP hits 85% consistency |
| Full script parsing | Screenplay → panels automatically | User demand validated |
| Speech bubble editor | Built-in text/bubble tools | User feedback |
| Webtoon export format | Vertical scroll optimization | Publishing partnership |
| Custom Style LoRA Training | Train style from user's images | Users want more control |
| Lighting Variants | Same location, different times of day | User demand |
| Weather Effects | Add rain, snow, fog to locations | Creative expansion |

### Phase 3 Features (Scale)

| Feature | Description | Trigger |
|---------|-------------|---------|
| Publishing integration | Direct to Webtoon/Tapas | 10K+ active creators |
| Collaboration | Multi-user projects | Studio customer demand |
| Reader platform | Host on Civitai | Community demand |
| Translation AI | Auto-translate comics | International growth |

---

## User Experience

### Character Setup Flow (Revised)

```
1. Welcome → "Let's create your character"
2. Upload References → 10-15 images, varied angles/expressions
   - Guide: "Include front view, side view, different expressions"
   - Validation: Check image quality, variety
3. Processing → "Training your character (5-10 minutes)"
   - Show progress, what's happening
4. Anchor Review → Show 20-30 pre-generated angles/expressions
   - User can regenerate any they don't like
   - This IS the character consistency validation
5. Style Selection → Browse 50 curated styles, preview on character
6. First Panel → Guided creation
7. Quality Check → User rates consistency, we learn
```

### Panel Generation Flow

```
1. Describe panel: "Character looks worried, rainy city street"
2. Select pose hint (optional): Choose from anchor library
3. Generate → Show 4 variations with consistency scores
4. User picks best OR requests more variations
5. If issues → Inpainting tool to fix specific areas
6. Add to layout
```

---

## Business Model (Revised)

### Pricing Strategy (Simplified)

**Recommendation**: Pure consumption (Buzz) aligned with Civitai ecosystem.

#### Buzz-Based Pricing

| Action | Buzz Cost | Notes |
|--------|-----------|-------|
| Character setup (training + anchors) | 100 Buzz | One-time per character |
| Style extraction (from character) | Free | Included with character setup |
| Style import (from reference images) | 20 Buzz | One-time per imported style |
| Environment generation (4 variations) | 20 Buzz | Style-matched backgrounds |
| Location lock creation | 30 Buzz | Includes lighting variants |
| Use saved location | 15 Buzz | Discounted reuse |
| Generate panel (4 variations) | 25 Buzz | Character + environment composite |
| Regenerate anchor | 10 Buzz | Fix setup issues |
| Inpainting edit | 15 Buzz | Fix consistency (char or env) |
| Use premium community style | +5-15 Buzz/panel | Creator earnings |
| High-res export | 10 Buzz/panel | Optional upgrade |
| Custom style LoRA training | 300 Buzz | Phase 2 premium feature |

#### Optional Subscription (Power Users)

| Tier | Price | Included Buzz | Savings | Target |
|------|-------|---------------|---------|--------|
| Free | $0 | 500 Buzz/month (~20 panels) | - | Trial |
| Creator | $19/mo | 2500 Buzz/month (~100 panels) | 30% | Regular creators |
| Pro | $49/mo | 7500 Buzz/month (~300 panels) | 40% | Power users |

### Revenue Projections (Revised - Realistic)

| Scenario | Y1 Users | Paid % | Avg Revenue | Annual Revenue |
|----------|----------|--------|-------------|----------------|
| **Conservative** | 15,000 | 5% | $100 | **$75K** |
| **Moderate** | 30,000 | 8% | $150 | **$360K** |
| **Success** | 60,000 | 12% | $180 | **$1.3M** |

**Assumptions:**
- 1-2% of Civitai's 10M users interested in comics
- High churn if consistency isn't excellent
- 6-month ramp to word-of-mouth growth
- Conservative free→paid conversion (5-12%)

### Creator Economy

| Revenue Stream | Creator Share | Platform Share |
|----------------|---------------|----------------|
| Premium comic style usage | 60% | 40% |
| Character template sales | 70% | 30% |
| Background pack sales | 70% | 30% |

**Creator GMV Potential:**
- 500 active style creators × $300 avg earnings = $150K GMV
- Platform 35% = ~$50K additional revenue
- Could scale significantly with success

---

## Implementation Plan (Revised)

### Pre-Development: Validation Sprint (Weeks 1-6)

**Goal**: Validate technical approach + market demand before full commitment.

| Week | Focus | Deliverables | Go/No-Go Criteria |
|------|-------|--------------|-------------------|
| 1-2 | Technical spike: Character consistency | Test IP-Adapter, InstantID, Flux Redux, lightweight LoRA | Identify best approach |
| 3-4 | Technical spike: Style extraction + matching | Test CLIP style, IP-Adapter style mode, LoRA matching | Style matching works |
| 5 | Build prototype: 10 characters, 20 environments, 50 panels | Working demo with character + environment | 75%+ consistency on both |
| 6 | User research + Go/No-Go | 20 creator interviews, validation report | Proceed or pivot |

**Exit Criteria for Full Development:**
- Character consistency ≥80% on test set
- Environment style matching ≥75% user approval
- 15+ of 20 interviewed creators say "I would pay for this"
- Technical approach defined with confidence
- No blocking legal/content moderation issues identified

### Phase 1: MVP Development (Weeks 7-41)

| Week | Focus | Deliverables |
|------|-------|--------------|
| 7-9 | **SSO Integration** | OAuth2 flow, token refresh, cross-domain cookies, logout sync |
| 10-11 | **Buzz Integration** | Reservation pattern, commit/release flows, balance checking |
| 12 | **Integration Testing** | Cross-service tests, browser matrix, error handling |
| 13-16 | Character Lock System | Import flow, embedding extraction, lightweight LoRA training |
| 17-20 | Character Anchor Generation | Pre-generation pipeline, anchor review UI |
| 21-24 | Style Extraction System | Custom style classifier, CLIP embedding, LoRA matching, style preview |
| 25-27 | Environment Generation | Style-matched backgrounds, camera presets |
| 28-30 | Location Lock System | Location anchors, 12 variants per location, camera presets |
| 31-35 | Composition Layer | Lighting harmonization, depth compositing, shadow generation |
| 36-37 | Inpainting + Fixes | Manual correction tools for character, environment, and composition |
| 38-41 | Polish + Beta | Bug fixes, onboarding, soft launch, stabilization |

**Note**: Timeline is 36-41 weeks total (6 weeks validation + 35 weeks development). Extended from v4 estimates based on review feedback:
- SSO integration underestimated: 2 weeks → 5 weeks (OAuth complexity, cross-domain cookies, browser testing)
- Buzz integration needs atomic reservation pattern (not just simple charge)
- Composition layer underestimated: 3 weeks → 5 weeks
- Location lock needs more time: 2 weeks → 3 weeks
- Polish/stabilization insufficient: 2 weeks → 4 weeks

### Phase 2: Beta + Iteration (Weeks 42-50)

| Week | Focus |
|------|-------|
| 42-45 | Beta with 500-1000 users, rapid iteration based on feedback |
| 46-47 | Multi-character support (if consistency validated) |
| 48-50 | Script parsing, speech bubbles, custom style LoRA training, expanded camera presets |

### Phase 3: Scale (Weeks 51+)

- Publishing integrations
- Reader platform
- International expansion

### Team Requirements

| Role | Count | Phase | Responsibility |
|------|-------|-------|----------------|
| ML Engineer | 2 | Validation → Scale | Character consistency, style extraction, quality scoring |
| Frontend Engineer | 1 | Validation | Prototype UI |
| Frontend Engineer | +1 | MVP | Full editor UI (Fabric.js/Konva expertise preferred) |
| Backend Engineer | 2 | MVP | **+1 from v4**: Integration (SSO/Buzz) + App development in parallel |
| DevOps/SRE | 0.5 | MVP | Infrastructure, deployment, monitoring, alerting |
| QA Engineer | 0.5 | MVP → Beta | Integration testing across service boundaries |
| Product Manager | 1 | All | Roadmap, user research |
| Designer | 0.5 | MVP | UI/UX |
| Technical Writer | 0.25 | Beta | API docs, user guides |

**Why 2 Backend Engineers:**
The hybrid architecture requires parallel workstreams:
1. **Integration Engineer** (Weeks 7-12): SSO implementation, Buzz reservation system, webhook handlers, Civitai API integration
2. **App Engineer** (Weeks 7+): Comics-specific APIs, database, storage, export system

Trying to do both sequentially adds 4-6 weeks to timeline.

**Required Expertise:**

| Expertise | Who | Why Critical |
|-----------|-----|--------------|
| **Civitai NextAuth config** | 1 Backend | SSO integration requires understanding existing auth |
| **NanoBanana job queue** | 1 Backend | Generation pipeline integration |
| **Buzz transaction model** | 1 Backend | Reservation pattern implementation |
| **Canvas editors** | 1 Frontend | Fabric.js/Konva for panel manipulation |
| **IP-Adapter/ControlNet** | 1 ML | Character consistency pipeline |
| **LoRA training** | 1 ML | Character lock system |

**Critical: Civitai Integration Liaison**

For Weeks 7-12, one of these must be true:
- A comics team member has worked on Civitai backend before
- A Civitai backend engineer is allocated 50% to comics for integration support
- Civitai provides detailed internal API documentation + weekly sync meetings

Without this, the 5-week integration timeline becomes 8-10 weeks.

---

## Risk Assessment (Revised)

### Technical Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Character consistency <80% | MEDIUM | CRITICAL | Multi-approach hybrid, 6-week spike first |
| Style extraction inaccurate | MEDIUM | HIGH | Multiple extraction methods, user override |
| Environment doesn't match char style | MEDIUM | HIGH | Validate in spike, use same style embedding |
| Style + character conflict | HIGH | HIGH | Weighted blending, style-specific tuning |
| Location consistency degrades | MEDIUM | MEDIUM | Depth maps + structural locks |
| Generation speed too slow | MEDIUM | MEDIUM | Optimize pipeline, async generation |
| Multi-character fails | HIGH | MEDIUM | Phase 2 feature, more R&D |
| Anchor library insufficient | MEDIUM | MEDIUM | Allow custom anchors, regeneration |
| Style import IP concerns | MEDIUM | MEDIUM | Clear ToS, style != copyright |

### Market Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Competitor solves consistency first | MEDIUM | HIGH | Move fast, leverage community |
| Platform policies ban AI content | LOW | HIGH | Focus on quality, offer disclosure tools |
| Lower demand than expected | MEDIUM | MEDIUM | 6-week validation first |
| Pricing too high vs competitors | MEDIUM | MEDIUM | Buzz model allows flexibility |

### Operational Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Artist community backlash | HIGH | MEDIUM | Position as tool, creator earnings |
| Content moderation overwhelm | MEDIUM | HIGH | Automated detection, clear ToS, dedicated resources |
| Copyright/fan character issues | HIGH | MEDIUM | Clear guidelines, DMCA process |

### Hybrid Architecture Risks (NEW in v4.1)

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| **Civitai API versioning breaks comics** | HIGH | CRITICAL | Version-pin APIs, integration tests in CI, maintain compatibility layer |
| **Shared service outage cascades** | MEDIUM | HIGH | Circuit breakers, graceful degradation (read-only mode when Civitai down) |
| **Data consistency drift** | HIGH | MEDIUM | Reconciliation jobs daily, event sourcing for critical data, webhook handlers |
| **Cross-team coordination overhead** | HIGH | MEDIUM | Dedicated liaison role, shared Slack channel, weekly sync meetings |
| **Different deployment cadences** | HIGH | LOW | Feature flags, backward-compatible APIs, staged rollouts |
| **Auth token compromise** | MEDIUM | CRITICAL | Short token lifetimes (15 min), separate service-to-service auth from user auth |
| **Buzz economy manipulation** | MEDIUM | HIGH | Transaction logging, anomaly detection, per-user rate limiting |
| **User data residency** | MEDIUM | HIGH | Ensure comics DB in same region/compliance scope as Civitai |
| **CORS misconfiguration** | MEDIUM | MEDIUM | Explicit allow-list, browser test matrix, security review |
| **Webhook delivery failures** | HIGH | MEDIUM | Retry with exponential backoff, dead letter queue, manual reconciliation UI |

### Operational Risks (Hybrid-Specific)

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| **No shared incident response** | HIGH | HIGH | Define runbook: who to page for auth issues vs. comics issues |
| **Log aggregation across systems** | MEDIUM | MEDIUM | Shared logging infrastructure (DataDog/etc), correlation IDs in all requests |
| **Monitoring blind spots** | MEDIUM | HIGH | End-to-end synthetic tests across service boundaries |
| **SSO session desync** | MEDIUM | MEDIUM | Session validation on sensitive operations, clear error messaging |

### Content Moderation Plan (Added)

| Content Type | Detection | Action |
|--------------|-----------|--------|
| NSFW | Automated classifier | Age-gate, separate section |
| Copyrighted characters | CLIP similarity to known IPs | Warning, require original |
| Real people | Face recognition | Block without consent proof |
| Hate content | Keyword + image classifier | Remove, ban repeat offenders |

**Resources**: 1 part-time moderator at launch, scale with usage.

---

## Success Metrics (Revised)

### KPIs

| Metric | Month 1 | Month 3 | Month 6 | Month 12 |
|--------|---------|---------|---------|----------|
| Registered users | 3K | 15K | 40K | 80K |
| Monthly active users | 1K | 6K | 20K | 40K |
| Characters created | 500 | 4K | 15K | 40K |
| Locations created | 200 | 2K | 8K | 25K |
| Styles imported | 300 | 3K | 12K | 35K |
| Panels generated | 10K | 100K | 500K | 2M |
| Paid users | 50 | 400 | 2K | 6K |
| Avg character consistency (user-rated) | 7.5/10 | 8/10 | 8.5/10 | 8.5/10 |
| Avg style match satisfaction | 7/10 | 7.5/10 | 8/10 | 8/10 |
| Creator earnings (total/month) | $1K | $10K | $40K | $100K |

### Validation Checkpoints

| Checkpoint | Criteria | Decision |
|------------|----------|----------|
| **Week 4** (Style Spike) | Style extraction matches user intent 75%+ | Continue or revise approach |
| **Week 6** (End of Validation) | 80%+ char consistency, 75%+ style match, 15+ positive interviews | Proceed to MVP or pivot |
| **Week 9** (SSO Complete) | Auth flow working across browsers, token refresh functional | Continue or escalate |
| **Week 12** (Integration Complete) | Buzz reservation working, webhooks receiving, all Civitai APIs tested | Continue or add 2 weeks |
| **Week 35** (Composition Check) | Character + environment integration looks professional, not "pasted on" | Continue or add 2 weeks |
| **Week 41** (End of MVP) | 500+ beta users, 8/10 char consistency, 7.5/10 style satisfaction | Launch or extend beta |
| **Month 6** (post-launch) | 5K+ MAU, <30% monthly churn | Scale marketing or iterate |
| **Month 9** | 2K+ paid users, positive unit economics | Expand features or focus |

---

## Open Questions (To Resolve in Validation)

### Character System
1. **Optimal reference image count**: Is 10-15 images right, or do we need more/less?
2. **Anchor library size**: 20-30 anchors sufficient, or need more coverage?
3. **Training time tolerance**: Will users wait 5-10 minutes for character setup?

### Environment/Style System
4. **Style extraction accuracy**: How well can we extract style from character images alone?
5. **Style import requirements**: How many reference images needed for reliable style import?
6. **Location anchor coverage**: How many angles/lighting variants per location?
7. **Style + character interaction**: Can we maintain both style AND character consistency simultaneously?

### Business
8. **Style compatibility**: Which community LoRAs work best with character lock?
9. **Pricing sensitivity**: Buzz vs subscription preference among target users?
10. **Content moderation scope**: How much NSFW to allow?
11. **Style IP concerns**: What if users import copyrighted art styles?

---

## Appendix

### Competitor Feature Matrix (Updated)

| Feature | Anifusion | Dashtoon | KomikoAI | **Civitai Comics** |
|---------|-----------|----------|----------|-------------------|
| Character consistency | Partial | Yes | No | **Target: Best (85%+)** |
| Style extraction | No | No | No | **Yes (unique)** |
| Style import from reference | No | No | No | **Yes (unique)** |
| Environment style matching | No | No | No | **Yes (unique)** |
| Location lock/consistency | No | Partial | No | **Yes** |
| Style variety | Limited | Limited | Limited | **50 curated + import** |
| Community styles | No | No | No | **Yes (Phase 2)** |
| Inpainting/fixing | No | Limited | No | **Yes** |
| Creator earnings | No | No | No | **Yes** |
| Anchor library (char + loc) | No | No | No | **Yes (unique)** |

**Key Differentiator**: No competitor offers style extraction from user's existing images or automatic style matching for environments.

### Technical Research References

Papers to review during validation sprint:

**Character Consistency:**
- "Story Diffusion: Consistent Self-Attention for Long-Range Image and Video Generation"
- "IP-Adapter: Text Compatible Image Prompt Adapter for Text-to-Image Diffusion Models"
- "InstantID: Zero-shot Identity-Preserving Generation in Seconds"
- "PhotoMaker: Customizing Realistic Human Photos via Stacked ID Embedding"
- "ControlNet: Adding Conditional Control to Text-to-Image Diffusion Models"

**Style Extraction & Transfer:**
- "StyleDrop: Text-to-Image Generation in Any Style"
- "Visual Style Prompting with Swapping Self-Attention"
- "Style Aligned Image Generation via Shared Attention"
- "DreamBooth: Fine Tuning Text-to-Image Diffusion Models for Subject-Driven Generation"
- IP-Adapter documentation on style transfer mode

**Environment/Background Consistency:**
- "Depth Anything: Unleashing the Power of Large-Scale Unlabeled Data"
- "ControlNet Depth/Canny for structural consistency"
- "Segment Anything Model (SAM)" for background/foreground separation

---

## Document History

| Version | Date | Changes |
|---------|------|---------|
| 0.1 | Jan 2026 | Initial draft |
| 0.2 | Jan 2026 | Post-review revision: realistic timeline, reduced scope, validation sprint |
| 0.3 | Jan 2026 | Added Environment System: style extraction, style import, location lock |
| 0.3.1 | Jan 2026 | Post-review revision of environment system: added composition layer, camera presets, style preview |
| 0.4 | Jan 2026 | Added Hybrid Architecture: separate app at comics.civitai.com, shared Civitai services |
| 0.4.1 | Jan 2026 | Post-review revision: hardened hybrid architecture, complete API contracts, Buzz reservation pattern, expanded schema, +8 weeks timeline |

---

## Summary of Changes

### v4.1 Changes: Hybrid Architecture Hardening (Post-Review)

Based on external agent review, critical improvements to the hybrid architecture:

**Timeline Extension (+8 weeks):**
- Total MVP: 36-41 weeks (was 28-32)
- SSO integration: 5 weeks (was 2) - OAuth complexity, cross-domain cookies, browser testing
- Buzz integration: explicit reservation pattern for atomic transactions
- Composition layer: 5 weeks (was 3)
- Polish/stabilization: 4 weeks (was 2)

**Team Expansion:**
- Backend Engineers: 2 (was 1) - integration + app development in parallel
- Added: DevOps/SRE (0.5), QA Engineer (0.5), Technical Writer (0.25)
- Critical: Civitai integration liaison required for Weeks 7-12

**API Contracts (Complete):**
- Full SSO flow: authorize, token, refresh, validate, revoke endpoints
- Buzz reservation pattern: reserve → commit/release (not just charge)
- Webhook events: user.deleted, lora.deleted, generation.completed, etc.
- Error contract: consistent format with HTTP status codes

**Database Schema (Complete):**
- Added missing tables: generations, buzz_transactions, export_jobs, user_preferences, style_analysis_cache, panel_versions
- Fixed panel_characters junction table (was UUID array)
- Added soft delete, status fields, indexes
- Added civitai_resource_refs for orphan detection

**Hybrid-Specific Risks (10+ new):**
- API versioning breaks comics
- Service outage cascades
- Data consistency drift
- Auth token compromise
- Buzz economy manipulation
- Cross-team coordination overhead

### v4 Changes: Hybrid Architecture

The plan has been updated to use a **hybrid architecture** approach:

1. **Separate Frontend Application**: Comics tool lives at `comics.civitai.com` as its own Next.js app
2. **Shared Backend Services**: Uses Civitai's existing SSO, Buzz economy, NanoBanana generation, and model database
3. **Dedicated Database**: Comics-specific data (projects, characters, locations, panels) in separate PostgreSQL
4. **Cross-Platform Features**: "Use in Comics" buttons on Civitai, "Browse Styles" links from Comics
5. **Timeline Extended**: 28-32 weeks total (added 2 weeks for SSO/Buzz integration)
6. **Team Requirements Updated**: Need engineer familiar with Civitai backend for integration work
7. **API Integration Points**: Documented all shared service APIs (auth, buzz, generation, moderation)
8. **Deployment Architecture**: Defined infrastructure separation and DNS routing

**Why Hybrid?**
- Dedicated UI without bloating main Civitai codebase
- Risk isolation (comics failures don't affect main platform)
- Single user account via SSO
- Access to entire Civitai ecosystem (models, Buzz, community)

### v3.1 Changes: Environment System Review

Based on external agent review, these critical additions were made:

1. **Added Composition Layer**: Character-environment integration with lighting harmonization, depth compositing, shadow generation
2. **Added Style Preview**: Users see 4 sample environments before committing to extracted style
3. **Added Camera Presets**: 3 camera angles per location (standard, dramatic, overhead)
4. **Reduced Location Scope**: 12 variants per location (was 16) for MVP
5. **Free Location Reuse**: Using saved locations is now free to encourage consistency
6. **Extended Timeline**: 26-30 weeks (was 22-26) - composition layer was underestimated
7. **Raised Quality Thresholds**: Environment thresholds raised to match character quality
8. **Style Fallback Chain**: Explicit handling when LoRA matching fails

### v3 Changes: Environment System

1. **Added style extraction**: Auto-extract style from user's character images
2. **Added style import**: Let users upload reference images to define style
3. **Added environment generation**: Style-matched backgrounds
4. **Added location lock**: Consistent reusable locations
5. **Timeline adjusted**: 22-26 weeks (was 20-24) to include environment work
6. **New unique differentiator**: No competitor offers style extraction + matching

### v2 Changes: Post-Review

1. **Timeline was 2x too short**: 10-12 weeks → 20-24 weeks realistic
2. **Revenue projections were 5-10x too high**: $3M-$48M → $75K-$1.3M realistic
3. **Character consistency is THE technical challenge**: Needs hybrid multi-model approach
4. **Missing critical features**: Inpainting, anchor library, quality scoring
5. **Need validation before commitment**: 6-week spike to de-risk
6. **Scope too broad**: Cut script parsing, multi-character from MVP
7. **Free tier too restrictive**: 10 → 50 panels to demonstrate value
8. **Missing competitors**: Dashtoon, ComicsMaker.AI in the space

### What Stays the Same

1. **Core value prop**: Character consistency is the primary differentiator
2. **Market opportunity**: Real and large ($9-11B → $48-97B)
3. **Civitai advantages**: LoRA infrastructure, community, existing users
4. **Creator economy**: Style monetization is valuable
5. **Target positioning**: Prosumer creators, not "everyone"

---

**Next Steps:**

**Validation Sprint (Weeks 1-6):**
1. Secure resources for 6-week validation sprint
2. Assign ML engineers to technical spike (character + style extraction)
3. Schedule 20 creator interviews (include questions about environment/style pain)
4. Define go/no-go criteria with stakeholders (include style matching metrics)
5. Begin competitor deep-dive (hands-on testing)
6. Test CLIP style extraction on sample character images
7. Evaluate IP-Adapter style mode for environment generation

**Hybrid Architecture Prep (Before Week 7):**
8. **Staffing:**
   - Identify/hire 2nd backend engineer for integration work
   - Allocate Civitai backend engineer (50%) as integration liaison for Weeks 7-12
   - Identify DevOps/SRE resource (0.5 FTE)
9. **Infrastructure:**
   - Set up comics.civitai.com subdomain and SSL
   - Provision separate PostgreSQL instance
   - Set up S3 bucket for comics assets
   - Configure logging/monitoring (shared infrastructure)
10. **API Contracts:**
    - Document current Civitai auth system (NextAuth config)
    - Design Buzz reservation API (reserve/commit/release)
    - Design webhook payload formats
    - Identify any Civitai APIs that need to be built/exposed
11. **Cross-Team Coordination:**
    - Establish shared Slack channel
    - Schedule weekly sync meetings (comics + Civitai backend)
    - Define incident response runbook (who to page for what)
    - Agree on API versioning strategy
