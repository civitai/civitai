/**
 * A leaf on purpose: `generation.constants` imports the server constants, which list the default
 * checkpoints with these ranges, so the ranges cannot live beside the other generation constants.
 */

/** The strength a LoRA may be generated at when its version sets no narrower range. */
export const LORA_STRENGTH_BOUNDS = { min: -1, max: 2 } as const;

/** A resource's strength settings when its version sets none. */
export const DEFAULT_STRENGTH_RANGE = { ...LORA_STRENGTH_BOUNDS, default: 1 } as const;

/**
 * Form state saved before the settings shape has no range, and equal bounds are a version that
 * set none it meant; either way the slider keeps the full range.
 */
export const strengthSliderBounds = (range: { min: number; max: number } | null | undefined) =>
  !range || range.min === range.max ? LORA_STRENGTH_BOUNDS : { min: range.min, max: range.max };
