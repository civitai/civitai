# 3D Models on Civitai — Pilot Summary

**One-liner**: Add a 3D Model content type to Civitai populated by **AI generation** (Meshy via the orchestrator's PolyGen recipe). Hackathon pilot. User uploads deferred — schema is upload-ready for later.

---

## What users get in v1

- **Generate a 3D model** from the generation panel — text-to-3D or image-to-3D (Meshy via PolyGen).
- View the generated model in-browser with rotation/zoom.
- Click **"Post from Generation"** to publish it as a `Model3D` (creates the showcase Post with the generator's thumbnail).
- Browse a dedicated 3D Models feed and per-creator profile tab.
- Download in multiple formats (GLB, FBX, OBJ, USDZ — whatever Meshy outputs) via a dropdown selector.
- Comment, react to the thumbnail, report, tip.
- **Rate + review** with stars and recommendation.
- Community members can post "Makes/Uses" (e.g. "I used this model in my game") with photos linked back to the Model3D.

## What's deliberately out of v1

- **User uploads** — schema supports them (nullable `workflowId`), code path doesn't yet. Phase 3 follow-up once we have a 3D-content moderation plan.
- Slicer integration, marketplace, paid downloads, bulk-import — all follow-ups.
- Versioning — a Model3D is atomic; iteration means a new Model3D.
- Reactions on the Model3D itself — users react to the thumbnail Image, which is already an Image row.

## Routes

| Route | View |
|---|---|
| `/3d-models` | Feed (Meilisearch-backed) |
| `/3d-models/[id]` | Detail: preview, info, files dropdown, generation details, comments, makes/uses |
| `/3d-models/[id]/reviews` | Reviews list + write-review CTA |
| Generation panel | New "3D Model" content type (text-to-3D + image-to-3D tabs) |

## Phasing & effort

| Phase | Scope | Effort |
|---|---|---|
| **1** | Schema + generation panel + save-as-Model3D + detail page + reviews (with image attachments) | **L** |
| **2** | Public feed broadening, profile tab, community "Makes/Uses" Posts | S–M |
| **3** | User uploads (deferred — needs moderation plan) | M–L |

**Feature flags**: `model3d-feed` (browse/comment/review) and `model3d-generator` (create) — both Flipt-managed, mod-only at launch, broadened independently.

**Unblocked** — `@civitai/client@0.2.0-beta.67` (installed) exports `submitWorkflow`, `PolyGenStep`/`PolyGenStepTemplate`, and the Meshy input types. Phase 1 can start in full; integration uses the async workflow pattern (same as Sora/Wan), not the sync template endpoint.

## Content policy (decided)

- **Weapons / firearms**: total ban — orchestrator prompt filter + mod review.
- **POI / real-person likenesses**: standard Civitai POI rules apply to the thumbnail Image + the prompt.
- **NSFW**: gated by orchestrator's `allowMatureContent`; only the thumbnail Image is content-scanned in v1.
- **Copyrighted IP**: report-driven into mod queue via `Model3DReport`.

## Top risks

1. **Meshy cost per generation**: Buzz pricing model needs sign-off from billing.
2. **3D moderation surface**: only the thumbnail is content-scanned. Mature prompts with sanitized thumbnails slip past; `allowMatureContent` is the primary mitigation.
3. **Generation reliability**: Meshy can fail/time-out. UX needs a clear retry path.
4. **Scope creep**: marketplace / user uploads are tempting — explicitly out of v1.

_Storage / egress is intentionally not a top risk in v1 — product direction is to run rampant on storage and revisit if costs spike._

## Strategic value

- **Closes the multimodal loop**: image + video + audio + **3D**, all from one generation panel.
- **No competing AI-native site does end-to-end 3D**: Thingiverse/Printables/MakerWorld are upload-only and not AI-aware. Meshy is generation-only with no community surface.
- **Low ingestion friction**: by skipping uploads in v1 we sidestep the 3D-moderation problem entirely while still validating audience interest.

---

**Full plan**: `docs/3d-models-plan.md`
**Diagrams**: `docs/3d-models-diagram.md`
