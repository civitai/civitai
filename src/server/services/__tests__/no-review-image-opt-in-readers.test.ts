import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

/**
 * `shownReviewImageLevels` widens what a by-id read admits to service review images, so each caller is
 * a decision: the image page's read (image.get) and the report check. A collect, reaction, comment,
 * remix, download or generation data read that passed it would hand a review image to a surface the
 * review never offered.
 */
describe('who passes the review image opt-in', () => {
  function sources(dir: string): string[] {
    return readdirSync(join(process.cwd(), dir), { withFileTypes: true }).flatMap((entry) => {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sources(path);
      return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
    });
  }
  const tally = (pattern: RegExp) =>
    Object.fromEntries(
      [...sources('src/server'), ...sources('src/pages')]
        .map((path) => [
          path,
          readFileSync(join(process.cwd(), path), 'utf8').match(pattern)?.length ?? 0,
        ])
        .filter(([, n]) => n)
    );

  it('reaches imageVisibilityConditions only from getImage and assertImageReportable', () => {
    expect(tally(/imageVisibilityConditions\(\{[^}]*shownReviewImageLevels[^}]*\}\)/g)).toEqual({
      'src/server/services/image-visibility.service.ts': 1,
      'src/server/services/image.service.ts': 1,
    });
  });

  it('is set from the request only by image.get and the report check', () => {
    expect(tally(/shownReviewImageLevels: shownReviewImageLevelsFor\(/g)).toEqual({
      'src/server/controllers/image.controller.ts': 1,
      'src/server/controllers/report.controller.ts': 1,
    });
    expect(tally(/shownReviewImageLevelsFor\(/g)).toEqual({
      'src/server/controllers/image.controller.ts': 1,
      'src/server/controllers/report.controller.ts': 1,
      'src/server/utils/review-image-levels.ts': 1,
    });
  });
});
