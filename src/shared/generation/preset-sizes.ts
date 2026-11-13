import { sdxlFullAspectRatioBuckets } from '~/shared/constants/generation.constants';
import type { AspectRatioOption } from '~/shared/form-graph/generation/defs';
import { grokImageAspectRatios } from '~/shared/form-graph/generation/image/grok.graph';
import { nanoBananaBaseAspectRatios } from '~/shared/form-graph/generation/image/nano-banana.graph';
import {
  openaiGpt1AspectRatios,
  openaiGpt2AspectRatios,
} from '~/shared/form-graph/generation/image/openai.graph';
import { qwenAspectRatios } from '~/shared/form-graph/generation/image/qwen.graph';
import { seedreamAspectRatios2K } from '~/shared/form-graph/generation/image/seedream.graph';

export type PresetSize = AspectRatioOption;

/**
 * Every size each preset model's graph can produce at the resolution the preset asks for (the
 * graph's default unless the registry sets one), keyed by the app-facing model name. The server
 * records panel dimensions against this, so a label the picker never offered still records what
 * the graph made of it.
 */
export const PRESET_MODEL_GRAPH_SIZES = {
  NanoBanana2: nanoBananaBaseAspectRatios,
  NanoBanana: nanoBananaBaseAspectRatios,
  Flux2: sdxlFullAspectRatioBuckets,
  Seedream: seedreamAspectRatios2K,
  SeedreamLite: seedreamAspectRatios2K,
  OpenAI: openaiGpt1AspectRatios,
  OpenAI2: openaiGpt2AspectRatios,
  OpenAI25Flare: openaiGpt2AspectRatios,
  OpenAI25Sunburst: openaiGpt2AspectRatios,
  Qwen: qwenAspectRatios,
  Grok: grokImageAspectRatios,
} satisfies Record<string, PresetSize[]>;

export type PresetModelKey = keyof typeof PRESET_MODEL_GRAPH_SIZES;

const PRESET_RATIOS = ['16:9', '4:3', '1:1', '3:4', '9:16'];

/** The preset ratios a graph has; a graph with fewer than three of them offers all of its own. */
const offered = (sizes: PresetSize[]): PresetSize[] => {
  const picked = sizes.filter((s) => PRESET_RATIOS.includes(s.value));
  return picked.length >= 3 ? picked : sizes;
};

/** What the comics picker shows: the five preset ratios where the graph has them, else its whole list. */
export const PRESET_MODEL_SIZES: Record<string, PresetSize[]> = Object.fromEntries(
  Object.entries(PRESET_MODEL_GRAPH_SIZES).map(([key, sizes]) => [key, offered(sizes)])
);

/** The ratio a preset starts on: portrait where the list has one, else its first entry. */
export const defaultPresetRatio = (sizes: PresetSize[]) =>
  (sizes.find((s) => s.value === '3:4' || s.value === '2:3') ?? sizes[0]).label;
