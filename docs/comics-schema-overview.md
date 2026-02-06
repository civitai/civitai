# Comics Feature — Schema Overview

## What it is

An AI-powered comic creation tool where users build comics panel-by-panel. Users upload reference images (characters, locations, items), describe scenes in natural language, and the system generates comic panels using our NanoBanana/Gemini image generation pipeline.

## Data Model (8 new tables, 7 new enums)

```
ComicProject
 ├── ComicChapter (ordered)
 │    ├── ComicPanel (ordered, AI-generated)
 │    │    ├── → Image (generated panel image)
 │    │    └── ComicPanelReference ←──┐  (many-to-many)
 │    ├── ComicChapterRead            │
 │    └── Thread (comments)           │
 ├── ComicReference ──────────────────┘
 │    └── ComicReferenceImage → Image (uploaded reference images)
 └── ComicProjectEngagement
```

## Core Tables

| Table | Purpose | Key Fields |
|-------|---------|------------|
| **ComicProject** | Top-level container — one per comic | name, description, coverImage, genre, nsfwLevel, publishedAt |
| **ComicChapter** | Ordered sections within a project | name, position, status (Draft/Published), nsfwLevel |
| **ComicPanel** | Individual comic panel — AI-generated image | prompt, enhancedPrompt (AI-refined), imageId → `Image`, imageUrl, status (Pending→Generating→Ready/Failed), workflowId, buzzCost |
| **ComicReference** | Reusable visual reference — a character, location, or item | name, type (Character/Location/Item), status (Pending→Ready/Failed) |
| **ComicReferenceImage** | Join table: reference ↔ Image | Links references to proper `Image` records (goes through existing moderation/ingestion pipeline) |
| **ComicPanelReference** | Join table: panel ↔ references | Many-to-many — a single panel can use multiple references (e.g. a character + a location + a weapon in one scene) |

## Engagement & Analytics

| Table | Purpose |
|-------|---------|
| **ComicProjectEngagement** | User interactions — Notify/Hide (same pattern as models) |
| **ComicChapterRead** | Read tracking per user per chapter |

## Key Design Decisions

1. **References are reusable** — A reference can be project-specific OR live in a user's personal library (`projectId` is nullable). Deleting a project doesn't delete library references.

2. **Multi-reference generation** — Panels link to references through a many-to-many join table. A scene can combine a character + environment + item. All reference images are sent to the AI together.

3. **All images are proper Image records** — Both generated panel images and uploaded reference images are stored as `Image` records, not JSON blobs. They go through our standard ingestion, moderation, and CDN optimization. Panels link to their generated image via `imageId → Image`; references link to their uploads via the `ComicReferenceImage` join table.

4. **Prompt enhancement** — Users write simple prompts; an LLM refines them for better generation quality. Both original and enhanced prompts are stored.

5. **Generation via orchestrator** — Panels are generated through our existing orchestrator workflow system (same infra as image generation), tracked by `workflowId`.

6. **NSFW rollup** — Panel-level NSFW scores roll up to chapter and project levels automatically.

7. **Comments** — Each chapter can have a comment thread (reuses existing `Thread` system).

## Enums

| Enum | Values |
|------|--------|
| ComicProjectStatus | Active, Deleted |
| ComicChapterStatus | Draft, Published |
| ComicPanelStatus | Pending, Generating, Ready, Failed |
| ComicReferenceStatus | Pending, Ready, Failed |
| ComicReferenceType | Character, Location, Item |
| ComicEngagementType | Notify, Hide |
| ComicGenre | Action, Adventure, Comedy, Drama, Fantasy, Horror, Mystery, Romance, SciFi, SliceOfLife, Thriller, Other |

## Cost Model

- Each panel generation costs **25 Buzz** (deducted via existing Buzz system)
- Reference creation is **free** (just image uploads)

## What hooks into existing systems

- `Image` table (reference images + generated panel images)
- `User` table (ownership)
- `Thread` table (chapter comments)
- Orchestrator (panel generation workflows)
- Image ingestion pipeline (moderation/scanning)
- Buzz accounting (generation costs)
- Notification system (generation complete/failed alerts)
