import { ComicGenre } from '~/shared/utils/prisma/enums';
import { formatGenreLabel } from '~/utils/comic-helpers';

export const COMIC_MODEL_MAX_IMAGES: Record<string, number> = {
  NanoBanana2: 7,
  NanoBanana: 7,
  Flux2: 4,
  Seedream: 7,
  SeedreamLite: 7,
  OpenAI: 7,
  OpenAI2: 7,
  OpenAI25Flare: 7,
  OpenAI25Sunburst: 7,
  Qwen: 3,
  Grok: 7,
};

// NanoBanana 2 is the default — listed first so it's what new users land on
// when no project preference is saved.
export const COMIC_MODEL_OPTIONS = [
  { value: 'NanoBanana2', label: 'Nano Banana 2' },
  { value: 'NanoBanana', label: 'Nano Banana Pro' },
  { value: 'Flux2', label: 'Flux.2' },
  { value: 'Seedream', label: 'Seedream v4.5' },
  { value: 'SeedreamLite', label: 'Seedream 5 Lite' },
  { value: 'OpenAI', label: 'OpenAI GPT-Image' },
  { value: 'OpenAI2', label: 'OpenAI GPT-Image 2' },
  { value: 'OpenAI25Flare', label: 'OpenAI GPT-Image 2.5 Flare' },
  { value: 'OpenAI25Sunburst', label: 'OpenAI GPT-Image 2.5 Sunburst' },
  { value: 'Qwen', label: 'Qwen' },
  { value: 'Grok', label: 'Grok Imagine' },
];

export const genreOptions = Object.entries(ComicGenre).map(([key, value]) => ({
  value,
  label: formatGenreLabel(key),
}));

export const refTypeBadge: Record<string, { label: string; color: string }> = {
  Character: { label: 'Char', color: 'blue' },
  Location: { label: 'Loc', color: 'teal' },
  Item: { label: 'Item', color: 'grape' },
  Style: { label: 'Style', color: 'orange' },
};

export type BulkPanelItem = {
  id: string;
  sourceImage?: { url: string; cfId: string; width: number; height: number; preview: string };
  prompt: string;
  aspectRatio: string;
  // Generation metadata from the source image (PNG tags for file uploads,
  // workflow step meta for generator picks). Forwarded to bulkCreatePanels
  // so the underlying Image carries proper resource attribution.
  meta?: Record<string, unknown>;
};
