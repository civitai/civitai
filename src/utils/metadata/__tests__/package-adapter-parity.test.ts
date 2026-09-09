import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { imageMetaSchema } from '~/server/schema/image.schema';
import { ExifParser } from '~/utils/metadata';

/**
 * Integration parity: the @civitai/media-metadata adapter vs the package's own
 * blessed expected-output files, over its real-image corpus. The adapter's
 * getMetadata() must equal imageMetaSchema applied to the blessed raw bag —
 * that schema pass (which also strips `extra` to the app's shape) is the one
 * behavior this repo adds on top of the package.
 *
 * Runs only where the sibling media-metadata checkout exists; the corpus is the
 * package's test asset, not this repo's.
 */

const CORPUS = 'C:/work/media-metadata/fixtures/images';
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

type Expected = { generator: string | null; madeOnSite: boolean; meta: Record<string, unknown> };

function collectImages(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectImages(full));
    else if (IMAGE_EXT.test(entry.name)) out.push(full);
  }
  return out;
}

const available = existsSync(CORPUS);
const images = available ? collectImages(CORPUS) : [];

describe.skipIf(!available)('package adapter parity over the media-metadata corpus', () => {
  it('found the corpus', () => {
    expect(images.length).toBeGreaterThanOrEqual(50);
  });

  describe.each(images.map((f) => [relative(CORPUS, f).replace(/\\/g, '/'), f] as const))(
    '%s',
    (_label, file) => {
      it('adapter getMetadata/isMadeOnSite match the blessed expected output', async () => {
        const expected: Expected = JSON.parse(
          readFileSync(file.replace(IMAGE_EXT, '.expected.json'), 'utf8')
        );
        const schemaResult = imageMetaSchema.safeParse(expected.meta ?? {});
        const expectedMeta = schemaResult.success ? schemaResult.data : {};

        const bytes = new Uint8Array(readFileSync(file));
        const adapter = await ExifParser(new File([bytes as BlobPart], 'fixture'));
        const adapterMeta = await adapter.getMetadata();

        expect(adapterMeta).toEqual(expectedMeta);
        expect(adapter.isMadeOnSite()).toBe(expected.madeOnSite);
      });
    }
  );
});
