# Advanced Section Controllers (GenerationForm)

All controllers/nodes rendered inside the `<AccordionLayout label="Advanced">` section in [GenerationForm.tsx](src/components/generation_v2/GenerationForm.tsx#L1974-L2629).

| # | Node Name | Label | Input Component | Description | Conditional |
|---|-----------|-------|-----------------|-------------|-------------|
| 1 | `cfgScale` | CFG Scale | `SliderInput` | Controls how closely generation follows the text prompt | — |
| 2 | `sampler` | Sampler | `SelectInput` | Sampling method — each produces different results | — |
| 3 | `scheduler` | Scheduler | `SelectInput` | Controls the noise schedule during generation | Anima, Flux2Klein, ZImage |
| 4 | `steps` | Steps | `SliderInput` | Number of iterations spent generating | — |
| 5 | `movementAmplitude` | Movement Amplitude | `SegmentedControlWrapper` | Camera movement and subject action scale | Vidu |
| 6 | `seed` | Seed | `SeedInput` | Random seed for reproducibility | — |
| 7 | `clipSkip` | CLIP Skip | `SliderInput` | Skip CLIP layers | SD only |
| 8 | `denoise` | Denoise Strength | `SliderInput` | Denoising strength for img2img | img2img only (renders `null` when no meta) |
| 9 | `vae` | VAE | `ResourceSelectInput` | Additional color and detail improvements | SD only |
| 10 | `enhancedCompatibility` | Enhanced Compatibility | `Checkbox` | Off (default) runs sdcpp; on runs comfyui | SD1, SDXL — txt2img only |
| 11 | `usePro` | Pro Mode | `Checkbox` | Higher quality generation (more credits) | Sora |
| 12 | `fluxUltraRaw` | Raw Mode | `Checkbox` | More natural, less processed look | Flux Ultra |
| 13 | `transparent` | Transparent Background | `Checkbox` | Generate image with transparent background | OpenAI |
| 14 | `quality` | Quality | `SelectInput` | Quality level selector | OpenAI |
| 15 | `enablePromptEnhancer` | Enhance prompt | `Checkbox` | Automatically improve prompt for better results | Video ecosystems |
| 16 | `draft` | Draft Mode | `Checkbox` | Generate faster at lower quality | Wan v2.2-5b |
| 17 | `shift` | Shift | `SliderInput` | Shift parameter | Wan v2.2, v2.2-5b |
| 18 | `interpolatorModel` | Interpolator | `SelectInput` | Interpolator model selector | Wan v2.2 |

**Not in this section:** `resolution` renders in the main form body, directly above `aspectRatio` — not in Advanced. It is a quality tier on the video ecosystems and a base-resolution tier on the image ecosystems that expose it (Seedream, Nano Banana, Lens, HiDream-O1, and Krea 2's comfy builds, where 1K/2K scales the aspect-ratio dimensions).

**Note:** There is also a commented-out duplicate `draft` controller (lines 2587–2598) labeled "Turbo Mode" for Wan v2.2 — currently inactive.

All controllers use the `<Controller graph={graph} name="..." />` pattern and only render when the current workflow/ecosystem graph exposes the corresponding node.
