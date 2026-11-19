/**
 * The constants the Go content-policy service (apps/content-policy-go, DESIGN.md) decides with,
 * taken from the Node modules that hold them today rather than copied by hand:
 *
 *   - `levels`: the NsfwLevel bits (src/server/common/enums.ts) and the browsing-level flags built
 *     from them (src/shared/constants/browsingLevel.constants.ts): public (PG), sfw (PG + PG-13),
 *     all (every level but Blocked).
 *   - `ratingLadder`: OFFSITE_CONTENT_RATING_LADDER, the content ratings an app can carry.
 *   - `matureRatings`: the ratings `isMatureContentRating` (src/server/utils/server-domain.ts) calls
 *     mature, probed over the ladder plus `xxx`.
 *   - `noCountryCodes`: NO_COUNTRY (src/server/registry-adapter/request-origin.ts), the edge's codes
 *     that name no country.
 *   - `regionBlockDefault` / `regionRestrictionDefault`: DEFAULT_REGION_BLOCK_CONFIG and
 *     DEFAULT_REGION_RESTRICTION_CONFIG (src/server/utils/region-blocking.ts), the lists in force
 *     when REGION_BLOCK_CONFIG / REGION_RESTRICTION_CONFIG are unset (the Go service reads those
 *     variables first, as the site does).
 *
 * Writes apps/content-policy-go/internal/policy/policydata.json:
 *
 *   pnpm exec tsx scripts/content-policy-go-data.ts
 *
 * `scripts/__tests__/content-policy-go-data.schema-drift.test.ts` fails when the committed file
 * differs from this output, so the Go side cannot drift from the lists it mirrors.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NsfwLevel } from '~/server/common/enums';
import { NO_COUNTRY } from '~/server/registry-adapter/request-origin';
import { isMatureContentRating } from '~/server/utils/server-domain';
import {
  DEFAULT_REGION_BLOCK_CONFIG,
  DEFAULT_REGION_RESTRICTION_CONFIG,
} from '~/server/utils/region-blocking';
import {
  OFFSITE_CONTENT_RATING_LADDER,
  allBrowsingLevelsFlag,
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';

export const CONTENT_POLICY_GO_DATA_PATH = join(
  __dirname,
  '..',
  'apps/content-policy-go/internal/policy/policydata.json'
);

const regionList = (configs: readonly { region: string; effectiveDate: string }[]) =>
  configs.map(({ region, effectiveDate }) => ({ region, effectiveDate }));

export function buildContentPolicyGoData() {
  return {
    levels: {
      pg: NsfwLevel.PG,
      pg13: NsfwLevel.PG13,
      r: NsfwLevel.R,
      x: NsfwLevel.X,
      xxx: NsfwLevel.XXX,
      blocked: NsfwLevel.Blocked,
      public: publicBrowsingLevelsFlag,
      sfw: sfwBrowsingLevelsFlag,
      all: allBrowsingLevelsFlag,
    },
    ratingLadder: [...OFFSITE_CONTENT_RATING_LADDER],
    matureRatings: [...OFFSITE_CONTENT_RATING_LADDER, 'xxx'].filter((r) =>
      isMatureContentRating(r)
    ),
    noCountryCodes: [...NO_COUNTRY].sort(),
    regionBlockDefault: regionList(DEFAULT_REGION_BLOCK_CONFIG),
    regionRestrictionDefault: regionList(DEFAULT_REGION_RESTRICTION_CONFIG),
  };
}

export function renderContentPolicyGoData() {
  return JSON.stringify(buildContentPolicyGoData(), null, 2) + '\n';
}

if (process.argv[1]?.endsWith('content-policy-go-data.ts')) {
  writeFileSync(CONTENT_POLICY_GO_DATA_PATH, renderContentPolicyGoData());
  console.log(`wrote ${CONTENT_POLICY_GO_DATA_PATH}`);
}
