/**
 * Engines behind the Remix button's image-edit and image-to-video options.
 *
 * Change an engine by editing an entry here — nothing else needs to move.
 */

import {
  minimaxVersionIds,
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
  /**
   * `MiniMaxH3` spans two engines — our own weights (`comfy`) and MiniMax's
   * hosted API — and the variant resolver falls back to the API on any version
   * id it does not recognise. So the mature tier's safety rests on the pinned
   * VERSION, not on the ecosystem key; `h3-ids-agree` pins it.
   *
   * Mature routes here with a known cost rather than an absent one: our own
   * moderation can block an output after the job succeeds, and the Buzz is not
   * refunded. That was weighed and accepted, not designed away.
   *
   * The tiers stay separately addressable though they are equal today, so a
   * mature-only reroute does not have to reintroduce the structure.
   */
  video: {
    safe: {
      workflow: 'img2vid',
      ecosystemKey: 'MiniMaxH3',
      modelVersionId: minimaxVersionIds.comfy,
    },
    mature: {
      workflow: 'img2vid',
      ecosystemKey: 'MiniMaxH3',
      modelVersionId: minimaxVersionIds.comfy,
    },
  },
};
