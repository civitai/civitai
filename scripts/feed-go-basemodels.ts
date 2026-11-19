/**
 * The base-model facts the Go feed service's `model.getAll` port reads (apps/feed-go, DESIGN.md §14),
 * as Node's own functions answer them: which model types each base model (and ecosystem key) can
 * generate, which base models are model-locked or mature-restricted on model surfaces, and the level
 * and version-flag constants. Built by CALLING the functions over every name and model type, not by
 * reading the tables they consult, so a change to how they decide is caught too.
 *
 * Writes apps/feed-go/internal/modelfeed/basemodels.json:
 *
 *   pnpm exec tsx scripts/feed-go-basemodels.ts
 *
 * `scripts/__tests__/feed-go-basemodels.schema-drift.test.ts` fails when the committed file differs
 * from this output, so the Go side cannot drift from the constants it mirrors.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ModelType } from '@civitai/db-schema/enums';
// The modules model.getAll's own code imports them from: isGenerationEligible reads the package's,
// getModelsRaw reads isMatureRestricted through ~/shared.
import {
  baseModelRecords,
  ecosystems,
  isBaseModelGenerationSupported,
  isModelLockedBaseModel,
} from '@civitai/shared/basemodel.constants';
import { minorContentBrowsingLevelsFlag } from '@civitai/shared/minor-content-gate';
import { isMatureRestricted } from '~/shared/constants/basemodel.constants';
import { ModelVersionFlag } from '~/shared/constants/model-version-flags.constants';
import {
  allBrowsingLevelsFlag,
  nsfwBrowsingLevelsFlag,
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';

export const FEED_GO_BASEMODELS_PATH = join(
  __dirname,
  '..',
  'apps/feed-go/internal/modelfeed/basemodels.json'
);

export function buildFeedGoBaseModels() {
  const modelTypes = Object.values(ModelType).sort();
  const names = [
    ...new Set([...baseModelRecords.map((m) => m.name), ...ecosystems.map((e) => e.key)]),
  ].sort();
  const generation: Record<string, string[]> = {};
  for (const name of names) {
    const types = modelTypes.filter((type) => isBaseModelGenerationSupported(name, type));
    if (types.length) generation[name] = types;
  }
  return {
    modelTypes,
    generation,
    modelLocked: names.filter((name) => isModelLockedBaseModel(name)),
    matureRestrictedModels: [
      ...new Set(
        baseModelRecords
          .map((m) => m.name)
          .filter((name) => isMatureRestricted(name, 'models'))
          .map((name) => name.toLowerCase())
      ),
    ].sort(),
    levels: {
      minorContent: minorContentBrowsingLevelsFlag,
      sfw: sfwBrowsingLevelsFlag,
      nsfw: nsfwBrowsingLevelsFlag,
      public: publicBrowsingLevelsFlag,
      all: allBrowsingLevelsFlag,
    },
    versionFlags: {
      generationDisabled: ModelVersionFlag.GenerationDisabled,
      partnerService: ModelVersionFlag.PartnerService,
      partnerTrains: ModelVersionFlag.PartnerTrains,
    },
  };
}

export function renderFeedGoBaseModels() {
  return JSON.stringify(buildFeedGoBaseModels(), null, 2) + '\n';
}

if (process.argv[1]?.endsWith('feed-go-basemodels.ts')) {
  writeFileSync(FEED_GO_BASEMODELS_PATH, renderFeedGoBaseModels());
  console.log(`wrote ${FEED_GO_BASEMODELS_PATH}`);
}
