/**
 * Engine Utilities
 *
 * Maps between video engine names and their ecosystem/baseModel keys.
 */

/**
 * Maps video engine names to their ecosystem/baseModel keys.
 */
export const ENGINE_TO_ECOSYSTEM: Record<string, string> = {
  vidu: 'Vidu',
  kling: 'Kling',
  hunyuan: 'HyV1',
  minimax: 'MiniMax',
  mochi: 'Mochi',
  sora: 'Sora2',
  veo3: 'Veo3',
  haiper: 'Haiper',
  lightricks: 'Ltx2',
  ltx2: 'Ltx2',
};

/**
 * Maps ecosystem/baseModel keys to video engine names.
 * Built from ENGINE_TO_ECOSYSTEM plus multi-ecosystem engines (e.g. Wan).
 */
export const ECOSYSTEM_TO_ENGINE: Record<string, string> = {
  ...Object.entries(ENGINE_TO_ECOSYSTEM).reduce<Record<string, string>>(
    (acc, [engine, ecosystem]) => ({ ...acc, [ecosystem]: engine }),
    {}
  ),
  // Wan has version/process/resolution-dependent ecosystems that all map to 'wan'
  WanVideo: 'wan',
  WanVideo1_3B_T2V: 'wan',
  WanVideo14B_T2V: 'wan',
  WanVideo14B_I2V_480p: 'wan',
  WanVideo14B_I2V_720p: 'wan',
  'WanVideo-22-TI2V-5B': 'wan',
  'WanVideo-22-I2V-A14B': 'wan',
  'WanVideo-22-T2V-A14B': 'wan',
  'WanVideo-25-T2V': 'wan',
  'WanVideo-25-I2V': 'wan',
  // Lightricks (non-LTX2) maps to 'lightricks' engine
  Lightricks: 'lightricks',
};

/**
 * Gets the video engine from an ecosystem/baseModel key.
 * Returns undefined for non-video ecosystems.
 */
export function getEngineFromEcosystem(ecosystem: string | undefined): string | undefined {
  if (!ecosystem) return undefined;
  return ECOSYSTEM_TO_ENGINE[ecosystem];
}

/**
 * Gets the ecosystem from a video engine name.
 * Returns undefined for invalid engines.
 */
export function getEcosystemFromEngine(engine: string | undefined): string | undefined {
  if (!engine) return undefined;
  return ENGINE_TO_ECOSYSTEM[engine];
}
