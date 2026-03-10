import { ComicGenre } from '~/shared/utils/prisma/enums';
import { formatGenreLabel } from '~/utils/comic-helpers';

export const COMIC_MODEL_SIZES: Record<string, { label: string; width: number; height: number }[]> =
  {
    NanoBanana: [
      { label: '16:9', width: 2560, height: 1440 },
      { label: '4:3', width: 2304, height: 1728 },
      { label: '1:1', width: 2048, height: 2048 },
      { label: '3:4', width: 1728, height: 2304 },
      { label: '9:16', width: 1440, height: 2560 },
    ],
    Flux2: [
      { label: 'Square', width: 1024, height: 1024 },
      { label: 'Landscape', width: 1216, height: 832 },
      { label: 'Portrait', width: 832, height: 1216 },
    ],
    Seedream: [
      { label: '16:9', width: 2560, height: 1440 },
      { label: '4:3', width: 2304, height: 1728 },
      { label: '1:1', width: 2048, height: 2048 },
      { label: '3:4', width: 1728, height: 2304 },
      { label: '9:16', width: 1440, height: 2560 },
    ],
    OpenAI: [
      { label: '1:1', width: 1024, height: 1024 },
      { label: '3:2', width: 1536, height: 1024 },
      { label: '2:3', width: 1024, height: 1536 },
    ],
    Qwen: [
      { label: '16:9', width: 1664, height: 928 },
      { label: '4:3', width: 1472, height: 1104 },
      { label: '1:1', width: 1328, height: 1328 },
      { label: '3:4', width: 1104, height: 1472 },
      { label: '9:16', width: 928, height: 1664 },
    ],
  };

export const COMIC_MODEL_MAX_IMAGES: Record<string, number> = {
  NanoBanana: 7,
  Flux2: 4,
  Seedream: 7,
  OpenAI: 7,
  Qwen: 3,
};

export const COMIC_MODEL_OPTIONS = [
  { value: 'NanoBanana', label: 'Nano Banana Pro' },
  { value: 'Flux2', label: 'Flux.2' },
  { value: 'Seedream', label: 'Seedream v4.5' },
  { value: 'OpenAI', label: 'OpenAI GPT-Image' },
  { value: 'Qwen', label: 'Qwen' },
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
};
