# Ecosystems Missing Default Model ID

This document lists ecosystems that have generation support but are missing a `defaults.model.id` in `ecosystemSettings`.

## Ecosystems with Generation Support but No Default Model ID

These ecosystems have generation support configured but rely on engine-based generation rather than a specific checkpoint model:

| Ecosystem | Engine | Model Types |
|-----------|--------|-------------|
| HyV1 (Hunyuan Video) | hunyuan | LORA only |
| WanVideo | wan | LORA only |
| WanVideo14B_T2V | wan | Checkpoint, LORA |
| WanVideo14B_I2V_480p | wan | Checkpoint, LORA |
| WanVideo14B_I2V_720p | wan | Checkpoint, LORA |
| WanVideo22_TI2V_5B | wan | Checkpoint, LORA |
| WanVideo22_I2V_A14B | wan | Checkpoint, LORA |
| WanVideo22_T2V_A14B | wan | Checkpoint, LORA |
| WanVideo25_T2V | wan | Checkpoint only |
| WanVideo25_I2V | wan | Checkpoint only |
| Veo3 | veo3 | Checkpoint only |

## Ecosystems WITHOUT Generation Support

These ecosystems exist but do NOT have generation support configured (matching v1 behavior):

| Ecosystem | Notes |
|-----------|-------|
| SD2 | Legacy, no generation support |
| SD3 | Disabled models |
| SD35M | Disabled models |
| SDXLDistilled | Hidden variants |
| HyDit1 | Hunyuan DiT (image) - no gen support in v1 |
| AuraFlow | No gen support in v1 |
| Kolors | No gen support in v1 |
| Lumina | No gen support in v1 |
| Mochi | No gen support in v1 |
| PixArtA | No gen support in v1 |
| PixArtE | No gen support in v1 |
| CogVideoX | No gen support in v1 |
| LTXV | No gen support in v1 |
| WanVideo1_3B_T2V | No gen support in v1 |
| SCascade | Disabled, different architecture |
| SVD | Disabled |
| PlaygroundV2 | Hidden, no gen support in v1 |
| ODOR | Hidden, no gen support in v1 |
| Other | Catch-all, no gen support in v1 |

## Ecosystems WITH Generation Support AND Default Model ID

For reference, these ecosystems have both generation support and a default model configured:

| Ecosystem | Model Version ID | Model Types |
|-----------|-----------------|-------------|
| SD1 | 128713 | Full addon types |
| SDXL | 128078 | Full addon types |
| Pony | 290640 | Inherits from SDXL |
| Illustrious | 889818 | Inherits from SDXL |
| NoobAI | 1190596 | Inherits from SDXL |
| Flux1 | 691639 | Checkpoint, LORA |
| FluxKrea | 2068000 | Checkpoint, LORA |
| Flux1Kontext | 1892509 | Checkpoint only |
| Flux2 | 2439067 | Checkpoint, LORA |
| Chroma | 2164239 | Full addon types |
| HiDream | 1771369 | Checkpoint, LORA |
| Qwen | 2113658 | Checkpoint, LORA |
| NanoBanana | 2154472 | Checkpoint only |
| OpenAI | 1733399 | Checkpoint only |
| Imagen4 | 1889632 | Checkpoint only |
| Seedream | 2208278 | Checkpoint only |
| ZImageTurbo | 2442439 | Checkpoint, LORA |
| PonyV7 | 2152373 | Checkpoint, LORA |
| Sora2 | (no model id) | Checkpoint only |
