# Ecosystem SEO pages — human fact-check list

**Purpose:** the landing pages mix (a) live data pulled from the DB and (b) unique prose that was
AI-authored, grounded in each model's Civitai model card + the orchestrator prompt-enhancement
guide. (b) reads as authoritative but was not written by a human — verify it before we treat it as
fact. This lists what to check and where the known risks are.

Source of truth per field: config is `src/shared/constants/ecosystem-seo.constants.ts`
(the `ECOSYSTEM_SEO` map). Live data is computed in `src/server/services/ecosystem-seo.service.ts`.

## How to review (in-context, per page)

Each config carries an optional **`factCheck`** array — the specific AI-authored claims to verify.
When a **moderator** views a page (`/ecosystems/<slug>`), a floating **"⚠ Fact-check"** panel lists that
ecosystem's flags (field → claim → why), with links that jump to the section. The flags are stripped
from the payload for non-moderators, so end users never see them. **To clear a flag: verify the claim
against a source, fix the copy if needed, then delete that entry from the config's `factCheck` array.**
This doc is the standing methodology; the per-config `factCheck` entries are the live worklist.

---

## Tier 0 — machine-pulled, low fact-check risk (verify *scoping*, not facts)

These come straight from the DB and refresh daily; they can't be "wrong" in the factual sense, but
confirm they're scoped to the right ecosystem (no family bleed) and SFW.

- **Stat counts** — models / generations / LoRAs (hero row). Engine ecosystems fall back to a
  media-created count (ModelMetric has none). Check the numbers look sane per page.
- **Featured model names / types**, **popular LoRAs list**, **download & generation counts** on cards.
- **Example media** — the image/video itself, and its `prompt` + `settings`. Settings are built from
  real image meta; the prompt caption is the real meta prompt (sometimes lightly trimmed — see flags).

## Tier 1 — AI-authored prose, MUST be verified (highest priority)

Per ecosystem, these fields are unique prose generated from the model card + prompt guide:

- **`hero.intro`** — the one-paragraph pitch. Check provider, capability claims, "open/closed".
- **`overview`** (3 paragraphs) — the densest factual surface: architecture, parameter counts,
  text-encoder, native resolution, release lineage, provider. **Verify every number and proper noun.**
- **`comparison.rows`** — ⚠️ **the qualitative ratings ("Excellent", "Very good", "Strong", winner
  highlights) are editorial judgment, NOT sourced metrics.** Verify or soften before treating as fact.
  The factual cells (provider, open/closed, "Available on Civitai") should be correct — spot-check.
- **`faq`** — answers are AI-authored. Check any factual claim (limits, modes, pricing framing).
- **`promptTips`** — grounded in the orchestrator guide where a real one existed (usually reliable);
  where the guide was a generic fallback, these came from the model card + general best practice (flagged).
- **`attribution`** (footer) and **`metaDescription`** (SERP snippet) — check the provider/claim.
- **`hero.badges`** — short claims ("Open weights", "By X"); verify.

## Tier 2 — dates & flags (once added)

- **`releasedAt`** (release date) and any **"new" flag** — human-set; confirm accuracy.

---

## Known per-ecosystem flags (from the authoring pass — resolve these first)

| Ecosystem | Flag to verify |
|-----------|----------------|
| **HappyHorse** | `attribution` says *"attributed to Alibaba"* — corporate parent is **unconfirmed** (guide said "Alibaba, via fal.ai"; Civitai groups it under an "Alibaba – Taotian" family). Confirm the real owner. Also: the model card's *"#1 on the Artificial Analysis Video Arena / Elo 1416"* claim was deliberately **excluded** as unverified — decide if we want it. |
| **Grok Imagine** | The real orchestrator guide (`grok`) is **image-oriented (Aurora model)**; there is no Grok *video* prompt guide, so the video/motion prompt tip is general best practice, not sourced. Page is framed as a video ecosystem but the model does image + video (intentional). |
| **Kling** | `settings` omit fps (null in meta) though the guide states ~30fps. One example (imageId 133284218) reports **8s**, outside the guide's stated 5s/10s modes — it's the real meta value. |
| **Seedance** | Example prompt captions are **condensed** from very long real prompts (Remix still uses the real image meta, so it works — captions are display-only). No official ByteDance/Seedance ToS URL was found; `attribution` kept generic. Comparison ratings are editorial. |
| **Pony / Illustrious / NoobAI** | The orchestrator prompt guide returned a **generic fallback** (no model-specific rules) for these keys, so `promptTips` were grounded in the **model card** + general SDXL/booru practice instead. Verify the tips. |
| **Anima** | Model card vs. prompt guide **conflicted on weight syntax** (card says weights work; guide says they don't). The guide was followed. Confirm which is right. |
| **All numeric overview claims** | Spot-check specifics: HiDream "17B sparse MoE", Z-Image "~6B", SD 1.5 "512-native / 77-token CLIP", Seedance "4–15s, 480p/720p, up to 9 image refs", Grok "~1,000 char prompt", Flux "T5-XXL / 256–512 tokens". |

---

## Open-question answers this addresses

- **OQ1 (fact-check scope):** the fields above (Tier 1) are the AI-authored ones threaded from model
  pages / guides; Tier 0 is live DB data. Start with **comparison ratings** and **overview numbers**.
- These are per-page — worst case is one wrong number on one ecosystem, not a systemic error, because
  each page was grounded from that model's own card.
