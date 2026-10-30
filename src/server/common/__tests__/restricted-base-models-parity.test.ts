import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { nsfwRestrictedBaseModels } from '~/server/common/constants';
import { NsfwLevel } from '~/server/common/enums';
import { baseModelRecords, licenseById } from '~/shared/constants/basemodel.constants';
import { nsfwBrowsingLevelsArray } from '~/shared/constants/browsingLevel.constants';
import {
  NSFW_RESTRICTED_BASE_MODELS,
  NSFW_RESTRICTED_LEVELS,
} from '../../../../apps/event-engine/src/common/constants/feed.constants';
import {
  NSFW_RESTRICTED_BASE_MODELS as SUBMODULE_RESTRICTED_BASE_MODELS,
  NSFW_RESTRICTED_LEVELS as SUBMODULE_RESTRICTED_LEVELS,
} from '../../../../event-engine-common/constants/feed.constants';

// `nsfwRestrictedBaseModels` (derived from the licence flags in constants.ts) is the source. The
// shared registry and both event-engine feed copies keep their own lists, which must match it.
// The RestrictedBaseModels table's rows are guarded at runtime by the reconcile-restricted-images
// divergence gauge (a test must not read production rows); its migrations are checked here.
const MIGRATIONS = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations'
);

// Replays every migration's writes to the table, in folder order, from an empty table.
function migratedRestrictedBaseModels() {
  const rows = new Set<string>();
  let writes = 0;
  for (const dir of fs.readdirSync(MIGRATIONS).sort()) {
    const file = path.join(MIGRATIONS, dir, 'migration.sql');
    if (!fs.existsSync(file)) continue;
    const sql = fs.readFileSync(file, 'utf8').replace(/--.*$/gm, '');
    const statements = sql.matchAll(
      /(INSERT\s+INTO|DELETE\s+FROM)\s+"RestrictedBaseModels"([^;]*);/gi
    );
    for (const [, verb, body] of statements) {
      writes++;
      const names = [...body.matchAll(/'((?:[^']|'')*)'/g)].map(([, name]) =>
        name.replace(/''/g, "'")
      );
      for (const name of names) {
        if (/^INSERT/i.test(verb)) rows.add(name);
        else rows.delete(name);
      }
    }
  }
  return { rows: [...rows].sort(), writes };
}

describe('restricted base models parity', () => {
  const source = [...nsfwRestrictedBaseModels].sort();

  it('the RestrictedBaseModels migrations seed the same bases', () => {
    const { rows, writes } = migratedRestrictedBaseModels();
    // A rename or reformat that hides every statement from the parser must fail, not pass empty.
    expect(writes, `no RestrictedBaseModels writes found under ${MIGRATIONS}`).toBeGreaterThan(0);
    expect(rows).toEqual(source);
  });

  it('shared registry licences flag the same bases', () => {
    const shared = baseModelRecords
      .filter((record) => record.licenseId && licenseById.get(record.licenseId)?.disableMature)
      .map((record) => record.name)
      .sort();
    expect(shared).toEqual(source);
  });

  it('event-engine feed restricts the same bases', () => {
    expect([...NSFW_RESTRICTED_BASE_MODELS].sort()).toEqual(source);
  });

  // The image and model feeds this app serves import the submodule's copy, not the one above.
  it('event-engine-common feed restricts the same bases', () => {
    expect([...SUBMODULE_RESTRICTED_BASE_MODELS].sort()).toEqual(source);
  });

  // The feed excludes `nsfwLevel IN levels AND baseModel IN bases`, so an R image on a
  // restricted base is excluded only if R is in the levels.
  it('event-engine feed excludes an R image on a restricted base', () => {
    expect(NSFW_RESTRICTED_BASE_MODELS).toContain('SD 3.5 Large');
    expect(NSFW_RESTRICTED_LEVELS).toContain(NsfwLevel.R);
    expect([...NSFW_RESTRICTED_LEVELS]).toEqual(nsfwBrowsingLevelsArray);
  });

  it('event-engine-common feed excludes an R image on a restricted base', () => {
    expect(SUBMODULE_RESTRICTED_BASE_MODELS).toContain('SD 3.5 Large');
    expect(SUBMODULE_RESTRICTED_LEVELS).toContain(NsfwLevel.R);
    expect([...SUBMODULE_RESTRICTED_LEVELS]).toEqual(nsfwBrowsingLevelsArray);
  });
});
