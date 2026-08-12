/**
 * Engines behind the Remix button's image-edit and image-to-video options.
 *
 * Change an engine by editing an entry here — nothing else needs to move.
 */

import { ltxVersionIds, nanoBananaVersionIds } from '~/shared/data-graph/generation/version-ids';

export type RemixKind = 'edit' | 'video';

export type RemixEngine = {
  workflow: string;
  ecosystemKey: string;
  /**
   * Required, not decorative. Several ecosystems pick their variant from the
   * selected checkpoint version rather than from the ecosystem key: NanoBanana
   * derives its mode from `model.id` and falls back to `standard`, so an entry
   * that named only the ecosystem would quietly land on the wrong engine.
   */
  modelVersionId: number;
};

export const REMIX_ENGINES: Record<RemixKind, RemixEngine> = {
  edit: {
    workflow: 'img2img:edit',
    ecosystemKey: 'NanoBanana',
    modelVersionId: nanoBananaVersionIds.v2lite,
  },
  video: {
    workflow: 'img2vid',
    ecosystemKey: 'LTXV23',
    modelVersionId: ltxVersionIds.v23Dev,
  },
};
