# SEO ecosystem pages — human review checklist

Dev-flagged claims on the ecosystem SEO pages that a human should verify against a source before we treat them as authoritative. Each links to the page (and the relevant section). Tick items as you confirm/fix them. Generated from the `factCheck` data in `src/shared/constants/ecosystem-seo.constants.ts`.

**15 pages · 21 items to review.**

---

## Illustrious

Page: [https://civitai.com/ecosystems/illustrious](https://civitai.com/ecosystems/illustrious)

- [ ] **promptTips** ([open →](https://civitai.com/ecosystems/illustrious#overview)) — **booru-tag prompting guidance** — Orchestrator prompt guide returned a generic fallback for this key — tips are grounded in the model card + general SDXL/booru practice, not a model-specific guide.

## NoobAI

Page: [https://civitai.com/ecosystems/noobai](https://civitai.com/ecosystems/noobai)

- [ ] **promptTips** ([open →](https://civitai.com/ecosystems/noobai#overview)) — **booru-tag prompting guidance** — Orchestrator prompt guide returned a generic fallback for this key — tips are grounded in the model card + general booru practice, not a model-specific guide.

## Pony

Page: [https://civitai.com/ecosystems/pony](https://civitai.com/ecosystems/pony)

- [ ] **promptTips** ([open →](https://civitai.com/ecosystems/pony#overview)) — **score_ tag prompt guidance** — Orchestrator prompt guide returned a generic fallback for this key — tips are grounded in the model card + general Pony/booru practice, not a model-specific guide.

## HiDream

Page: [https://civitai.com/ecosystems/hidream](https://civitai.com/ecosystems/hidream)

- [ ] **overview** ([open →](https://civitai.com/ecosystems/hidream#overview)) — **17B sparse mixture-of-experts transformer** — Verify the parameter count / MoE architecture against HiDream I1 release notes.

## Anima

Page: [https://civitai.com/ecosystems/anima](https://civitai.com/ecosystems/anima)

- [ ] **promptTips** ([open →](https://civitai.com/ecosystems/anima#overview)) — **weight-syntax guidance** — The model card and the prompt guide CONFLICT on whether weight syntax works — the guide was followed. Confirm which is correct.

## Z-Image

Page: [https://civitai.com/ecosystems/z-image](https://civitai.com/ecosystems/z-image)

- [ ] **overview** ([open →](https://civitai.com/ecosystems/z-image#overview)) — **compact ~6B architecture** — Verify the parameter count against the Z-Image release notes.

## Kling

Page: [https://civitai.com/ecosystems/kling](https://civitai.com/ecosystems/kling)

- [ ] **featuredExamples** ([open →](https://civitai.com/ecosystems/kling#examples)) — **8-second example clip (imageId 133284218)** — Duration is the real image meta value, but sits outside the guide's stated 5s/10s modes — verify it's correct.
- [ ] **comparison** ([open →](https://civitai.com/ecosystems/kling#compare)) — **peer facts (Seedance = ByteDance, Hailuo = MiniMax) + qualitative ratings** — Peer positioning is editorial / general knowledge, not sourced metrics.

## Seedance

Page: [https://civitai.com/ecosystems/seedance](https://civitai.com/ecosystems/seedance)

- [ ] **comparison** ([open →](https://civitai.com/ecosystems/seedance#compare)) — **qualitative ratings (prompt adherence, native audio peers)** — Editorial judgment, not sourced metrics — spot-check the peer cells.

## Grok Imagine

Page: [https://civitai.com/ecosystems/grok](https://civitai.com/ecosystems/grok)

- [ ] **promptTips** ([open →](https://civitai.com/ecosystems/grok#overview)) — **video motion/camera prompt tip** — The real grok prompt guide is image-oriented (Aurora); there's no Grok-video guide, so the video-motion tip is general best practice, not sourced.
- [ ] **comparison** ([open →](https://civitai.com/ecosystems/grok#compare)) — **peer positioning / ratings** — Editorial, not sourced metrics.

## HappyHorse

Page: [https://civitai.com/ecosystems/happyhorse](https://civitai.com/ecosystems/happyhorse)

- [ ] **attribution** ([open →](https://civitai.com/ecosystems/happyhorse)) — **"attributed to Alibaba"** — Corporate parent unconfirmed — the guide said "Alibaba, via fal.ai"; Civitai groups it under an Alibaba–Taotian family. Confirm the real owner.
- [ ] **overview** ([open →](https://civitai.com/ecosystems/happyhorse#overview)) — **native synchronized audio + physics-aware motion** — The model card leads with an unverified "#1 on the Artificial Analysis Video Arena / Elo 1416" claim, deliberately excluded here — decide whether to include.

## Nano Banana

Page: [https://civitai.com/ecosystems/nano-banana](https://civitai.com/ecosystems/nano-banana)

- [ ] **promptTips** ([open →](https://civitai.com/ecosystems/nano-banana#overview)) — **editing / prompting tips** — No model-specific prompt guide exists (generic fallback) — tips are grounded in the model card’s documented editing capabilities, not a guide.

## Seedream

Page: [https://civitai.com/ecosystems/seedream](https://civitai.com/ecosystems/seedream)

- [ ] **promptTips** ([open →](https://civitai.com/ecosystems/seedream#overview)) — **prompting tips** — Prompt guide was a generic fallback — tips grounded in the model card. ByteDance publishes an official Seedream guide worth mirroring.
- [ ] **overview** ([open →](https://civitai.com/ecosystems/seedream#overview)) — **native 2K / 4K resolution** — Sourced from the model card. The card’s original "#1 on the Image Arena" claim was removed as unverified — decide whether to include.

## Veo 3

Page: [https://civitai.com/ecosystems/veo-3](https://civitai.com/ecosystems/veo-3)

- [ ] **comparison** ([open →](https://civitai.com/ecosystems/veo-3#compare)) — **peer native-audio cells (Sora 2 = Yes, Kling = No, …)** — Cross-checked against the Sora 2 config (consistent), but peer cells are general knowledge, not re-verified against each provider.

## Sora 2

Page: [https://civitai.com/ecosystems/sora-2](https://civitai.com/ecosystems/sora-2)

- [ ] **overview** ([open →](https://civitai.com/ecosystems/sora-2#overview)) — **synchronized audio (speech, SFX, soundscapes)** — Claimed from the model card only; the sora2 prompt guide does not mention audio. Verify the capability.
- [ ] **comparison** ([open →](https://civitai.com/ecosystems/sora-2#compare)) — **peer native-audio / provider cells** — From general knowledge / sibling configs, not independently re-verified.

## Chroma

Page: [https://civitai.com/ecosystems/chroma](https://civitai.com/ecosystems/chroma)

- [ ] **localRun** ([open →](https://civitai.com/ecosystems/chroma#how-to-run)) — **~12GB+ VRAM / ~9–18GB weights** — Estimates, not stated in the model card (card only confirms FP8/GGUF variants exist). Verify against Chroma release notes.
- [ ] **comparison** ([open →](https://civitai.com/ecosystems/chroma#compare)) — **peer parameter counts (SDXL ~3.5B, etc.)** — Approximate — adjust if you want exact figures.

