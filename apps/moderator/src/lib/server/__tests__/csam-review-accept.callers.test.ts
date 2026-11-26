import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `acceptCsamReviewedImage` is the one accept that clears the CSAM review flag. Only the CSAM queue's
 * own view may reach it, behind `holdsCsamReview`: every other accept leaves that flag on.
 */

const SRC = join(__dirname, '../../..');
const NAME = 'acceptCsamReviewedImage';

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === '__tests__' ? [] : sourceFiles(path);
    return /\.(ts|svelte)$/.test(entry) && !/\.test\.ts$/.test(entry) ? [path] : [];
  });

/** Each source file that names the variant, outside its definition, with how often. */
function variantReferences(files = sourceFiles(SRC)) {
  return Object.fromEntries(
    files
      .map((path) => [
        relative(SRC, path).split(sep).join('/'),
        readFileSync(path, 'utf8').match(new RegExp(`\\b${NAME}\\b`, 'g'))?.length ?? 0,
      ])
      .filter(([path, count]) => count && path !== 'lib/server/image-moderation.service.ts')
  );
}

describe(NAME, () => {
  it('is named only by the image queue: its import and the CSAM-view accept', () => {
    expect(variantReferences()).toEqual({ 'lib/server/image-queue.ts': 2 });
  });
});
