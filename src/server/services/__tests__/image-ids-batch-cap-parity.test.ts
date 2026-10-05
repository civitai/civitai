import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

import { IMAGE_IDS_BATCH_MAX } from '~/server/common/constants';
import { BLOCK_GATED_IMAGES_MAX_IDS } from '~/server/services/blocks/block-gated-images.service';

/**
 * The REST `?ids=` cap is INHERITED from the bridge message it replaces, not
 * invented. `GET_IMAGES_BY_IDS` (`blocks.getImagesByIds`) has always accepted at
 * most 100 ids, so an app porting off the bridge meets the limit it already
 * codes against.
 *
 * Three copies of that 100 exist and this file is what keeps them one number:
 * the REST constant, the bridge service's `BLOCK_GATED_IMAGES_MAX_IDS`, and the
 * tRPC procedure's own inline `.max(...)` — which is the authoritative one,
 * because it is what actually rejects an oversized bridge payload. The third is
 * read out of the source: it is a zod literal inside a router 6,000 lines long
 * whose import graph is most of the server, and a drift guard that cannot run is
 * worse than no guard.
 */

const ROUTER = join(process.cwd(), 'src/server/routers/blocks.router.ts');

/**
 * The `imageIds` array bound on the `blocks.getImagesByIds` input schema.
 *
 * 🔴 SCOPED TO THE PROCEDURE, and the narrow version is not a nicety. The first
 * draft matched `imageIds:\s*z.*\.max\((\d+)\)` over the whole file and read
 * back **50** — `blockPostInput.sources` declares a same-named field with a
 * different bound 4,700 lines earlier. It failed loudly only because 50 ≠ 100;
 * had the two caps ever agreed, this guard would have been asserting the wrong
 * literal and passing.
 */
function bridgeProcedureCap(source: string): number | null {
  const start = source.indexOf('\n  getImagesByIds: ');
  if (start < 0) return null;
  // The procedure's input schema ends at its resolver.
  const end = source.indexOf('.mutation(', start);
  if (end < 0) return null;
  const m = source.slice(start, end).match(/imageIds:\s*z[^\n]*?\.max\((\d+)\)/);
  return m ? Number(m[1]) : null;
}

describe('batch-by-id cap parity: REST inherits the bridge ceiling', () => {
  const source = readFileSync(ROUTER, 'utf8');

  it('finds the bridge procedure cap it is supposed to be comparing against', () => {
    // Positive control — without it, a rename or a reformat turns this whole
    // file into a comparison against `null` that nothing reads.
    expect(bridgeProcedureCap(source)).not.toBeNull();
    // Negative control: no procedure ⇒ no answer, rather than a stray match.
    expect(bridgeProcedureCap('imageIds: z.number().array().min(1).max(7),')).toBeNull();
  });

  it('reads the cap off getImagesByIds and not off a same-named field elsewhere', () => {
    // `blockPostInput.sources` carries its own `imageIds: ....max(50)`. Pinned as
    // a case, not a comment, because it is what the first draft actually matched.
    expect(source).toMatch(
      /imageIds: z\.number\(\)\.int\(\)\.positive\(\)\.array\(\)\.min\(1\)\.max\(50\)/
    );
    expect(bridgeProcedureCap(source)).not.toBe(50);
  });

  it('REST `?ids=` accepts exactly what GET_IMAGES_BY_IDS accepted', () => {
    expect(IMAGE_IDS_BATCH_MAX).toBe(bridgeProcedureCap(source));
  });

  it('the bridge service constant states the same bound', () => {
    expect(BLOCK_GATED_IMAGES_MAX_IDS).toBe(IMAGE_IDS_BATCH_MAX);
  });
});
