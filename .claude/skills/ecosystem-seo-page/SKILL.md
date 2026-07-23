---
name: ecosystem-seo-page
description: Generate a programmatic-SEO "ecosystem hub page" mockup for a Civitai generation ecosystem (Flux, SDXL, Pony, Illustrious, Wan, Qwen, etc.). Produces a self-contained, on-brand HTML landing page that ranks for "<ecosystem> AI", "best <ecosystem> models", "<ecosystem> vs X", "how to run <ecosystem>" and funnels visitors into the generator and membership. Auto-derives what it can from basemodel.constants.ts, asks the dev for the rest, optionally pulls live stats/top-models, then publishes it as an artifact. Use when someone wants an ecosystem landing/SEO page, a hub-page mockup, or to add a page for a new model family.
allowed-tools: Read, Write, Edit, Glob, Grep, AskUserQuestion, Artifact, Skill, Bash
---

# Ecosystem SEO Hub Page

Build one authoritative landing page per generation ecosystem. The strategy is **programmatic SEO**: a single template, populated per-ecosystem with data only Civitai has (models, LoRAs, real generations + prompts, usage metrics), that captures high-intent search ("best Flux models", "Flux vs SDXL", "how to run Wan") and funnels it into the generator and membership.

The visual design is **frozen** in [`template.html`](template.html) — it's Civitai's real dark-first system (card/badge/amber-bolt-CTA vocabulary). A fully-worked reference is [`example-flux.html`](example-flux.html). Your job is to fill the template with correct, real-as-possible content for the requested ecosystem — never to restyle it.

## Workflow

### 1. Identify the ecosystem

Take it from the user's request (`/ecosystem-seo-page Wan`) or ask. Resolve it against `src/shared/constants/basemodel.constants.ts` — grep for the `ECO.<Key>` entry and its `ecosystems`/`baseModelFamilies` records.

### 2. Auto-derive everything you can (don't ask for these)

From `basemodel.constants.ts` and a quick grep of the repo, pull:

- **Display name** (`displayName`) → `{{ECO_NAME}}`.
- **Modality** → image / video / audio / 3D. Determines `{{EXAMPLE_NOUN}}` ("generations" vs "videos"), `{{GEN_NOUN}}` ("Images" vs "Videos"), the example labels, and whether the settings line needs length/fps. `MODEL3D_ECOSYSTEM_IDS` and the video-ecosystem list in the template comment are your guide.
- **Family / parent** (`parentEcosystemId`, `familyId`) → informs positioning and which peers to compare against (siblings under the same family are natural comparison targets, e.g. Pony/Illustrious/NoobAI all under SDXL).
- **Open vs API-only** → whether the "Run locally" card is real or should become an "API only, run it here" note.
- **Generation support** — check the `generation` support entries and the generation graph/handler files to confirm the ecosystem is actually generatable and what the generator deep-link looks like (see step 5).

### 3. Ask the dev for what only a human knows

Use **AskUserQuestion** (batch the questions). Ask ONLY things you couldn't derive. Typical set:

- **Positioning** — the one-paragraph "what is it / who made it / headline capability" hero intro. Offer a drafted option they can accept or edit.
- **Creator / attribution** — e.g. "Black Forest Labs", license note for the badges and footer.
- **Comparison peers** — which 3 ecosystems to put in the "vs" table (pre-fill a sensible default from the family, let them override).
- **Stats source** — offer: (a) I'll query live counts (model count, generation count, LoRA count) via the postgres/clickhouse skills, or (b) use realistic placeholder numbers for a mockup. Default to asking because live queries touch prod.
- **Generator deep-link** — confirm the URL shape that pre-selects this base model (and ideally a specific model/LoRA). This is the entire funnel; if it doesn't exist yet, flag it and use `#`.

Keep it to one AskUserQuestion round of 2–4 questions where possible. If the user said "just mock it up / use placeholders", skip straight to plausible placeholder data (mirror the Flux example's style) and note the assumptions in your summary.

### 4. Pull real data when asked (optional, prod-touching)

If the dev opts into live data:

- **Stats & top models** — use the `postgres-query` skill (read-only) to count models per ecosystem and rank the top 6 by downloads/rating, and top LoRAs. Match on the ecosystem's base-model records.
- **Example generations** — real image/prompt/settings triples are the highest-SEO section. Curated example images MUST be **remixable**: the "Remix" button feeds each into the generator, so only pick images whose generation metadata is present and not creator-hidden. Filter the selection query on `i.type = 'image'`, `i."nsfwLevel" BETWEEN 1 AND 1` (PG/SFW), `i."needsReview" IS NULL`, `i."hideMeta" = false`, and `i.meta IS NOT NULL` (ideally `i.meta->>'prompt' IS NOT NULL`). An image with `hideMeta = true` looks fine but opens an empty generator — never feature it. (The runtime service re-checks these and drops any that fail, but curate remixable IDs so all six render.)
- **Generation counts** — `clickhouse-query` skill if needed.
  Always keep these read-only and scoped; never block the mockup on them — fall back to placeholders.

### 4b. Write grounded unique content (overview + prompt tips + per-ecosystem FAQ) — the SEO differentiator

The real `/ecosystems/[key]` page carries three pieces of unique long-form text that are the primary SEO lever (depth + de-duplication). **These MUST be grounded in authoritative sources — never free-written from model memory.** Free-writing scales an accuracy risk across every page and reads as thin/duplicate content to search engines.

The `EcosystemSeoConfig` fields:

- **`overview`** — 3 paragraphs of genuinely unique prose: what it is + provider + architecture/encoder, how its variants differ, and when to choose it vs. siblings. No superlatives stated as fact.
- **`promptTips`** — 5 ecosystem-specific "how to prompt" bullets.
- **The cost FAQ** must be **ecosystem-specific**, never a shared templated paragraph — an identical answer repeated across pages is a duplicate-content liability. Weave in something true about this model (lighter/cheaper → daily Blue Buzz stretches far; heavier → costs more Buzz).

**Buzz honesty rule (applies to all copy):** never claim generation is "free" or "runs free." It runs on **Buzz**; free users earn **free Blue Buzz** daily through on-site actions (reacting to images, etc.) — cheap models go far on it, pricier ones accumulate or need a membership. In the comparison table use **"Available on Civitai"** (not "Runs free on Civitai"). The only accurate "free" is "free Blue Buzz."

**Two authoritative sources, both reachable from here:**

1. **Model card → facts for the `overview`.** The model's own description, in the DB, via `postgres-query`:
   `SELECT id, name, left(regexp_replace(description,'<[^>]+>',' ','g'), 2500) AS desc FROM "Model" WHERE id IN (<featured checkpoint modelIds>)`
2. **Prompt-enhancement guide → rules for `promptTips`.** The orchestrator's canonical per-ecosystem guide. Extract `ORCHESTRATOR_ENDPOINT` + `ORCHESTRATOR_ACCESS_TOKEN` from `.env` (never print the token) and `GET /v1/manager/prompt-analysis/{key}`; the `systemPrompt` field holds the real rules (prompt style, token limits, weight-syntax + negative-prompt stance, camera/lighting/text conventions, known gotchas).
   - **Watch for the generic fallback:** some keys return boilerplate with no model-specific rules (seen for `pony`, `illustrious`, `noobai`). Detect it and fall back to the model card, and flag it.
   - **Video ecosystems** register per-variant keys — try several (`wanvideo-25-t2v`, `ltxv23`, …).

**Rules:** cite the exact sources used (modelId(s) + guide key + whether a real guide was found). Never invent numeric settings (CFG, steps, token limits) you can't source. If the model card and the guide conflict, prefer the guide and flag it for a human. This is independent, parallelizable work — one subagent per ecosystem scales it, but each MUST fetch both sources.

### 5. Fill the template

Copy `template.html` to `docs/working/ecosystem-seo/<key>.html`, then replace every `{{TOKEN}}` and expand each `<!-- REPEAT -->` block. Rules:

- Keep the `<style>` block **byte-for-byte**. Only edit body content.
- 6 model cards, 6 LoRA cards, 6 example cards, 5–6 FAQ items, 6–8 footer ecosystem links — match the reference counts.
- Cycle placeholder gradient classes `g1..g6` so the grids look alive.
- Checkpoints use `<span class="model-type-badge">`; LoRAs add class `lora`.
- Comparison table: `{{ECO_NAME}}` column carries `class="col-primary"`; wrap a winning cell in `<span class="comparison-check">`.
- **Video ecosystems**: heading → "Example videos", labels → "Generated clip", settings include length/fps.
- Write real microcopy, never lorem. Every FAQ answer ends in a soft CTA. The "how to run" right card must be honest about local requirements (or say API-only).
- Update the `<title>` token and remove the top instructional HTML comment.

### 6. Publish

Call the **Artifact** tool on the filled file:

- `favicon`: ⚡ (keep consistent across all ecosystem pages so they read as a set).
- `description`: one line naming the ecosystem and that it's the SEO hub concept.
- The file's own `<title>` names the artifact.

Then report to the dev: the artifact URL, what you auto-derived vs. asked vs. placeheld, and — importantly — whether the **generator deep-link** exists, since that's the funnel's linchpin.

## Notes

- This produces a **mockup/concept**, not a shipped route. If the dev wants it real, the follow-up is a Next.js `/ecosystems/[key]` page querying the same data — call that out but don't build it unless asked.
- Placeholder images are intentional: the artifact CSP blocks remote image hosts, so gradient slots stand in for real on-site generations. Say so in the summary.
- Don't invent metrics as if they're real when the dev didn't opt into live data — label them as illustrative.
