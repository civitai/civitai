import type { ContentDecorationCosmetic } from '~/server/selectors/cosmetic.selector';

type DecorationData = ContentDecorationCosmetic['data'];

/**
 * `cosmeticCache.fetch` returns one `data` object per cosmetic, shared by every
 * entity that equips it in the same pass, so a per-user override goes on a copy.
 */
export function withUserLights(data: DecorationData, userData: DecorationData): DecorationData {
  if (!userData.lights) return data;
  return { ...data, lights: userData.lights };
}
