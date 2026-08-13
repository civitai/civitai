/**
 * Engines behind the Remix button's image-edit and image-to-video options.
 *
 * Change an engine by editing an entry here — nothing else needs to move.
 */

import {
  ltxVersionIds,
  nanoBananaVersionIds,
  qwenVersionIds,
} from '~/shared/data-graph/generation/version-ids';

export type RemixKind = 'edit' | 'video';

/**
 * Which engine an image is allowed to reach, by its rating.
 *
 * This is NOT the same thing as the base-model license restrictions in
 * `getRestrictedNsfwLevelsForBaseModel`. Those describe what a model's licence
 * permits people to distribute; this describes what a hosted provider will
 * actually run. Nano Banana's licence entry carries no mature restriction, yet
 * Google refuses the request — so the split has to be stated here rather than
 * derived from licence data.
 */
export type RemixTier = 'safe' | 'mature';

export type RemixEngine = {
  workflow: string;
  ecosystemKey: string;
  /**
   * Required, not decorative. Several ecosystems pick their variant from the
   * selected checkpoint version rather than from the ecosystem key: NanoBanana
   * derives its mode from `model.id` and falls back to `standard`, and Qwen
   * decides edit-vs-create the same way, so an entry that named only the
   * ecosystem would quietly land on the wrong engine.
   */
  modelVersionId: number;
};

export const REMIX_ENGINES: Record<RemixKind, Record<RemixTier, RemixEngine>> = {
  edit: {
    safe: {
      workflow: 'img2img:edit',
      ecosystemKey: 'NanoBanana',
      modelVersionId: nanoBananaVersionIds.v2lite,
    },
    // Qwen Image Edit runs on our own orchestrator, so it has no external
    // provider policy to refuse the request.
    mature: {
      workflow: 'img2img:edit',
      ecosystemKey: 'Qwen',
      modelVersionId: qwenVersionIds.imageEdit2511,
    },
  },
  video: {
    safe: {
      workflow: 'img2vid',
      ecosystemKey: 'LTXV23',
      modelVersionId: ltxVersionIds.v23Dev,
    },
    // Sulphur 2 is a fine-tune that runs through the same LTXV23 ecosystem (with
    // a diffusionModel AIR override), so the ecosystem key stays LTXV23 and only
    // the pinned version differs.
    mature: {
      workflow: 'img2vid',
      ecosystemKey: 'LTXV23',
      modelVersionId: ltxVersionIds.sulphur2Dev,
    },
  },
};
