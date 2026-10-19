import { readFileSync, readdirSync } from 'fs';
import { join, relative, resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { stripSourceComments } from '~/components/AppBlocks/stripSourceComments';

/**
 * T14 SEAM GUARD — who touches `app_listing_red_media`.
 *
 * The table is manual-apply, so every statement against it has to go through the probe in
 * `listing-media-split.service.ts`; and a split must change only WHICH images floor a rating,
 * never write a rating itself — every rating write stays at the go-live and re-rate sites that
 * already bust the catalog cache and record history. Pinned by equality, so the set failing to
 * GROW or SHRINK unnoticed is what this guards.
 */

const SRC = resolve(__dirname, '../../../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const isTestPath = (rel: string) =>
  rel.includes('__tests__') || /\.test\.tsx?$/.test(rel) || /(^|\/)tests\//.test(rel);

const PRODUCTION = walk(SRC)
  .map((full) => ({ rel: relative(SRC, full).replace(/\\/g, '/'), full }))
  .filter(({ rel }) => !isTestPath(rel))
  .map(({ rel, full }) => ({ rel, code: stripSourceComments(readFileSync(full, 'utf8')) }));

const SERVICE = 'server/services/blocks/listing-media-split.service.ts';

describe('app_listing_red_media — the one module that names it', () => {
  it('positive control: the walk reaches the service and reads its SQL', () => {
    expect(PRODUCTION.length).toBeGreaterThan(1000);
    expect(PRODUCTION.find((f) => f.rel === SERVICE)?.code).toMatch(/app_listing_red_media/);
  });

  it('is named by exactly one production module', () => {
    expect(
      PRODUCTION.filter((f) => /app_listing_red_media/.test(f.code)).map((f) => f.rel)
    ).toEqual([SERVICE]);
  });

  it('the chunker cuts at every top-level declaration shape', () => {
    const shapes = [
      'export async function a() {}',
      'function b() {}',
      'export function* c() {}',
      'const d = async () => {};',
      'const e: Fn = async () => {};',
      'export const f =\n  async () => {};',
      'let g = 1;',
      'var h = 1;',
      'class I {}',
      'export default function j() {}',
    ];
    expect(topLevelChunks(shapes.join('\n')).map(chunkName)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
      'g',
      'h',
      'I',
      'j',
    ]);
  });

  it('every statement in it names the table only after the probe, in the same declaration', () => {
    const code = PRODUCTION.find((f) => f.rel === SERVICE)!.code;
    const touching = topLevelChunks(code).filter((fn) => /\bapp_listing_red_media\b(?!')/.test(fn));
    expect(touching.map(chunkName).sort()).toEqual([
      'applyListingMediaSplitDecision',
      'readListingMediaSplit',
    ]);
    for (const fn of touching) {
      const probe = fn.indexOf('isListingMediaSplitTableAvailable(');
      expect(probe).toBeGreaterThan(-1);
      expect(probe).toBeLessThan(fn.search(/\bapp_listing_red_media\b(?!')/));
    }
  });

  it('writes no listing rating', () => {
    const code = PRODUCTION.find((f) => f.rel === SERVICE)!.code;
    expect(code).not.toMatch(/content_rating|contentRating|app_listings|appListing\./);
  });
});

/** Prettier-formatted source starts every top-level statement at column 0; cut before each one. */
function topLevelChunks(code: string): string[] {
  return code.split(/\n(?=[A-Za-z])/);
}

function chunkName(chunk: string): string {
  const m = chunk.match(
    /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|type)\s+(\w+)/
  );
  return m ? m[1] : chunk.slice(0, 20);
}
