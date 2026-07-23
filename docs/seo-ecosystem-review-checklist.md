# SEO ecosystem pages — human review checklist

Dev-flagged claims on the ecosystem SEO pages that a human should verify against a source before we treat them as authoritative. Each links to the page (and the relevant section). Generated from the `factCheck` data in `src/shared/constants/ecosystem-seo.constants.ts`.

**15 pages · 21 items.** As of **2026-07-22** these were fact-checked against public sources (see per-item verdicts + source links). No claim was found to be outright wrong. The handful of open judgment calls were then **resolved by dev decision on 2026-07-22**:

- **HappyHorse & Seedream arena rankings** — keep both out of the evergreen pages (already excluded).
- **Anima weighting** — page now says weighting _works_ (use higher values like `:2`), replacing the old "don't use weight syntax" tip.
- **Specific video clip durations** (5s/10s/8s, etc.) — removed from all video-page copy and example settings; resolution/fps retained.

Resolved items had their `factCheck` flag removed from `ecosystem-seo.constants.ts`, so a regenerated checklist would no longer list them.

Legend: ✅ verified accurate · ⚠️ verified, decision since resolved · ❌ would mean a correction is needed (none found).

---

## Illustrious

Page: [https://civitai.com/ecosystems/illustrious](https://civitai.com/ecosystems/illustrious)

- [x] **promptTips** ([open →](https://civitai.com/ecosystems/illustrious#overview)) — **booru-tag prompting guidance** — Orchestrator prompt guide returned a generic fallback for this key — tips grounded in the model card + general SDXL/booru practice, not a model-specific guide.
  - ✅ **Verified 2026-07-22:** Correct. Illustrious is a Danbooru-trained SDXL anime fine-tune; comma-separated booru tags (important tags front-loaded), not natural-language sentences, is the established convention. Sources: [Illustrious prompt guide](https://civitai.com/articles/23210/arctenoxs-simple-prompt-guide-for-illustrious), [booru-style tagging guide](https://techtactician.com/booru-style-tagging-sdxl-anime-prompts-guide/).

## NoobAI

Page: [https://civitai.com/ecosystems/noobai](https://civitai.com/ecosystems/noobai)

- [x] **promptTips** ([open →](https://civitai.com/ecosystems/noobai#overview)) — **booru-tag prompting guidance** — Orchestrator prompt guide returned a generic fallback for this key — tips grounded in the model card + general booru practice, not a model-specific guide.
  - ✅ **Verified 2026-07-22:** Correct. NoobAI is a Danbooru+e621-trained SDXL fine-tune; same booru-tag convention as Illustrious. Sources: [Illustrious/NoobAI style explorer](https://github.com/ThetaCursed/Illustrious-NoobAI-Style-Explorer), [booru-style tagging guide](https://techtactician.com/booru-style-tagging-sdxl-anime-prompts-guide/).

## Pony

Page: [https://civitai.com/ecosystems/pony](https://civitai.com/ecosystems/pony)

- [x] **promptTips** ([open →](https://civitai.com/ecosystems/pony#overview)) — **score\_ tag prompt guidance** — Orchestrator prompt guide returned a generic fallback for this key — tips grounded in the model card + general Pony/booru practice, not a model-specific guide.
  - ✅ **Verified 2026-07-22:** Correct. Pony Diffusion V6 XL's documented convention is leading the positive prompt with score tags (`score_9, score_8_up, score_7_up, …`). Sources: [official Pony V6 XL model page](https://civitai.com/models/257749/pony-diffusion-v6-xl), [Pony prompt tags guide](https://stable-diffusion-art.com/pony-diffusion-prompt-tags/).

## HiDream

Page: [https://civitai.com/ecosystems/hidream](https://civitai.com/ecosystems/hidream)

- [x] **overview** ([open →](https://civitai.com/ecosystems/hidream#overview)) — **17B sparse mixture-of-experts transformer** — Verify the parameter count / MoE architecture against HiDream I1 release notes.
  - ✅ **Verified 2026-07-22:** Correct on both counts. The HiDream-I1 paper describes a **17B-parameter** image foundation model built on a **sparse Diffusion Transformer with a dynamic Mixture-of-Experts** (token-routed FFN experts + a shared expert). Source: [HiDream-I1 paper (arXiv 2505.22705)](https://arxiv.org/abs/2505.22705).

## Anima

Page: [https://civitai.com/ecosystems/anima](https://civitai.com/ecosystems/anima)

- [x] **promptTips** ([open →](https://civitai.com/ecosystems/anima#overview)) — **weight-syntax guidance** — The model card and the prompt guide CONFLICT on whether weight syntax works — the guide was followed. Confirm which is correct.
  - ✅ **Resolved 2026-07-22:** Not actually a conflict, it's an omission. The Hugging Face model card states **prompt weighting works** but needs higher-than-usual values (e.g. `(chibi:2)`); the orchestrator recipe just didn't mention it. The page previously told users _not_ to use weight syntax — now corrected to "weighting works, use a higher weight like `(word:2)`." Flag removed from config. Sources: [Anima HF card](https://huggingface.co/circlestone-labs/Anima), [Civitai orchestrator recipe](https://developer.civitai.com/orchestration/recipes/anima).

## Z-Image

Page: [https://civitai.com/ecosystems/z-image](https://civitai.com/ecosystems/z-image)

- [x] **overview** ([open →](https://civitai.com/ecosystems/z-image#overview)) — **compact ~6B architecture** — Verify the parameter count against the Z-Image release notes.
  - ✅ **Verified 2026-07-22:** Correct. Alibaba Tongyi Lab's Z-Image-Turbo (Nov 2025) is a **6B-parameter** single-stream DiT (S3-DiT). Source: [Tongyi-MAI/Z-Image-Turbo HF card](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo).

## Kling

Page: [https://civitai.com/ecosystems/kling](https://civitai.com/ecosystems/kling)

- [x] **featuredExamples** ([open →](https://civitai.com/ecosystems/kling#examples)) — **8-second example clip (imageId 133284218)** — Duration is the real image meta value, but sits outside the guide's stated 5s/10s modes — verify it's correct.
  - ✅ **Resolved 2026-07-22:** The 8s was a real meta value and legitimate (Kling 3.0 supports flexible 3–15s durations), but per dev decision **specific clip durations were removed from all video pages** — settings now show model · resolution · fps only, and the "5s/10s modes" prose was made duration-agnostic. This removed the inconsistency entirely; flag removed from config. Sources: [Kling length limits](https://www.atlascloud.ai/blog/guides/kling-ai-video-length-limit), [Kling 3.0](https://artlist.io/ai/models/kling-3-0).
- [x] **comparison** ([open →](https://civitai.com/ecosystems/kling#compare)) — **peer facts (Seedance = ByteDance, Hailuo = MiniMax) + qualitative ratings** — Peer positioning is editorial / general knowledge, not sourced metrics.
  - ✅ **Verified 2026-07-22:** Both attributions correct — Seedance = **ByteDance**, Hailuo = **MiniMax**. Qualitative ratings remain editorial by design. Sources: [MiniMax/Hailuo](<https://en.wikipedia.org/wiki/MiniMax_(company)>), [Hailuo](https://artlist.io/ai/models/hailuo-ai).

## Seedance

Page: [https://civitai.com/ecosystems/seedance](https://civitai.com/ecosystems/seedance)

- [x] **comparison** ([open →](https://civitai.com/ecosystems/seedance#compare)) — **qualitative ratings (prompt adherence, native audio peers)** — Editorial judgment, not sourced metrics — spot-check the peer cells.
  - ✅ **Verified 2026-07-22:** Factual cells hold — Seedance is **ByteDance** and **generates native/synchronized audio** (dialogue, ambient, foley in one pass). Prompt-adherence "edge" is relative (some comparisons rate Veo 3.1 higher), so keep it worded as a relative strength. Source: [Seedance 2.0](https://seeddance.ai/seedance-2-0).

## Grok Imagine

Page: [https://civitai.com/ecosystems/grok](https://civitai.com/ecosystems/grok)

- [x] **promptTips** ([open →](https://civitai.com/ecosystems/grok#overview)) — **video motion/camera prompt tip** — The real grok prompt guide is image-oriented (Aurora); there's no Grok-video guide, so the video-motion tip is general best practice, not sourced.
  - ⚠️ **Verified 2026-07-22:** Grok Imagine genuinely does **image + video** (image-to-video with motion prompts) and the image engine is xAI's **Aurora** — both confirmed. xAI describes prompting "the motion" incl. camera moves, but publishes **no detailed prompt spec**, so the specific camera-motion tips are community best practice, not officially documented. Fine to keep; just know it's not officially sourced. Sources: [xAI Grok Imagine 1.5](https://x.ai/news/grok-imagine-1-5), [Aurora launch](https://em360tech.com/tech-articles/what-xai-aurora-generator-inside-groks-new-image-generator).
- [x] **comparison** ([open →](https://civitai.com/ecosystems/grok#compare)) — **peer positioning / ratings** — Editorial, not sourced metrics.
  - ✅ **Verified 2026-07-22:** Editorial by design; no factual error found in the peer positioning. (Aurora / dual-modality basis confirmed above.)

## HappyHorse

Page: [https://civitai.com/ecosystems/happyhorse](https://civitai.com/ecosystems/happyhorse)

- [x] **attribution** ([open →](https://civitai.com/ecosystems/happyhorse)) — **"attributed to Alibaba"** — Corporate parent unconfirmed — the guide said "Alibaba, via fal.ai"; Civitai groups it under an Alibaba–Taotian family. Confirm the real owner.
  - ✅ **Verified 2026-07-22:** Correct. HappyHorse-1.0 is built by **Alibaba** (Taotian / "ATH" business group) with **fal.ai as the official API partner** (not the developer). Artificial Analysis lists the maker as "Alibaba-ATH" and notes the specific _lab_ attribution is not independently verified, but Alibaba as the owning company is consistent. Sources: [fal HappyHorse](https://fal.ai/happyhorse-1.0), [fal press release](https://www.prnewswire.com/news-releases/fal-launches-happyhorse-1-0--the-1-ranked-ai-video-model-as-official-api-partner-302755003.html), [Artificial Analysis](https://artificialanalysis.ai/video/model-families/happyhorse).
- [x] **overview** ([open →](https://civitai.com/ecosystems/happyhorse#overview)) — **native synchronized audio + physics-aware motion** — The model card leads with an unverified "#1 on the Artificial Analysis Video Arena / Elo 1416" claim, deliberately excluded here — decide whether to include.
  - ✅ **Resolved 2026-07-22:** Audio + physics claims **confirmed** (fal documents single-pass joint audio-video with native lip-sync + physics realism). **Dev decision: keep the ranking out** (it stays excluded). For the record, the #1 ranking is real but the "Elo 1416" figure was wrong anyway (fal lists 1333 T2V / 1392 I2V). Flag removed from config. Source: [fal HappyHorse](https://fal.ai/happyhorse-1.0).

## Nano Banana

Page: [https://civitai.com/ecosystems/nano-banana](https://civitai.com/ecosystems/nano-banana)

- [x] **promptTips** ([open →](https://civitai.com/ecosystems/nano-banana#overview)) — **editing / prompting tips** — No model-specific prompt guide exists (generic fallback) — tips grounded in the model card's documented editing capabilities, not a guide.
  - ✅ **Verified 2026-07-22:** Correct. Nano Banana = Google's **Gemini 2.5 Flash Image**, marketed around natural-language targeted editing (backgrounds/objects/colors/textures) and strong character consistency — exactly what the tips describe. Sources: [Google Developers blog](https://developers.googleblog.com/en/introducing-gemini-2-5-flash-image/), [Vertex AI](https://cloud.google.com/blog/products/ai-machine-learning/gemini-2-5-flash-image-on-vertex-ai).

## Seedream

Page: [https://civitai.com/ecosystems/seedream](https://civitai.com/ecosystems/seedream)

- [x] **promptTips** ([open →](https://civitai.com/ecosystems/seedream#overview)) — **prompting tips** — Prompt guide was a generic fallback — tips grounded in the model card. ByteDance publishes an official Seedream guide worth mirroring.
  - ✅ **Verified 2026-07-22:** Grounding is sound; ByteDance's Seed team does publish official Seedream material worth mirroring. Source: [ByteDance Seed — Seedream 4.0](https://seed.bytedance.com/en/blog/seedream-4-0-officially-released-beyond-drawing-into-imagination).
- [x] **overview** ([open →](https://civitai.com/ecosystems/seedream#overview)) — **native 2K / 4K resolution** — Sourced from the model card. The card's original "#1 on the Image Arena" claim was removed as unverified — decide whether to include.
  - ✅ **Resolved 2026-07-22:** **2K/4K is native** (generated, not upscaled — Seedream 4.0; 3.0 capped at 2K). On the arena claim: it _was_ genuinely #1 on both Artificial Analysis text-to-image and editing arenas at the **Sept 2025 launch**, but has since been overtaken (GPT Image 2 debuted #1; Seedream slid to ~#7). **Dev decision: keep the ranking out** (already excluded). Flag removed from config. Sources: [ByteDance Seed](https://seed.bytedance.com/en/blog/seedream-4-0-officially-released-beyond-drawing-into-imagination), [Artificial Analysis model page](https://artificialanalysis.ai/image/explore/model/bytedance-seed_seedream-4-0).

## Veo 3

Page: [https://civitai.com/ecosystems/veo-3](https://civitai.com/ecosystems/veo-3)

- [x] **comparison** ([open →](https://civitai.com/ecosystems/veo-3#compare)) — **peer native-audio cells (Sora 2 = Yes, Kling = No, …)** — Cross-checked against the Sora 2 config (consistent), but peer cells are general knowledge, not re-verified against each provider.
  - ✅ **Verified 2026-07-22:** All cells accurate. Veo 3 generates native audio (dialogue/SFX/ambient); **Sora 2 = Yes** (native audio since its Sept 2025 launch); **Kling = No** (no native synchronized audio). Sources: [Google DeepMind Veo](https://deepmind.google/models/veo/), [OpenAI Sora 2](https://openai.com/index/sora-2/).

## Sora 2

Page: [https://civitai.com/ecosystems/sora-2](https://civitai.com/ecosystems/sora-2)

- [x] **overview** ([open →](https://civitai.com/ecosystems/sora-2#overview)) — **synchronized audio (speech, SFX, soundscapes)** — Claimed from the model card only; the sora2 prompt guide does not mention audio. Verify the capability.
  - ✅ **Verified 2026-07-22:** Confirmed. OpenAI states Sora 2 generates video with natively synchronized audio incl. dialogue/speech, sound effects, and ambient soundscapes. Source: [OpenAI Sora 2](https://openai.com/index/sora-2/).
- [x] **comparison** ([open →](https://civitai.com/ecosystems/sora-2#compare)) — **peer native-audio / provider cells** — From general knowledge / sibling configs, not independently re-verified.
  - ✅ **Verified 2026-07-22:** Consistent with the Veo 3 check above — peer native-audio/provider cells hold. Sources: [OpenAI Sora 2](https://openai.com/index/sora-2/), [Google DeepMind Veo](https://deepmind.google/models/veo/).

## Chroma

Page: [https://civitai.com/ecosystems/chroma](https://civitai.com/ecosystems/chroma)

- [x] **localRun** ([open →](https://civitai.com/ecosystems/chroma#how-to-run)) — **~12GB+ VRAM / ~9–18GB weights** — Estimates, not stated in the model card (card only confirms FP8/GGUF variants exist). Verify against Chroma release notes.
  - ✅ **Verified 2026-07-22:** Accurate. Chroma (8.9B params, based on FLUX.1-schnell, Apache 2.0) runs on **~12GB+ VRAM** via FP8/Q8 quants; weights span **~9GB (FP8/pruned) to ~17–18GB (FP16)** — the "~9–18GB" range is right. Sources: [Chroma HF README](https://huggingface.co/lodestones/Chroma/blob/main/README.md), [willitrunai Chroma](https://willitrunai.com/image-models/chroma-1).
- [x] **comparison** ([open →](https://civitai.com/ecosystems/chroma#compare)) — **peer parameter counts (SDXL ~3.5B, etc.)** — Approximate — adjust if you want exact figures.
  - ✅ **Verified 2026-07-22:** **SDXL ~3.5B is correct** (2.6B UNet + ~817M dual text encoders ≈ 3.4–3.5B total, per the SDXL paper). Source: [SDXL paper (arXiv 2307.01952)](https://arxiv.org/pdf/2307.01952).

---

## Second pass — unflagged prose (2026-07-22)

Beyond the dev-flagged claims above, the **descriptive/architecture/version prose** on every page was fact-checked against primary sources (papers, HF cards, official release notes). ~85 specific claims across all 24 pages. Most held up; the corrections below were applied to `ecosystem-seo.constants.ts`.

### Corrected (were inaccurate)

- [x] **Imagen 4 — negative-prompt field.** Page told users to use "the separate negative-prompt field" (3 places). ❌ `negativePrompt` was **removed as of Imagen 3**; Imagen 4 has none. **Fixed:** rewrote all three to "phrase everything positively — no negative-prompt field." Source: [google-genai #339](https://github.com/googleapis/python-genai/issues/339).
- [x] **Seedream — 4K debut version.** Page said "Seedream **4.5** adds 4K" (4 places). ❌ 4K arrived in **Seedream 4.0**; 4.5's upgrade was text rendering. **Fixed:** 4.5 → 4.0 everywhere. Source: [ByteDance Seed — Seedream 4.0](https://seed.bytedance.com/en/blog/seedream-4-0-officially-released-beyond-drawing-into-imagination).
- [x] **Flux.2 — "Max" tier.** Page listed API tiers "Pro, Max, and Flex." ❌ **Max** is not a documented Flux.2 tier (only Pro/Flex are API-only; Dev/Klein open). **Fixed:** dropped Max (now "Pro and Flex"). Source: [BFL Flux.2 blog](https://bfl.ai/blog/flux-2).
- [x] **Flux.2 — hex color codes.** Claimed it "accepts hex color codes tied to specific objects" (overview + a promptTip). ⚠️ No primary source (not in BFL blog or GitHub README). **Fixed:** replaced with "name exact shades and materials."
- [x] **Chroma — CFG default.** PromptTip said "default guidance scale is around 5.0." ⚠️ The official HF example uses **~3.0**; no source for a 5.0 default. **Fixed:** now "official example uses ~3.0." Source: [Chroma HF](https://huggingface.co/lodestones/Chroma1-Base).
- [x] **Krea 2 — "Large ≈ 2× Medium parameters."** ⚠️ Krea publishes no per-tier parameter counts. **Fixed:** dropped the 2× claim (kept the softer-post-training distinction). Source: [Krea 2 docs](https://www.krea.ai/docs/user-guide/features/krea-2).
- [x] **Veo 3 — "returns a generic PG clip (no refund)."** ⚠️ Real behavior is safety-filtering, but the specific "generic PG clip / no refund" framing isn't documented by Google (3 places). **Fixed:** softened to "explicit prompts are filtered" while keeping the SFW steer.
- [x] **Seedance — resolution.** Page said "480p or 720p native." ❌ Understated — Seedance 2.0 supports **480p / 720p / 1080p / 4K** (Fast capped at 720p). **Fixed:** "from 480p up to 4K native" (2 places). Source: [Scenario — Seedance](https://help.scenario.com/articles/5480884735-seedance-models-the-essentials).

### Verified accurate (spot-check highlights, no change)

- **Flux.1** 12B rectified-flow transformer, Dev 512 / Schnell 256 tokens, Dev/Schnell/Krea/Kontext variants — all ✅. (Minor: encoder is CLIP+T5, page simplifies to "T5"; left as a fair simplification.)
- **Flux.2** Mistral Small 3.2 encoder, Klein 9B/4B — ✅.
- **Chroma** de-distilled Flux.1-schnell ~8.9B, T5, Apache-2.0, Base/HD/Flash/Radiance variants — ✅.
- **SDXL** 1024px, base+refiner, dual CLIP (77-tok), weighting math — ✅. Illustrious=OnomaAI, NoobAI=Laxhar Lab (+e621), Pony=AstraliteHeart (clip skip 2, Euler a/25 steps) — ✅. Qwen-Image 20B, Qwen-Image-Edit — ✅ (its 16GB/20GB local figure is the FP8 path; full precision is ~40GB — acceptable as the practical number).
- **Anima** 2B, CircleStone×Comfy Org, Qwen 3 0.6B encoder + Qwen-Image VAE, Sept-2025 cutoff, Base/Aesthetic/Turbo — ✅.
- **Z-Image** ~6B S³-DiT, Turbo 8 steps, fits 16GB / sub-second on H800 — ✅.
- **Wan** Wan-VAE, 1.3B–14B, 2.1 first open CN+EN in-clip text, 2.2 MoE + 5B TI2V, **2.7 is current** — ✅. **LTXV** DiT/real-time/T5, LTX-2 (19B) joint A/V, LTX-2.3, Sulphur 2 — ✅.
- **Kling** Kuaishou, 3.0 current (Feb 2026) — ✅. **Grok** Aurora autoregressive image model + dual image/video — ✅. **HappyHorse** unified-Transformer native A/V, EN/CN/JP, v1.1 — ✅ (developer is an ex-Alibaba/ex-Kuaishou **spin-off**, which supports keeping the hedged "attributed to Alibaba" wording + its existing flag).
- **Nano Banana** = Gemini 2.5 Flash Image; original/Pro/2 versions real — ✅. **Sora 2** OpenAI, successor to Sora (Feb 2024), synchronized audio — ✅.

### Freshness disclosure

A standing note — _"AI models move fast — new versions ship often, and a model's capabilities or Buzz cost can change. For the latest, check the model's own page before you generate."_ — now renders on every **video and API-only** page (gated on `isVideo || apiOnly`), so version-drift is disclosed rather than asserted.
