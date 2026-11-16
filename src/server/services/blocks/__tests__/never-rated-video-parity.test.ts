import { describe, expect, it } from 'vitest';
import { ecosystems } from '~/shared/constants/basemodel.constants';
import { isNeverRatedVideoStep } from '~/shared/orchestrator/workflow-data';
import { isBlockNeverRatedVideoStep } from '~/server/services/blocks/workflow.service';

/**
 * DRIFT / INVARIANT GUARD, not regression coverage: no bug is pinned here.
 *
 * The never-rated video engines are listed twice. The site keys them by ECOSYSTEM
 * (`NEVER_RATED_VIDEO_ECOSYSTEMS` in `shared/orchestrator/workflow-data.ts`, read through
 * `isNeverRatedVideoStep`); App Blocks keys them by the `videoGen` ENGINE the block sent
 * (`NEVER_RATED_VIDEO_ENGINES` in `services/blocks/workflow.service.ts`, read through
 * `isBlockNeverRatedVideoStep`). Neither list is derived from the other, so adding an
 * engine on one side alone makes the site and App Blocks disagree about whether its
 * unrated videos are delivered or held.
 *
 * This map is the hand-written link between the two. Both lists stay private, so the
 * test reads them only through the exported predicates.
 *
 * GAP: the site's set is not exported, so it is probed over every key in `ecosystems`.
 * A never-rated name added to the site that is NOT an `ecosystems` key is not caught.
 */
const NEVER_RATED_ECOSYSTEM_TO_ENGINE: Readonly<Record<string, string>> = {
  GeminiOmni: 'gemini-omni',
  Grok: 'grok',
  Kling: 'kling',
  Veo3: 'veo3',
  Vidu: 'vidu',
};

type SiteWorkflowParams = Parameters<typeof isNeverRatedVideoStep>[1];

function siteSaysNeverRated(ecosystem: string): boolean {
  return isNeverRatedVideoStep({ $type: 'videoGen' }, { ecosystem } as SiteWorkflowParams);
}

describe('never-rated video engines: the site ecosystems and the App Blocks engines agree', () => {
  it('the map names exactly the ecosystems the site treats as never-rated', () => {
    const siteNeverRated = ecosystems
      .map((e) => e.key)
      .filter(siteSaysNeverRated)
      .sort();
    expect(siteNeverRated).toEqual(Object.keys(NEVER_RATED_ECOSYSTEM_TO_ENGINE).sort());
  });

  it.each(Object.entries(NEVER_RATED_ECOSYSTEM_TO_ENGINE))(
    "a videoGen step on the %s ecosystem's engine (%s) is never-rated for App Blocks",
    (_ecosystem, engine) => {
      // `metadata: {}` carries no ecosystem, so only the engine check can answer true.
      expect(
        isBlockNeverRatedVideoStep({ $type: 'videoGen', input: { engine } }, { metadata: {} })
      ).toBe(true);
    }
  );

  it('control: a rated engine is not never-rated, so the check above can fail', () => {
    expect(
      isBlockNeverRatedVideoStep({ $type: 'videoGen', input: { engine: 'wan' } }, { metadata: {} })
    ).toBe(false);
  });
});
