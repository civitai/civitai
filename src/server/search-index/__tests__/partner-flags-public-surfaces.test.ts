import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Pinned textually: `transformData`, the mod reindex endpoint, `getModelsWithVersions` and
 * `getModelVersionHandler` need a Prisma payload, several caches and a live DB to run. Dropping one
 * of these lines ships the raw partner bits on a public surface with nothing failing.
 */
const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), 'utf8');

describe('raw partner bits stay off public surfaces', () => {
  it.each([
    'src/server/search-index/models.search-index.ts',
    'src/pages/api/mod/search/models-update.ts',
  ])('%s writes booleans, not flags, for the version and every entry in versions', (file) => {
    const source = read(file);
    expect(source).toMatch(/flags: versionFlags,\s*\.\.\.(restVersion|version)\b/);
    expect(source).toMatch(/\.\.\.getPartnerDisclosure\(versionFlags\)/);
    expect(source).toMatch(/usageControl,\s*flags,\s*\.\.\.x/);
    expect(source).toMatch(/\.\.\.getPartnerDisclosure\(flags\)/);
  });

  it('the public models API masks the partner bits in the flags it serves', () => {
    expect(read('src/server/services/model.service.ts')).toMatch(
      /flags: toPublicApiVersionFlags\(version\.flags\)/
    );
  });

  it('modelVersion.getById serves the raw flags to moderators only', () => {
    expect(read('src/server/controllers/model-version.controller.ts')).toMatch(
      /flags: ctx\?\.user\?\.isModerator \? version\.flags : toPublicApiVersionFlags\(version\.flags\)/
    );
  });

  it.each(['src/server/services/model.service.ts', 'src/server/controllers/model.controller.ts'])(
    '%s masks the feed version it returns from the models data cache',
    (file) => {
      expect(read(file)).toMatch(
        /version: \{ \.\.\.version, flags: toPublicApiVersionFlags\(version\.flags\) \}/
      );
    }
  );
});
