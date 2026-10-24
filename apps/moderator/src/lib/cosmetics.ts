import { CosmeticType } from '@civitai/db-schema/enums';
import type { MediaType } from '$lib/media/edge-url';

export { CosmeticType };

export const humanizeCosmeticType = (t: string): string => t.replace(/([a-z])([A-Z])/g, '$1 $2');

export const cosmeticTypeFilters = Object.values(CosmeticType).map((value) => ({
  value,
  label: humanizeCosmeticType(value),
}));

// `type` is the MEDIA type (profile backgrounds can be video) — distinct from the CosmeticType.
export type CosmeticData = { url?: string | null; type?: MediaType | null } | null;
