import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Convention guard: nothing writes `Image.meta` without stripping provenance.
 *
 * `meta.extra.sourceImageIds` is the one field in that blob a viewer is asked to
 * trust, and every write path takes client-authored meta. The protection is a
 * `sanitizeProvenance` call at each sink, which is exactly the kind of thing a
 * later edit drops silently — the unit tests around the function itself would
 * all still pass. So the wiring is pinned here instead.
 *
 * If this fails because you added a sink: call `sanitizeProvenance` in it, or add
 * it to `DERIVED_FROM_ROW` with a note saying why its meta can't carry a claim.
 */

const SRC = path.resolve(__dirname, '../../..');

/** Write sites whose meta is read back off the row rather than supplied by a caller. */
const DERIVED_FROM_ROW = [
  // image.service.ts `updateImageResources`-style rewrite: spreads the stored
  // meta and replaces `resources`, so no new claim can enter.
  'meta: { ...meta, resources: metaResources }',
];

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(full);
  }
  return files;
}

/**
 * A prisma image write that sets `meta`. Matched by text rather than by parsing:
 * the point is to notice a NEW sink, and a crude matcher that over-reports is the
 * right failure direction.
 */
const WRITE_SITE = /\bimage\.(create|createMany|update|updateMany)\s*\(/g;
const FUNCTION_START = /\n(?:export )?(?:async )?function |\n(?:export )?const \w+ = /g;
const AFTER = 1200;

/**
 * From the top of the enclosing function to a bit past the write. The sanitize
 * usually runs a few lines ABOVE the call — assigned to a local that the write
 * then uses — so a window that only looks forward reports every real sink.
 */
function scopeAround(source: string, at: number) {
  let start = 0;
  for (const boundary of source.matchAll(FUNCTION_START)) {
    if (boundary.index >= at) break;
    start = boundary.index;
  }
  return source.slice(start, at + AFTER);
}

function findUnsanitizedWrites() {
  const offenders: string[] = [];

  for (const file of walk(path.join(SRC, 'server'))) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(WRITE_SITE)) {
      const window = scopeAround(source, match.index);
      if (!/\bmeta:/.test(source.slice(match.index, match.index + AFTER))) continue;
      if (/sanitizeProvenance/.test(window)) continue;
      if (DERIVED_FROM_ROW.some((allowed) => window.includes(allowed))) continue;

      const line = source.slice(0, match.index).split('\n').length;
      offenders.push(`${path.relative(SRC, file).replace(/\\/g, '/')}:${line}`);
    }
  }

  return offenders;
}

describe('Image.meta writes cannot carry an unverified provenance claim', () => {
  it('every write site that sets meta strips the claim first', () => {
    expect(findUnsanitizedWrites()).toEqual([]);
  });

  it('the scan can actually see a sink (positive control)', () => {
    // Without this, a broken walk or a renamed prisma call would make the guard
    // above pass by finding nothing at all.
    const createImage = fs.readFileSync(path.join(SRC, 'server/services/image.service.ts'), 'utf8');
    expect(createImage).toMatch(/image\.create\s*\(/);
    expect(createImage).toMatch(/sanitizeProvenance/);
  });
});
