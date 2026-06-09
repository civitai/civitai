/**
 * Video generation engine types.
 *
 * The legacy per-ecosystem video config layer (`VideoGenerationConfig2` factory +
 * the `videoGenerationConfig2` registry) has been removed — video generation now
 * runs entirely through the generation graph (`generateFromGraph`). The engine
 * key union is all that remained in use, so it's defined directly here.
 */

/** Video generation engine keys (formerly `keyof typeof videoGenerationConfig2`). */
export type OrchestratorEngine2 =
  | 'veo3'
  | 'vidu'
  | 'minimax'
  | 'kling'
  | 'lightricks'
  | 'ltx2'
  | 'haiper'
  | 'mochi'
  | 'hunyuan'
  | 'wan'
  | 'sora';
