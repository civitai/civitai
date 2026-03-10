# Advanced Section Controllers (GenerationForm)

All controllers/nodes rendered inside the `<AccordionLayout label="Advanced">` section in [GenerationForm.tsx](src/components/generation_v2/GenerationForm.tsx#L757-L1087).

| # | Node Name | Label | Input Component | Description | Conditional |
|---|-----------|-------|-----------------|-------------|-------------|
| 1 | `resolution` | Resolution | `SegmentedControlWrapper` | Video quality/resolution selector | Wan/Sora video ecosystems |
| 2 | `cfgScale` | CFG Scale | `SliderInput` | Controls how closely generation follows the text prompt | — |
| 3 | `sampler` | Sampler | `SelectInput` | Sampling method — each produces different results | — |
| 4 | `scheduler` | Scheduler | `SelectInput` | Controls the noise schedule during generation | SdCpp ecosystems |
| 5 | `steps` | Steps | `SliderInput` | Number of iterations spent generating | — |
| 6 | `movementAmplitude` | Movement Amplitude | `SegmentedControlWrapper` | Camera movement and subject action scale | Vidu |
| 7 | `seed` | Seed | `SeedInput` | Random seed for reproducibility | — |
| 8 | `clipSkip` | CLIP Skip | `SliderInput` | Skip CLIP layers | SD only |
| 9 | `denoise` | Denoise Strength | `SliderInput` | Denoising strength for img2img | img2img only (renders `null` when no meta) |
| 10 | `vae` | VAE | `ResourceSelectInput` | Additional color and detail improvements | SD only |
| 11 | `enhancedCompatibility` | Enhanced Compatibility | `Checkbox` | Toggle enhanced compatibility mode | — |
| 12 | `usePro` | Pro Mode | `Checkbox` | Higher quality generation (more credits) | Sora |
| 13 | `fluxUltraRaw` | Raw Mode | `Checkbox` | More natural, less processed look | Flux Ultra |
| 14 | `transparent` | Transparent Background | `Checkbox` | Generate image with transparent background | OpenAI |
| 15 | `quality` | Quality | `SelectInput` | Quality level selector | OpenAI |
| 16 | `enablePromptEnhancer` | Enhance prompt | `Checkbox` | Automatically improve prompt for better results | Video ecosystems |
| 17 | `draft` | Draft Mode | `Checkbox` | Generate faster at lower quality | Wan v2.2-5b |
| 18 | `shift` | Shift | `SliderInput` | Shift parameter | Wan v2.2, v2.2-5b |
| 19 | `interpolatorModel` | Interpolator | `SelectInput` | Interpolator model selector | Wan v2.2 |

**Note:** There is also a commented-out duplicate `draft` controller (lines 1075–1086) labeled "Turbo Mode" for Wan v2.2 — currently inactive.

All controllers use the `<Controller graph={graph} name="..." />` pattern and only render when the current workflow/ecosystem graph exposes the corresponding node.
